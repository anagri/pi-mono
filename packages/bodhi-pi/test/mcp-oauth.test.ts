import {
	type Api,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	type Model,
	registerFauxProvider,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createBodhiPiClient } from "@/client/client.js";
import type { BodhiPiAcpConnection } from "@/client/types.js";
import { EXT_MCP_ADD } from "@/wire/constants.js";
import { spawnOAuthMcpServer } from "../e2e/helpers/oauth-mcp-server.js";
import { stdInitParams } from "./helpers/acp-constants.js";
import { createTestHarness, type TestHarness } from "./helpers/harness.js";

let providers: FauxProviderRegistration[] = [];

beforeEach(() => {
	providers = [];
});
afterEach(() => {
	for (const p of providers) p.unregister();
	providers = [];
});

function newFaux(): Model<Api> {
	const faux = registerFauxProvider();
	providers.push(faux);
	faux.setResponses([() => fauxAssistantMessage("ok")]);
	return faux.getModel() as Model<Api>;
}

function bindClient(harness: TestHarness) {
	return createBodhiPiClient(harness.clientConn as unknown as BodhiPiAcpConnection);
}

async function setupClient() {
	const model = newFaux();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });
	const client = bindClient(harness);
	await client.initialize(stdInitParams);
	await client.newSession({ cwd: "/proj" });
	return { harness, client };
}

test("/mcp add oauth-preregistered persists clientId + clientSecret (masked on ACP reads)", async () => {
	const { harness, client } = await setupClient();

	await client.mcpAdd({
		url: "https://mcp.example.com/mcp",
		auth: "oauth-preregistered",
		authorizeUrl: "https://auth.example.com/authorize",
		tokenUrl: "https://auth.example.com/token",
		clientId: "cid-abc",
		clientSecret: "sek-shh",
		scopes: ["repo", "read"],
		redirectUri: "http://localhost:7777/callback",
	});

	const stored = await harness.kvStore.get("mcp/example");
	expect(stored).toMatchObject({
		auth: {
			mode: "oauth-preregistered",
			authorizeUrl: "https://auth.example.com/authorize",
			tokenUrl: "https://auth.example.com/token",
			clientId: "cid-abc",
			clientSecret: { name: "clientSecret", value: "sek-shh", secret: true },
			scopes: ["repo", "read"],
			redirectUri: "http://localhost:7777/callback",
		},
	});

	const viaKv = await client.kv.get({ key: "mcp/example" });
	const viaKvAuth = (viaKv.value as { auth: { clientSecret: { name: string; value: string; secret: true } } }).auth;
	expect(viaKvAuth.clientSecret).toEqual({ name: "clientSecret", value: "***", secret: true });

	const entries = await client.mcpList();
	const listAuth = entries[0]?.auth as {
		mode: string;
		clientSecret: { name: string; value: string; secret: true };
	};
	expect(listAuth.mode).toBe("oauth-preregistered");
	expect(listAuth.clientSecret).toEqual({ name: "clientSecret", value: "***", secret: true });
});

test("/mcp add oauth-preregistered rejects when required fields missing", async () => {
	const { client } = await setupClient();

	await expect(
		client.ext(EXT_MCP_ADD, {
			url: "https://mcp.example.com/mcp",
			auth: "oauth-preregistered",
			tokenUrl: "https://auth.example.com/token",
			clientId: "cid",
		}),
	).rejects.toThrow(/authorizeUrl must be a non-empty string/);

	await expect(
		client.ext(EXT_MCP_ADD, {
			url: "https://mcp.example.com/mcp",
			auth: "oauth-preregistered",
			authorizeUrl: "https://auth.example.com/authorize",
			clientId: "cid",
		}),
	).rejects.toThrow(/tokenUrl must be a non-empty string/);

	await expect(
		client.ext(EXT_MCP_ADD, {
			url: "https://mcp.example.com/mcp",
			auth: "oauth-preregistered",
			authorizeUrl: "https://auth.example.com/authorize",
			tokenUrl: "https://auth.example.com/token",
		}),
	).rejects.toThrow(/clientId must be a non-empty string/);
});

test("/mcp add oauth-preregistered rejects http URLs (except localhost)", async () => {
	const { client } = await setupClient();
	await expect(
		client.mcpAdd({
			url: "https://mcp.example.com/mcp",
			auth: "oauth-preregistered",
			authorizeUrl: "http://evil.com/authorize",
			tokenUrl: "https://auth.example.com/token",
			clientId: "cid",
		}),
	).rejects.toThrow(/authorizeUrl must use https/);
});

test("/mcp add oauth-preregistered rejects sibling headers/queries", async () => {
	const { client } = await setupClient();
	await expect(
		client.ext(EXT_MCP_ADD, {
			url: "https://mcp.example.com/mcp",
			auth: "oauth-preregistered",
			authorizeUrl: "https://auth.example.com/authorize",
			tokenUrl: "https://auth.example.com/token",
			clientId: "cid",
			headers: { X: "y" },
		}),
	).rejects.toThrow(/oauth-preregistered.*rejects sibling headers/);
});

test("/mcp add oauth-preregistered rejects stdio transport", async () => {
	const { client } = await setupClient();
	await expect(
		client.ext(EXT_MCP_ADD, {
			command: "npx",
			args: ["bogus"],
			auth: "oauth-preregistered",
			authorizeUrl: "https://auth.example.com/authorize",
			tokenUrl: "https://auth.example.com/token",
			clientId: "cid",
		}),
	).rejects.toThrow(/stdio entries do not accept auth/);
});

test("/mcp add oauth-preregistered rejects tokens field at add time", async () => {
	const { client } = await setupClient();
	await expect(
		client.ext(EXT_MCP_ADD, {
			url: "https://mcp.example.com/mcp",
			auth: "oauth-preregistered",
			authorizeUrl: "https://auth.example.com/authorize",
			tokenUrl: "https://auth.example.com/token",
			clientId: "cid",
			tokens: { access: { name: "a", value: "v", secret: true } },
		}),
	).rejects.toThrow(/tokens field is owned by the oauth handler/);
});

test("oauth/start returns authorizeUrl + state for a freshly added entry", async () => {
	const { client } = await setupClient();
	await client.mcpAdd({
		url: "https://mcp.example.com/mcp",
		auth: "oauth-preregistered",
		authorizeUrl: "https://auth.example.com/authorize",
		tokenUrl: "https://auth.example.com/token",
		clientId: "cid",
		redirectUri: "http://localhost:7777/callback",
	});

	const result = await client.mcpOauthStart({ slug: "example" });
	expect(result.status).toBeUndefined();
	expect(result.authorizeUrl).toMatch(/^https:\/\/auth\.example\.com\/authorize\?/);
	expect(result.authorizeUrl).toContain("response_type=code");
	expect(result.authorizeUrl).toContain("client_id=cid");
	expect(result.authorizeUrl).toContain("code_challenge_method=S256");
	expect(result.authorizeUrl).toContain(`state=${result.state}`);
});

test("oauth/start errors when slug not configured for oauth-preregistered", async () => {
	const { client } = await setupClient();
	await client.mcpAdd({
		url: "https://mcp.example.com/mcp",
		auth: "public",
	});
	await expect(client.mcpOauthStart({ slug: "example" })).rejects.toThrow(/not configured for oauth-preregistered/);
});

test("oauth/start errors when no redirect URI configured anywhere", async () => {
	const { client } = await setupClient();
	await client.mcpAdd({
		url: "https://mcp.example.com/mcp",
		auth: "oauth-preregistered",
		authorizeUrl: "https://auth.example.com/authorize",
		tokenUrl: "https://auth.example.com/token",
		clientId: "cid",
	});
	await expect(client.mcpOauthStart({ slug: "example" })).rejects.toThrow(/redirect_uri required/);
});

test("oauth/finish errors on invalid/expired state", async () => {
	const { client } = await setupClient();
	await client.mcpAdd({
		url: "https://mcp.example.com/mcp",
		auth: "oauth-preregistered",
		authorizeUrl: "https://auth.example.com/authorize",
		tokenUrl: "https://auth.example.com/token",
		clientId: "cid",
		redirectUri: "http://localhost:7777/callback",
	});
	await expect(client.mcpOauthFinish({ slug: "example", code: "abc", state: "nope" })).rejects.toThrow(
		/invalid or expired state/,
	);
});

test("oauth/cancel deletes state; later finish errors", async () => {
	const { client } = await setupClient();
	await client.mcpAdd({
		url: "https://mcp.example.com/mcp",
		auth: "oauth-preregistered",
		authorizeUrl: "https://auth.example.com/authorize",
		tokenUrl: "https://auth.example.com/token",
		clientId: "cid",
		redirectUri: "http://localhost:7777/callback",
	});
	const start = await client.mcpOauthStart({ slug: "example" });
	expect(start.state).toBeDefined();
	const cancelResult = await client.mcpOauthCancel({ slug: "example", state: start.state! });
	expect(cancelResult.ok).toBe(true);
	await expect(client.mcpOauthFinish({ slug: "example", code: "anything", state: start.state! })).rejects.toThrow(
		/invalid or expired state/,
	);
});

test("full OAuth round-trip against fixture server: tokens persist masked, /mcp connect attaches Bearer", async () => {
	const port = 33500;
	const fixture = await spawnOAuthMcpServer({ port });
	try {
		const { harness, client } = await setupClient();

		// Add the oauth-preregistered entry pointed at the fixture's mcp endpoint.
		await client.mcpAdd({
			url: fixture.mcpUrl,
			auth: "oauth-preregistered",
			authorizeUrl: fixture.authorizeUrl,
			tokenUrl: fixture.tokenUrl,
			clientId: fixture.clientId,
			clientSecret: fixture.clientSecret,
			redirectUri: "http://localhost:7777/callback",
			label: "oauthfix",
		});

		const slug = "localhost";

		// Kick off the OAuth flow. Returns the authorize URL + state — fixture's `?auto=1` query
		// makes it skip the approve page and redirect straight to the callback.
		const start = await client.mcpOauthStart({ slug });
		expect(start.authorizeUrl).toBeDefined();

		const url = new URL(start.authorizeUrl!);
		url.searchParams.set("auto", "1");
		const resp = await fetch(url.toString(), { redirect: "manual" });
		expect(resp.status).toBe(302);
		const location = resp.headers.get("location");
		expect(location).toBeDefined();
		const callback = new URL(location!);
		const code = callback.searchParams.get("code");
		const returnedState = callback.searchParams.get("state");
		expect(code).toBeTruthy();
		expect(returnedState).toBe(start.state);

		// Complete the flow.
		const finish = await client.mcpOauthFinish({ slug, code: code!, state: returnedState! });
		expect(finish.status).toBe("completed");

		// Tokens persisted under auth.tokens, masked on ACP reads.
		const stored = (await harness.kvStore.get(`mcp/${slug}`)) as {
			auth: { tokens: { access: { value: string }; refresh?: { value: string } } };
		};
		expect(stored.auth.tokens.access.value).not.toBe("***");
		const viaKv = await client.kv.get({ key: `mcp/${slug}` });
		const viaKvAuth = (
			viaKv.value as { auth: { tokens: { access: { value: string }; refresh?: { value: string } } } }
		).auth;
		expect(viaKvAuth.tokens.access.value).toBe("***");
		if (viaKvAuth.tokens.refresh) expect(viaKvAuth.tokens.refresh.value).toBe("***");

		// Connect — the oauth-preregistered attacher reads tokens from kv per request and sends
		// `Authorization: Bearer <access>`. The fixture's `whoami` tool returns "authenticated via bearer".
		const connect = await client.mcpConnect({ slug });
		expect(connect.tools).toContain(`${slug}__whoami`);
		expect(fixture.uniqueBearerCount()).toBeGreaterThan(0);

		await client.mcpDisconnect({ slug });
	} finally {
		await fixture.close();
	}
}, 30_000);
