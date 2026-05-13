import {
	type Api,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	type Model,
	registerFauxProvider,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test } from "vitest";
import { AUTH_PREFIX, containsSecret, createInMemoryKvStore, maskSecrets } from "@/index.js";
import { stdInitParams } from "./helpers/acp-constants.js";
import { createTestHarness } from "./helpers/harness.js";

let providers: FauxProviderRegistration[] = [];
let observedApiKey: string | undefined;

beforeEach(() => {
	providers = [];
	observedApiKey = undefined;
});
afterEach(() => {
	for (const p of providers) p.unregister();
	providers = [];
});

function newFaux(): Model<Api> {
	const faux = registerFauxProvider();
	providers.push(faux);
	faux.setResponses([
		(_ctx, options) => {
			observedApiKey = options?.apiKey;
			return fauxAssistantMessage("ok");
		},
	]);
	return faux.getModel() as Model<Api>;
}

async function runOnePrompt(harness: ReturnType<typeof createTestHarness>, sessionId: string): Promise<void> {
	await harness.clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: "hi" }],
	});
}

test("agent reads provider api key from kvStore.api_key.value when populated", async () => {
	const model = newFaux();
	const kvStore = createInMemoryKvStore();
	await kvStore.set(AUTH_PREFIX + model.provider, { api_key: { value: "sk-from-kv", secret: true } });
	const harness = createTestHarness({
		models: [model],
		defaultModelId: model.id,
		getApiKey: () => undefined,
		kvStore,
	});
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await runOnePrompt(harness, sessionId);
	expect(observedApiKey).toBe("sk-from-kv");
});

test("agent falls back to getApiKey when kvStore lacks the entry", async () => {
	const model = newFaux();
	const harness = createTestHarness({
		models: [model],
		defaultModelId: model.id,
		getApiKey: () => "sk-from-host",
		kvStore: createInMemoryKvStore(),
	});
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await runOnePrompt(harness, sessionId);
	expect(observedApiKey).toBe("sk-from-host");
});

test("kvStore api_key wins over getApiKey when both present", async () => {
	const model = newFaux();
	const kvStore = createInMemoryKvStore();
	await kvStore.set(AUTH_PREFIX + model.provider, { api_key: { value: "sk-from-kv", secret: true } });
	const harness = createTestHarness({
		models: [model],
		defaultModelId: model.id,
		getApiKey: () => "sk-from-host",
		kvStore,
	});
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await runOnePrompt(harness, sessionId);
	expect(observedApiKey).toBe("sk-from-kv");
});

test("keyless auth (base_url only) emits 'mock' sentinel for the api key", async () => {
	const model = newFaux();
	const kvStore = createInMemoryKvStore();
	await kvStore.set(AUTH_PREFIX + model.provider, { base_url: "http://localhost:11434/v1" });
	const harness = createTestHarness({
		models: [model],
		defaultModelId: model.id,
		getApiKey: () => undefined,
		kvStore,
	});
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await runOnePrompt(harness, sessionId);
	expect(observedApiKey).toBe("mock");
});

test("in-memory kvStore stores JSON values verbatim; list returns unmasked", async () => {
	const kv = createInMemoryKvStore();
	await kv.set("public/k", "value");
	await kv.set("auth/openai", { api_key: { value: "sk-xyz", secret: true }, base_url: "http://h" });
	expect(await kv.get("auth/openai")).toEqual({
		api_key: { value: "sk-xyz", secret: true },
		base_url: "http://h",
	});
	const all = await kv.list();
	const byKey = Object.fromEntries(all.map((e) => [e.key, e.value]));
	expect(byKey["public/k"]).toBe("value");
	expect(byKey["auth/openai"]).toEqual({
		api_key: { value: "sk-xyz", secret: true },
		base_url: "http://h",
	});
});

test("maskSecrets replaces value field inside any {value: string, secret: true} node", () => {
	const input = {
		api_key: { value: "sk-xyz", secret: true },
		base_url: "http://h",
		nested: { deep: { value: "deep-secret", secret: true, other: "kept" } },
		arr: [{ value: "arr-secret", secret: true }, "plain"],
		notSecret: { value: "shown", secret: false },
		noFlag: { value: "also-shown" },
	};
	const masked = maskSecrets(input);
	expect(masked).toEqual({
		api_key: { value: "***", secret: true },
		base_url: "http://h",
		nested: { deep: { value: "***", secret: true, other: "kept" } },
		arr: [{ value: "***", secret: true }, "plain"],
		notSecret: { value: "shown", secret: false },
		noFlag: { value: "also-shown" },
	});
	expect(input.api_key.value).toBe("sk-xyz");
});

test("containsSecret detects nested markers and ignores secret:false", () => {
	expect(containsSecret({ api_key: { value: "x", secret: true } })).toBe(true);
	expect(containsSecret([1, 2, { nested: { value: "y", secret: true } }])).toBe(true);
	expect(containsSecret({ value: "x", secret: false })).toBe(false);
	expect(containsSecret("plain")).toBe(false);
	expect(containsSecret(null)).toBe(false);
});
