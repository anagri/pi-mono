import { describe, expect, it } from "vitest";
import { createInMemoryKvStore } from "../kv/in-memory-kv-store.js";
import { KvOAuthProvider } from "./mcp-oauth-host-api.js";
import { MCP_PREFIX, type McpServerEntry, serializeMcpServerEntry } from "./mcp-types.js";

function seedEntry(): McpServerEntry {
	return {
		transport: "http",
		url: "https://mcp.example.com/mcp",
		auth: { mode: "oauth-dcr" },
		label: "example",
		addedAt: "2026-05-15T00:00:00.000Z",
		lastKnownStatus: "disconnected",
	};
}

describe("KvOAuthProvider — persistence round-trip", () => {
	it("starts with no client information or tokens", async () => {
		const kv = createInMemoryKvStore();
		await kv.set(`${MCP_PREFIX}example`, serializeMcpServerEntry(seedEntry()));
		const provider = new KvOAuthProvider({
			kvStore: kv,
			slug: "example",
			redirectUrl: "http://127.0.0.1:9999/callback",
		});
		expect(await provider.clientInformation()).toBeUndefined();
		expect(await provider.tokens()).toBeUndefined();
	});

	it("persists DCR client information through saveClientInformation/clientInformation", async () => {
		const kv = createInMemoryKvStore();
		await kv.set(`${MCP_PREFIX}example`, serializeMcpServerEntry(seedEntry()));
		const provider = new KvOAuthProvider({
			kvStore: kv,
			slug: "example",
			redirectUrl: "http://127.0.0.1:9999/callback",
		});
		await provider.saveClientInformation({ client_id: "cid", client_secret: "csec" });
		const info = await provider.clientInformation();
		expect(info).toEqual({ client_id: "cid", client_secret: "csec" });
	});

	it("persists tokens through saveTokens/tokens with expiry round-trip", async () => {
		const kv = createInMemoryKvStore();
		await kv.set(`${MCP_PREFIX}example`, serializeMcpServerEntry(seedEntry()));
		const provider = new KvOAuthProvider({
			kvStore: kv,
			slug: "example",
			redirectUrl: "http://127.0.0.1:9999/callback",
		});
		await provider.saveTokens({
			access_token: "at",
			token_type: "Bearer",
			refresh_token: "rt",
			expires_in: 3600,
		});
		const t = await provider.tokens();
		expect(t?.access_token).toBe("at");
		expect(t?.refresh_token).toBe("rt");
		expect(t?.token_type).toBe("Bearer");
		// expires_in is recomputed at read time; allow a small tolerance.
		expect((t?.expires_in ?? 0) > 3590 && (t?.expires_in ?? 0) <= 3600).toBe(true);
	});

	it("captures the authorize URL via redirectToAuthorization without redirecting", async () => {
		const kv = createInMemoryKvStore();
		await kv.set(`${MCP_PREFIX}example`, serializeMcpServerEntry(seedEntry()));
		const provider = new KvOAuthProvider({
			kvStore: kv,
			slug: "example",
			redirectUrl: "http://127.0.0.1:9999/callback",
		});
		await provider.redirectToAuthorization(new URL("https://as.example.com/authorize?x=1"));
		expect(provider.getPendingAuthorizeUrl()?.toString()).toBe("https://as.example.com/authorize?x=1");
	});

	it("invalidateCredentials('all') clears tokens AND client info from kv", async () => {
		const kv = createInMemoryKvStore();
		await kv.set(`${MCP_PREFIX}example`, serializeMcpServerEntry(seedEntry()));
		const provider = new KvOAuthProvider({
			kvStore: kv,
			slug: "example",
			redirectUrl: "http://127.0.0.1:9999/callback",
		});
		await provider.saveClientInformation({ client_id: "cid" });
		await provider.saveTokens({ access_token: "at", token_type: "Bearer" });
		await provider.invalidateCredentials("all");
		expect(await provider.clientInformation()).toBeUndefined();
		expect(await provider.tokens()).toBeUndefined();
	});

	it("clientMetadata advertises the configured redirect_uri and PKCE-friendly grant types", async () => {
		const provider = new KvOAuthProvider({
			kvStore: createInMemoryKvStore(),
			slug: "example",
			redirectUrl: "http://127.0.0.1:9999/callback",
		});
		const md = provider.clientMetadata;
		expect(md.redirect_uris).toEqual(["http://127.0.0.1:9999/callback"]);
		expect(md.grant_types).toContain("authorization_code");
		expect(md.grant_types).toContain("refresh_token");
		expect(md.response_types).toContain("code");
	});
});
