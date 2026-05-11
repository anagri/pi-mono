import {
	type Api,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	type Model,
	registerFauxProvider,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test } from "vitest";
import { AUTH_PREFIX, createInMemoryKvStore } from "@/index.js";
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

test("agent reads provider api key from kvStore when populated", async () => {
	const model = newFaux();
	const kvStore = createInMemoryKvStore();
	await kvStore.set(AUTH_PREFIX + model.provider, "sk-from-kv", { secret: true });
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

test("kvStore wins over getApiKey when both present", async () => {
	const model = newFaux();
	const kvStore = createInMemoryKvStore();
	await kvStore.set(AUTH_PREFIX + model.provider, "sk-from-kv", { secret: true });
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

test("in-memory kvStore segregates secret entries via meta", async () => {
	const kv = createInMemoryKvStore();
	await kv.set("public/k", "value", { secret: false });
	await kv.set("auth/openai", "sk-xyz", { secret: true });
	expect(await kv.get("auth/openai")).toBe("sk-xyz");
	const meta = await kv.getWithMeta("auth/openai");
	expect(meta).toEqual({ value: "sk-xyz", secret: true });
	const all = await kv.listWithMeta();
	const authEntry = all.find((e) => e.key === "auth/openai");
	expect(authEntry?.secret).toBe(true);
	const publicEntry = all.find((e) => e.key === "public/k");
	expect(publicEntry?.secret).toBe(false);
});
