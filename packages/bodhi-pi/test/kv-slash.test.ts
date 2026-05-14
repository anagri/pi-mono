import {
	type Api,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	type Model,
	registerFauxProvider,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test } from "vitest";
import { AUTH_PREFIX, createBodhiPiAgent, createInMemoryFilesystem, createInMemorySessionStore } from "@/index.js";
import { EXT_KV_GET, EXT_KV_LIST, EXT_KV_REMOVE, EXT_KV_SET } from "@/wire/constants.js";
import { stdInitParams } from "./helpers/acp-constants.js";
import { findUpdateOfKind, hasUpdateOfKind } from "./helpers/acp-narrow.js";
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

test("kv/set with a {value, secret:true} field masks the value on kv/get; internal read is unmasked", async () => {
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
		value: { api_key: { value: "sk-XYZ", secret: true } },
	});

	const got = (await harness.clientConn.extMethod(EXT_KV_GET, {
		key: `${AUTH_PREFIX}${model.provider}`,
	})) as { key: string; value: { api_key: { value: string; secret: boolean } } | null };
	expect(got).toEqual({
		key: `${AUTH_PREFIX}${model.provider}`,
		value: { api_key: { value: "***", secret: true } },
	});

	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] });
	expect(observedApiKey).toBe("sk-XYZ");
});

test("kv/list masks secret nodes recursively; non-secret entries return real values", async () => {
	const model = newFaux();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });
	await harness.clientConn.initialize(stdInitParams);
	await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	await harness.clientConn.extMethod(EXT_KV_SET, {
		key: `${AUTH_PREFIX}openai`,
		value: { api_key: { value: "sk-1", secret: true }, base_url: "http://h" },
	});
	await harness.clientConn.extMethod(EXT_KV_SET, { key: "public/k", value: "value" });

	const listed = (await harness.clientConn.extMethod(EXT_KV_LIST, { prefix: AUTH_PREFIX })) as {
		entries: Array<{ key: string; value: unknown }>;
	};
	expect(listed.entries).toEqual([
		{
			key: `${AUTH_PREFIX}openai`,
			value: { api_key: { value: "***", secret: true }, base_url: "http://h" },
		},
	]);

	const listedAll = (await harness.clientConn.extMethod(EXT_KV_LIST, {})) as {
		entries: Array<{ key: string; value: unknown }>;
	};
	const byKey = Object.fromEntries(listedAll.entries.map((e) => [e.key, e.value]));
	expect(byKey["public/k"]).toBe("value");
});

test("kv/remove clears the entry; subsequent get returns value: null", async () => {
	const model = newFaux();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });
	await harness.clientConn.initialize(stdInitParams);
	await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	await harness.clientConn.extMethod(EXT_KV_SET, { key: "foo", value: "bar" });
	await harness.clientConn.extMethod(EXT_KV_REMOVE, { key: "foo" });
	const got = (await harness.clientConn.extMethod(EXT_KV_GET, { key: "foo" })) as {
		value: unknown | null;
	};
	expect(got.value).toBeNull();
});

test("kv/set with auth/* key emits config_option_update sessionUpdate", async () => {
	const model = newFaux();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	harness.updates.length = 0;

	const result = (await harness.clientConn.extMethod(EXT_KV_SET, {
		sessionId,
		key: `${AUTH_PREFIX}${model.provider}`,
		value: { api_key: { value: "sk-XYZ", secret: true } },
	})) as Record<string, unknown>;
	expect(result).not.toHaveProperty("configOptions");

	const update = findUpdateOfKind(harness.updates, "config_option_update", sessionId);
	expect(update.configOptions[0]?.id).toBe("model");
	expect(update.configOptions[0]?.currentValue).toBe(model.id);
});

test("kv/set non-auth key emits no config_option_update", async () => {
	const model = newFaux();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	harness.updates.length = 0;

	const result = (await harness.clientConn.extMethod(EXT_KV_SET, {
		sessionId,
		key: "unrelated/key",
		value: "v",
	})) as Record<string, unknown>;
	expect(result).not.toHaveProperty("configOptions");
	expect(hasUpdateOfKind(harness.updates, "config_option_update")).toBe(false);
});

test("kv/remove with auth/* key emits config_option_update sessionUpdate", async () => {
	const model = newFaux();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	await harness.clientConn.extMethod(EXT_KV_SET, {
		key: `${AUTH_PREFIX}${model.provider}`,
		value: { api_key: { value: "sk-XYZ", secret: true } },
	});
	harness.updates.length = 0;
	const result = (await harness.clientConn.extMethod(EXT_KV_REMOVE, {
		sessionId,
		key: `${AUTH_PREFIX}${model.provider}`,
	})) as Record<string, unknown>;
	expect(result).not.toHaveProperty("configOptions");

	const update = findUpdateOfKind(harness.updates, "config_option_update", sessionId);
	expect(update.configOptions[0]?.id).toBe("model");
});

test("kv handlers throw -32601 when kvStore is not configured", async () => {
	const model = newFaux();
	const updates: unknown[] = [];
	const { clientConn } = createInProcessAcpPair(
		createBodhiPiAgent({
			models: [model],
			defaultModelId: model.id,
			getApiKey: () => undefined,
			sessionStore: createInMemorySessionStore(),
			filesystem: createInMemoryFilesystem(),
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
