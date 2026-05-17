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

test("oauth/discover returns RFC 9728 + 8414 metadata for a fixture MCP server", async () => {
	const port = 33830;
	const fixture = await spawnOAuthMcpServer({ port });
	try {
		const { client } = await setupClient();
		const result = await client.mcpOauthDiscover({ url: fixture.mcpUrl });
		expect(result.authorizationServerUrl).toBe(fixture.url);
		expect(result.authorizeUrl).toBe(fixture.authorizeUrl);
		expect(result.tokenUrl).toBe(fixture.tokenUrl);
		expect(result.registrationEndpoint).toBe(fixture.registrationEndpoint);
		expect(result.scopesSupported).toEqual(["read", "write"]);
		expect(result.resource).toBe(fixture.mcpUrl);
	} finally {
		await fixture.close();
	}
});

test("oauth/register registers a fresh client via RFC 7591", async () => {
	const port = 33831;
	const fixture = await spawnOAuthMcpServer({ port });
	try {
		const { client } = await setupClient();
		const before = fixture.registeredClientCount();
		const result = await client.mcpOauthRegister({
			registrationEndpoint: fixture.registrationEndpoint,
			redirectUri: "http://localhost:7777/callback",
			scopes: ["read"],
			clientName: "bodhi-pi-test",
		});
		expect(result.clientId).toMatch(/^dcr-/);
		expect(result.clientSecret).toBeDefined();
		expect(result.clientSecret!.length).toBeGreaterThan(10);
		expect(result.tokenEndpointAuthMethod).toBe("client_secret_basic");
		expect(fixture.registeredClientCount()).toBe(before + 1);
	} finally {
		await fixture.close();
	}
});

test("/mcp add with auth: oauth-dcr chains discovery + DCR + persists; tokens flow end-to-end", async () => {
	const port = 33832;
	const fixture = await spawnOAuthMcpServer({ port });
	try {
		const { harness, client } = await setupClient();
		const registeredBefore = fixture.registeredClientCount();

		// /mcp add with just url + scopes + redirectUri — bodhi-pi runs discovery + DCR internally.
		await client.mcpAdd({
			url: fixture.mcpUrl,
			auth: "oauth-dcr",
			scopes: ["read"],
			redirectUri: "http://localhost:7777/callback",
			label: "dcrfix",
		});
		expect(fixture.registeredClientCount()).toBe(registeredBefore + 1);

		const slug = "localhost";
		const stored = (await harness.kvStore.get(`mcp/${slug}`)) as {
			auth: {
				mode: string;
				authorizeUrl: string;
				tokenUrl: string;
				clientId: string;
				clientSecret: { name: string; value: string; secret: true };
				dcrInfo: { issuerUrl: string; registrationEndpoint: string; registeredAt: number };
			};
		};
		expect(stored.auth.mode).toBe("oauth");
		expect(stored.auth.authorizeUrl).toBe(fixture.authorizeUrl);
		expect(stored.auth.tokenUrl).toBe(fixture.tokenUrl);
		expect(stored.auth.clientId).toMatch(/^dcr-/);
		expect(stored.auth.clientSecret.value.length).toBeGreaterThan(10);
		expect(stored.auth.dcrInfo.issuerUrl).toBe(fixture.url);
		expect(stored.auth.dcrInfo.registrationEndpoint).toBe(fixture.registrationEndpoint);

		// ACP read masks clientSecret.
		const viaKv = await client.kv.get({ key: `mcp/${slug}` });
		const viaKvAuth = (viaKv.value as { auth: { clientSecret: { value: string } } }).auth;
		expect(viaKvAuth.clientSecret.value).toBe("***");

		// Run the OAuth flow against the DCR-registered client — same code path as oauth-preregistered.
		const start = await client.mcpOauthStart({ slug });
		const u = new URL(start.authorizeUrl!);
		u.searchParams.set("auto", "1");
		const resp = await fetch(u.toString(), { redirect: "manual" });
		expect(resp.status).toBe(302);
		const cb = new URL(resp.headers.get("location")!);
		const code = cb.searchParams.get("code")!;
		const finish = await client.mcpOauthFinish({ slug, code, state: start.state! });
		expect(finish.status).toBe("completed");

		// Connect — tokens flow through the same attacher.
		const connect = await client.mcpConnect({ slug });
		expect(connect.tools).toContain(`${slug}__whoami`);

		await client.mcpDisconnect({ slug });
	} finally {
		await fixture.close();
	}
}, 30_000);

test("/mcp add oauth-dcr skips DCR when clientId override is supplied (uses pre-registered fallback)", async () => {
	const port = 33833;
	const fixture = await spawnOAuthMcpServer({ port });
	try {
		const { harness, client } = await setupClient();
		const registeredBefore = fixture.registeredClientCount();

		await client.mcpAdd({
			url: fixture.mcpUrl,
			auth: "oauth-dcr",
			clientId: fixture.clientId, // override → skip DCR
			clientSecret: fixture.clientSecret,
			redirectUri: "http://localhost:7777/callback",
			label: "dcr-override",
		});

		// No new DCR happened.
		expect(fixture.registeredClientCount()).toBe(registeredBefore);

		const stored = (await harness.kvStore.get("mcp/localhost")) as {
			auth: { mode: string; clientId: string; dcrInfo?: unknown };
		};
		expect(stored.auth.mode).toBe("oauth");
		expect(stored.auth.clientId).toBe(fixture.clientId);
		// No registration happened → no dcrInfo populated either.
		expect(stored.auth.dcrInfo).toBeUndefined();
	} finally {
		await fixture.close();
	}
});

test("/mcp add oauth-dcr rejects when discovery fails (bad URL)", async () => {
	const { client } = await setupClient();
	await expect(
		client.mcpAdd({
			url: "https://does-not-exist-1234567890.example/mcp",
			auth: "oauth-dcr",
			redirectUri: "http://localhost:7777/callback",
		}),
	).rejects.toThrow(/oauth-dcr discovery failed|no metadata/i);
}, 10_000);

test("/mcp add oauth-dcr requires redirectUri when DCR runs", async () => {
	const port = 33834;
	const fixture = await spawnOAuthMcpServer({ port });
	try {
		const { client } = await setupClient();
		await expect(
			client.ext(EXT_MCP_ADD, {
				url: fixture.mcpUrl,
				auth: "oauth-dcr",
				// missing redirectUri
			}),
		).rejects.toThrow(/oauth-dcr requires redirectUri/);
	} finally {
		await fixture.close();
	}
});

test("/mcp add oauth-dcr rejects stdio transport", async () => {
	const { client } = await setupClient();
	await expect(
		client.ext(EXT_MCP_ADD, {
			command: "npx",
			args: ["bogus"],
			auth: "oauth-dcr",
		}),
	).rejects.toThrow(/stdio entries do not accept auth/);
});

test("/mcp add oauth-dcr rejects sibling headers/queries", async () => {
	const port = 33835;
	const fixture = await spawnOAuthMcpServer({ port });
	try {
		const { client } = await setupClient();
		await expect(
			client.ext(EXT_MCP_ADD, {
				url: fixture.mcpUrl,
				auth: "oauth-dcr",
				headers: { X: "y" },
			}),
		).rejects.toThrow(/oauth-dcr".*rejects sibling headers/);
	} finally {
		await fixture.close();
	}
});
