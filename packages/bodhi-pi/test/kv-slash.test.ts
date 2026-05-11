import {
	type Api,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	type Model,
	registerFauxProvider,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test } from "vitest";
import { EXT_KV_GET, EXT_KV_LIST, EXT_KV_REMOVE, EXT_KV_SET } from "@/acp/constants.js";
import { AUTH_PREFIX, createBodhiPiAgent, createInMemoryFilesystem, createInMemorySessionStore } from "@/index.js";
import { stdInitParams } from "./helpers/acp-constants.js";
import { createTestHarness } from "./helpers/harness.js";
import { createInProcessAcpPair } from "./helpers/in-process-connection.js";

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

test("kv/set marked secret returns *** from kv/get; internal read is unmasked", async () => {
	const model = newFaux();
	const harness = createTestHarness({
		models: [model],
		defaultModelId: model.id,
		getApiKey: () => undefined,
	});
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	await harness.clientConn.extMethod(EXT_KV_SET, {
		key: `${AUTH_PREFIX}${model.provider}`,
		value: "sk-XYZ",
		secret: true,
	});

	const got = (await harness.clientConn.extMethod(EXT_KV_GET, {
		key: `${AUTH_PREFIX}${model.provider}`,
	})) as { value: string | null; secret: boolean };
	expect(got).toEqual({ key: `${AUTH_PREFIX}${model.provider}`, value: "***", secret: true });

	// Internal resolution still sees the real value.
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] });
	expect(observedApiKey).toBe("sk-XYZ");
});

test("kv/list masks secret values to ***; non-secret entries return real values", async () => {
	const model = newFaux();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });
	await harness.clientConn.initialize(stdInitParams);
	await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	await harness.clientConn.extMethod(EXT_KV_SET, { key: `${AUTH_PREFIX}openai`, value: "sk-1", secret: true });
	await harness.clientConn.extMethod(EXT_KV_SET, { key: "public/k", value: "value", secret: false });

	const listed = (await harness.clientConn.extMethod(EXT_KV_LIST, { prefix: AUTH_PREFIX })) as {
		entries: Array<{ key: string; value: string; secret: boolean }>;
	};
	expect(listed.entries).toEqual([{ key: `${AUTH_PREFIX}openai`, value: "***", secret: true }]);

	const listedAll = (await harness.clientConn.extMethod(EXT_KV_LIST, {})) as {
		entries: Array<{ key: string; value: string; secret: boolean }>;
	};
	const byKey = Object.fromEntries(listedAll.entries.map((e) => [e.key, e]));
	expect(byKey["public/k"]).toEqual({ key: "public/k", value: "value", secret: false });
});

test("kv/remove clears the entry; subsequent get returns value: null", async () => {
	const model = newFaux();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });
	await harness.clientConn.initialize(stdInitParams);
	await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	await harness.clientConn.extMethod(EXT_KV_SET, { key: "foo", value: "bar" });
	await harness.clientConn.extMethod(EXT_KV_REMOVE, { key: "foo" });
	const got = (await harness.clientConn.extMethod(EXT_KV_GET, { key: "foo" })) as {
		value: string | null;
	};
	expect(got.value).toBeNull();
});

test("kv handlers throw -32601 when kvStore is not configured", async () => {
	const model = newFaux();
	// Build a bespoke harness without kvStore — bypass `createTestHarness` default.
	const updates: unknown[] = [];
	const { clientConn } = createInProcessAcpPair(
		createBodhiPiAgent({
			models: [model],
			defaultModelId: model.id,
			getApiKey: () => undefined,
			sessionStore: createInMemorySessionStore(),
			filesystem: createInMemoryFilesystem(),
			// kvStore intentionally omitted
		}),
		() => ({
			sessionUpdate: async (params: unknown) => {
				updates.push(params);
			},
			requestPermission: async () => ({ outcome: { outcome: "cancelled" } }) as never,
		}),
	);
	await clientConn.initialize(stdInitParams);
	await expect(clientConn.extMethod(EXT_KV_SET, { key: "foo", value: "bar" })).rejects.toThrow(
		/kvStore not configured/,
	);
});
