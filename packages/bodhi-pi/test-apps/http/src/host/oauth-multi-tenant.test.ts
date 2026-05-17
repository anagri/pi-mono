import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
	decodeTenantFromState,
	KvOAuthProvider,
	MCP_PREFIX,
	OAuthStateKv,
	parseMcpServerEntry,
	runAuthFlow,
	serializeMcpServerEntry,
	type McpAuthOAuthConfig,
	type McpServerEntry,
} from "@bodhiapp/bodhi-pi";
import { createNodeKvStore } from "@bodhiapp/bodhi-pi-test-app-node-adapters";
import { spawnOAuthMcpServer } from "../../../../e2e/helpers/oauth-mcp-server.js";
import { handleOauthCallback } from "./oauth-callback.js";

// HTTP host OAuth multi-tenant routing. State token prefixes encode the tenant id so
// /oauth/callback can open the right user's kvDir without holding any session state.
// User B's storage stays untouched by user A's OAuth flow.

let dataDir: string;

beforeEach(async () => {
	dataDir = await mkdtemp(path.join(tmpdir(), "bodhi-pi-http-oauth-mt-"));
});
afterEach(async () => {
	await rm(dataDir, { recursive: true, force: true });
});

function buildPersistedEntry(cfg: McpAuthOAuthConfig, url: string): McpServerEntry {
	return {
		transport: "http",
		url,
		auth: cfg,
		label: "oauthfix",
		addedAt: "2026-05-17T00:00:00.000Z",
		lastKnownStatus: "disconnected",
	};
}

test("oauth-preregistered: /oauth/callback routes to the tenant in state; bob never sees alice's entry", async () => {
	const fixturePort = 33810;
	const fixture = await spawnOAuthMcpServer({ port: fixturePort });
	try {
		const aliceKvDir = path.join(dataDir, "kv", "alice");
		const bobKvDir = path.join(dataDir, "kv", "bob");
		const aliceKv = createNodeKvStore({ dir: aliceKvDir });
		const bobKv = createNodeKvStore({ dir: bobKvDir });

		// Alice's persisted entry + state. We construct these directly (the real flow uses
		// McpService.handleOauthStart with tenantId="alice" — covered by the cli e2e). Here we
		// focus on the routing/isolation surface specifically.
		const aliceCfg: McpAuthOAuthConfig = {
			mode: "oauth",
			authorizeUrl: fixture.authorizeUrl,
			tokenUrl: fixture.tokenUrl,
			clientId: fixture.clientId,
			clientSecret: { name: "clientSecret", value: fixture.clientSecret, secret: true },
			redirectUri: `http://localhost:9999/oauth/callback`,
		};
		const aliceEntry = buildPersistedEntry(aliceCfg, fixture.mcpUrl);
		await aliceKv.set(`${MCP_PREFIX}localhost`, serializeMcpServerEntry(aliceEntry));

		// Run a real PKCE flow against the fixture to obtain a (code, state) pair as if the user
		// had completed the redirect. The state token uses the multi-tenant `<base64url(userId)>.<random>`
		// format that McpService.handleOauthStart would generate.
		const state = `${Buffer.from("alice").toString("base64url")}.test-random-32bytes-base64url-padding`;
		const stateKv = new OAuthStateKv(aliceKv);
		const provider = new KvOAuthProvider({
			kvStore: aliceKv,
			slug: "localhost",
			cfg: aliceCfg,
			redirectUri: aliceCfg.redirectUri!,
			stateKv,
			state,
		});
		const startResult = await runAuthFlow(provider, fixture.tokenUrl);
		expect(startResult.authorized).toBe(false);
		expect(startResult.authorizeUrl).toBeDefined();
		const u = new URL(startResult.authorizeUrl!);
		u.searchParams.set("auto", "1");
		const redirectResp = await fetch(u.toString(), { redirect: "manual" });
		expect(redirectResp.status).toBe(302);
		const cb = new URL(redirectResp.headers.get("location")!);
		const code = cb.searchParams.get("code")!;
		const returnedState = cb.searchParams.get("state")!;
		expect(returnedState).toBe(state);
		expect(decodeTenantFromState(returnedState)).toBe("alice");

		// Drive the HTTP callback route. It looks up Alice's kv via the tenant prefix and completes
		// the token exchange — without anything bob-related in scope.
		const cbResp = await driveCallback(`/oauth/callback?code=${code}&state=${state}`, { dataDir });
		expect(cbResp.status).toBe(200);
		expect(cbResp.body).toContain("OAuth complete");

		// Alice's kv now has tokens.
		const aliceAfter = parseMcpServerEntry((await aliceKv.get(`${MCP_PREFIX}localhost`)) ?? null);
		expect(aliceAfter).toBeTruthy();
		expect(aliceAfter!.auth.mode).toBe("oauth");
		const aliceTokens = (aliceAfter!.auth as McpAuthOAuthConfig).tokens;
		expect(aliceTokens?.access.value.length ?? 0).toBeGreaterThan(0);

		// Bob's kv has nothing — neither the entry nor any OAuth state.
		expect(await bobKv.get(`${MCP_PREFIX}localhost`)).toBeUndefined();
		expect(await bobKv.list(MCP_PREFIX)).toEqual([]);
		expect(await bobKv.list("mcp/oauth-state/")).toEqual([]);
	} finally {
		await fixture.close();
	}
});

test("/oauth/callback rejects state with no tenant prefix", async () => {
	const resp = await driveCallback(`/oauth/callback?code=x&state=nodotbar`, { dataDir });
	expect(resp.status).toBe(400);
	expect(resp.body).toContain("invalid state");
});

test("/oauth/callback rejects state for unknown tenant (expired-state path)", async () => {
	const fakeState = `${Buffer.from("ghost").toString("base64url")}.deadbeef`;
	const resp = await driveCallback(`/oauth/callback?code=x&state=${fakeState}`, { dataDir });
	expect(resp.status).toBe(400);
	expect(resp.body).toContain("invalid or expired state");
});

test("/oauth/callback rejects missing code or state", async () => {
	const r1 = await driveCallback(`/oauth/callback?state=foo`, { dataDir });
	expect(r1.status).toBe(400);
	expect(r1.body).toContain("missing code");
	const r2 = await driveCallback(`/oauth/callback?code=foo`, { dataDir });
	expect(r2.status).toBe(400);
	expect(r2.body).toContain("missing code");
});

interface FakeCallbackResult {
	status: number;
	body: string;
}

/**
 * Wraps `handleOauthCallback` in a one-shot in-process server. Mirrors the route registration in
 * `server.ts` (`GET /oauth/callback*`); avoids spinning the full agent stack for routing tests.
 */
async function driveCallback(reqPath: string, opts: { dataDir: string }): Promise<FakeCallbackResult> {
	return new Promise((resolve, reject) => {
		const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
			try {
				await handleOauthCallback(req, res, opts);
			} catch (err) {
				reject(err);
			}
		});
		server.listen(0, "127.0.0.1", async () => {
			const addr = server.address();
			if (typeof addr !== "object" || !addr) {
				reject(new Error("no addr"));
				return;
			}
			try {
				const resp = await fetch(`http://localhost:${addr.port}${reqPath}`);
				const body = await resp.text();
				server.close(() => resolve({ status: resp.status, body }));
			} catch (err) {
				server.close(() => reject(err));
			}
		});
	});
}
