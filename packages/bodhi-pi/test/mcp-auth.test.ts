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

test("/mcp add http-param with headers tags values as secret, masked through ACP reads", async () => {
	const model = newFaux();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });
	const client = bindClient(harness);
	await client.initialize(stdInitParams);
	await client.newSession({ cwd: "/proj" });

	await client.mcpAdd({
		url: "https://mcp.example.com/mcp",
		auth: "http-param",
		headers: { Authorization: "Bearer secret-token" },
	});

	// In-process kv read sees plaintext (no ACP masking).
	const stored = await harness.kvStore.get("mcp/example");
	expect(stored).toMatchObject({
		auth: {
			mode: "http-param",
			headers: [{ name: "Authorization", value: "Bearer secret-token", secret: true }],
		},
	});

	// ACP read masks the secret value.
	const viaKv = await client.kv.get({ key: "mcp/example" });
	const viaKvAuth = (viaKv.value as { auth: { headers: Array<{ name: string; value: string }> } }).auth;
	expect(viaKvAuth.headers[0]).toEqual({ name: "Authorization", value: "***", secret: true });

	// /mcp list also masks.
	const entries = await client.mcpList();
	expect(entries).toHaveLength(1);
	const listAuth = entries[0]?.auth as { mode: string; headers: Array<{ name: string; value: string }> };
	expect(listAuth.mode).toBe("http-param");
	expect(listAuth.headers[0]).toEqual({ name: "Authorization", value: "***", secret: true });
});

test("/mcp add http-param with queries persists queries", async () => {
	const model = newFaux();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });
	const client = bindClient(harness);
	await client.initialize(stdInitParams);
	await client.newSession({ cwd: "/proj" });

	await client.mcpAdd({
		url: "https://mcp.example.com/mcp",
		auth: "http-param",
		queries: { api_key: "k1" },
	});

	const stored = await harness.kvStore.get("mcp/example");
	expect(stored).toMatchObject({
		auth: {
			mode: "http-param",
			queries: [{ name: "api_key", value: "k1", secret: true }],
		},
	});
});

test("/mcp add http-param accepts both headers and queries on a single entry", async () => {
	const model = newFaux();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });
	const client = bindClient(harness);
	await client.initialize(stdInitParams);
	await client.newSession({ cwd: "/proj" });

	await client.mcpAdd({
		url: "https://mcp.example.com/mcp",
		auth: "http-param",
		headers: { Authorization: "Bearer X", "X-Trace": "abc" },
		queries: { api_key: "k1" },
	});

	const stored = await harness.kvStore.get("mcp/example");
	const auth = (stored as { auth: { headers: unknown[]; queries: unknown[] } }).auth;
	expect(auth.headers).toEqual([
		{ name: "Authorization", value: "Bearer X", secret: true },
		{ name: "X-Trace", value: "abc", secret: true },
	]);
	expect(auth.queries).toEqual([{ name: "api_key", value: "k1", secret: true }]);
});

test("/mcp add rejects http-param with no headers and no queries", async () => {
	const model = newFaux();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });
	const client = bindClient(harness);
	await client.initialize(stdInitParams);
	await client.newSession({ cwd: "/proj" });

	await expect(client.mcpAdd({ url: "https://mcp.example.com/mcp", auth: "http-param" } as never)).rejects.toThrow(
		/at least one header or query entry/,
	);
});

test("/mcp add rejects http-param with empty headers and queries objects", async () => {
	const model = newFaux();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });
	const client = bindClient(harness);
	await client.initialize(stdInitParams);
	await client.newSession({ cwd: "/proj" });

	await expect(
		client.mcpAdd({
			url: "https://mcp.example.com/mcp",
			auth: "http-param",
			headers: {},
			queries: {},
		}),
	).rejects.toThrow(/at least one header or query entry/);
});

test("/mcp add rejects public auth when headers/queries are present (no silent attachment)", async () => {
	const model = newFaux();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });
	const client = bindClient(harness);
	await client.initialize(stdInitParams);
	await client.newSession({ cwd: "/proj" });

	// Bypass the typed client (which would strip headers when auth is "public") — raw extMethod
	// mirrors what a slash-UX user could submit by hand.
	await expect(
		client.ext(EXT_MCP_ADD, {
			url: "https://mcp.example.com/mcp",
			auth: "public",
			headers: { Authorization: "Bearer X" },
		}),
	).rejects.toThrow(/auth "public" rejects headers\/queries/);
});

test("/mcp add rejects unknown auth mode", async () => {
	const model = newFaux();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });
	const client = bindClient(harness);
	await client.initialize(stdInitParams);
	await client.newSession({ cwd: "/proj" });

	await expect(
		client.mcpAdd({
			url: "https://mcp.example.com/mcp",
			auth: "oauth-dcr",
		} as never),
	).rejects.toThrow(/auth must be "public" or "http-param"/);
});

test("/mcp add rejects non-string header values", async () => {
	const model = newFaux();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });
	const client = bindClient(harness);
	await client.initialize(stdInitParams);
	await client.newSession({ cwd: "/proj" });

	await expect(
		client.mcpAdd({
			url: "https://mcp.example.com/mcp",
			auth: "http-param",
			headers: { "X-Bad": 42 as unknown as string },
		}),
	).rejects.toThrow(/headers\["X-Bad"\] must be a string/);
});

test("/mcp add stdio rejects auth/headers/queries fields (stdio has no http auth concept)", async () => {
	const model = newFaux();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });
	const client = bindClient(harness);
	await client.initialize(stdInitParams);
	await client.newSession({ cwd: "/proj" });

	// Raw extMethod to assert the server-side rejection (typed client doesn't allow headers on stdio).
	await expect(
		client.ext(EXT_MCP_ADD, {
			command: "npx",
			args: ["@modelcontextprotocol/server-everything"],
			headers: { Authorization: "Bearer X" },
		}),
	).rejects.toThrow(/stdio entries do not accept auth\/headers\/queries/);
});
