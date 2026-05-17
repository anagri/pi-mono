import { LLMock } from "@copilotkit/aimock";
import {
	type Api,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	getModel,
	type Model,
	registerFauxProvider,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createInMemorySessionStore } from "@/index.js";
import { BODHI_PI_VERSION } from "@/version.js";
import { stdInitParams } from "./helpers/acp-constants.js";
import { asSelectOption } from "./helpers/acp-narrow.js";
import { createTestHarness } from "./helpers/harness.js";
import { chunkedAgentText, userChunkText } from "./helpers/notifications.js";

let mocks: LLMock[] = [];
let fauxProviders: FauxProviderRegistration[] = [];

beforeEach(() => {
	mocks = [];
	fauxProviders = [];
});

afterEach(async () => {
	await Promise.all(mocks.map((m) => m.stop()));
	mocks = [];
	for (const p of fauxProviders) p.unregister();
	fauxProviders = [];
});

async function startMock(): Promise<LLMock> {
	const mock = new LLMock({ port: 0 });
	await mock.start();
	mocks.push(mock);
	return mock;
}

function newFaux(opts?: Parameters<typeof registerFauxProvider>[0]): FauxProviderRegistration {
	const p = registerFauxProvider(opts);
	fauxProviders.push(p);
	return p;
}

test("simple chat round-trips via ACP through aimock", async () => {
	const mock = await startMock();
	mock.onMessage(/Monday/i, { content: "tuesday" });

	const baseModel = getModel("openai", "gpt-5-mini");
	const { clientConn, updates } = createTestHarness({
		models: [{ ...baseModel, baseUrl: `${mock.url}/v1` }],
		defaultModelId: baseModel.id,
		sessionStore: createInMemorySessionStore(),
	});

	await clientConn.initialize(stdInitParams);

	const newSession = await clientConn.newSession({
		cwd: process.cwd(),
		mcpServers: [],
	});

	const modelOption = asSelectOption(newSession.configOptions?.[0]);
	expect(modelOption.id).toBe("model");
	expect(modelOption.currentValue).toBe(baseModel.id);
	expect(modelOption.options).toHaveLength(1);

	const result = await clientConn.prompt({
		sessionId: newSession.sessionId,
		prompt: [{ type: "text", text: "Answer in one word: what day comes after Monday?" }],
	});

	expect(result.stopReason).toBe("end_turn");
	expect(chunkedAgentText(updates).trim().toLowerCase()).toBe("tuesday");
});

test("switch model via setSessionConfigOption routes to second mock", async () => {
	const mockA = await startMock();
	const mockB = await startMock();
	mockA.onMessage(/.*/, { content: "from-a" });
	mockB.onMessage(/.*/, { content: "from-b" });

	const baseModel = getModel("openai", "gpt-5-mini");
	const modelA: typeof baseModel = {
		...baseModel,
		id: "model-a",
		name: "Model A",
		baseUrl: `${mockA.url}/v1`,
	};
	const modelB: typeof baseModel = {
		...baseModel,
		id: "model-b",
		name: "Model B",
		baseUrl: `${mockB.url}/v1`,
	};

	const { clientConn, updates } = createTestHarness({
		models: [modelA, modelB],
		defaultModelId: "model-a",
		sessionStore: createInMemorySessionStore(),
	});

	await clientConn.initialize(stdInitParams);
	const { sessionId, configOptions } = await clientConn.newSession({
		cwd: process.cwd(),
		mcpServers: [],
	});
	const initialOption = asSelectOption(configOptions?.[0]);
	expect(initialOption.currentValue).toBe("model-a");
	expect(initialOption.options).toHaveLength(2);

	updates.length = 0;
	await clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "anything" }] });
	expect(chunkedAgentText(updates).trim()).toBe("from-a");

	const switchResult = await clientConn.setSessionConfigOption({
		sessionId,
		configId: "model",
		value: "model-b",
	});
	const switched = asSelectOption(switchResult.configOptions[0]);
	expect(switched.currentValue).toBe("model-b");

	updates.length = 0;
	await clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "anything else" }] });
	expect(chunkedAgentText(updates).trim()).toBe("from-b");
});

test("persists messages and replays via session/load", async () => {
	const mock = await startMock();
	mock.onMessage(/.*/, { content: "noted" });

	const baseModel = getModel("openai", "gpt-5-mini");
	const store = createInMemorySessionStore();
	const cwd = "/test/persist";

	const writer = createTestHarness({
		models: [{ ...baseModel, baseUrl: `${mock.url}/v1` }],
		defaultModelId: baseModel.id,
		sessionStore: store,
	});
	await writer.clientConn.initialize(stdInitParams);
	const { sessionId } = await writer.clientConn.newSession({ cwd, mcpServers: [] });
	await writer.clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: "say noted" }],
	});

	// Verify the store captured both turns.
	const stored = await store.load(sessionId);
	expect(stored).toBeDefined();
	const messageEntries = stored?.entries.filter((e) => e.type === "message") ?? [];
	expect(messageEntries).toHaveLength(2);
	expect((messageEntries[0] as { message: { role: string } }).message.role).toBe("user");
	expect((messageEntries[1] as { message: { role: string } }).message.role).toBe("assistant");

	// Open a fresh client against the same store and load the session.
	const reader = createTestHarness({
		models: [{ ...baseModel, baseUrl: `${mock.url}/v1` }],
		defaultModelId: baseModel.id,
		sessionStore: store,
	});
	await reader.clientConn.initialize(stdInitParams);

	const loadResult = await reader.clientConn.loadSession({
		sessionId,
		cwd,
		mcpServers: [],
	});
	const loadedOption = asSelectOption(loadResult.configOptions?.[0]);
	expect(loadedOption.currentValue).toBe(baseModel.id);

	expect(userChunkText(reader.updates)).toBe("say noted");
	expect(chunkedAgentText(reader.updates)).toBe("noted");
});

test("lists sessions filtered by cwd", async () => {
	const mock = await startMock();
	mock.onMessage(/.*/, { content: "ack" });

	const baseModel = getModel("openai", "gpt-5-mini");
	const store = createInMemorySessionStore();
	const { clientConn } = createTestHarness({
		models: [{ ...baseModel, baseUrl: `${mock.url}/v1` }],
		defaultModelId: baseModel.id,
		sessionStore: store,
	});
	await clientConn.initialize(stdInitParams);

	await clientConn.newSession({ cwd: "/a", mcpServers: [] });
	await clientConn.newSession({ cwd: "/a", mcpServers: [] });
	await clientConn.newSession({ cwd: "/b", mcpServers: [] });

	const aOnly = await clientConn.listSessions({ cwd: "/a" });
	expect(aOnly.sessions).toHaveLength(2);
	for (const s of aOnly.sessions) expect(s.cwd).toBe("/a");

	const all = await clientConn.listSessions({});
	expect(all.sessions).toHaveLength(3);
});

test("close releases active resources but data persists", async () => {
	const mock = await startMock();
	mock.onMessage(/.*/, { content: "noted" });

	const baseModel = getModel("openai", "gpt-5-mini");
	const store = createInMemorySessionStore();
	const cwd = "/test/close";

	const { clientConn, updates } = createTestHarness({
		models: [{ ...baseModel, baseUrl: `${mock.url}/v1` }],
		defaultModelId: baseModel.id,
		sessionStore: store,
	});
	await clientConn.initialize(stdInitParams);
	const { sessionId } = await clientConn.newSession({ cwd, mcpServers: [] });
	await clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "hello" }] });

	await clientConn.closeSession({ sessionId });

	// Subsequent prompt without re-load fails.
	await expect(clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "again" }] })).rejects.toThrow(
		/not loaded/,
	);

	// Data persists in store.
	const stored = await store.load(sessionId);
	expect(stored).toBeDefined();
	expect(stored?.entries.filter((e) => e.type === "message")).toHaveLength(2);

	// Listing still includes it.
	const list = await clientConn.listSessions({});
	expect(list.sessions.some((s: { sessionId: string }) => s.sessionId === sessionId)).toBe(true);

	// Reload succeeds and replays history.
	updates.length = 0;
	await clientConn.loadSession({ sessionId, cwd, mcpServers: [] });
	expect(chunkedAgentText(updates)).toBe("noted");

	// Now prompts work again.
	updates.length = 0;
	await clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "after reload" }] });
	expect(chunkedAgentText(updates)).toBe("noted");
});

test("model change persists across load", async () => {
	const mockA = await startMock();
	const mockB = await startMock();
	mockA.onMessage(/.*/, { content: "from-a" });
	mockB.onMessage(/.*/, { content: "from-b" });

	const baseModel = getModel("openai", "gpt-5-mini");
	const modelA: typeof baseModel = {
		...baseModel,
		id: "model-a",
		name: "Model A",
		baseUrl: `${mockA.url}/v1`,
	};
	const modelB: typeof baseModel = {
		...baseModel,
		id: "model-b",
		name: "Model B",
		baseUrl: `${mockB.url}/v1`,
	};
	const store = createInMemorySessionStore();
	const cwd = "/test/model-persist";

	const writer = createTestHarness({
		models: [modelA, modelB],
		defaultModelId: "model-a",
		sessionStore: store,
	});
	await writer.clientConn.initialize(stdInitParams);
	const { sessionId } = await writer.clientConn.newSession({ cwd, mcpServers: [] });

	await writer.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "x" }] });
	expect(chunkedAgentText(writer.updates)).toBe("from-a");

	await writer.clientConn.setSessionConfigOption({
		sessionId,
		configId: "model",
		value: "model-b",
	});
	writer.updates.length = 0;
	await writer.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "y" }] });
	expect(chunkedAgentText(writer.updates)).toBe("from-b");

	// Fresh client, same store; load and verify model-b is restored.
	const reader = createTestHarness({
		models: [modelA, modelB],
		defaultModelId: "model-a",
		sessionStore: store,
	});
	await reader.clientConn.initialize(stdInitParams);
	const loadResult = await reader.clientConn.loadSession({ sessionId, cwd, mcpServers: [] });
	const loadedOption = asSelectOption(loadResult.configOptions?.[0]);
	expect(loadedOption.currentValue).toBe("model-b");

	reader.updates.length = 0;
	await reader.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "z" }] });
	expect(chunkedAgentText(reader.updates)).toBe("from-b");
});

test("resumeSession rehydrates without replaying history", async () => {
	const mock = await startMock();
	mock.onMessage(/.*/, { content: "ack" });

	const baseModel = getModel("openai", "gpt-5-mini");
	const store = createInMemorySessionStore();
	const cwd = "/test/resume";

	const writer = createTestHarness({
		models: [{ ...baseModel, baseUrl: `${mock.url}/v1` }],
		defaultModelId: baseModel.id,
		sessionStore: store,
	});
	await writer.clientConn.initialize(stdInitParams);
	const { sessionId } = await writer.clientConn.newSession({ cwd, mcpServers: [] });
	await writer.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "first" }] });

	const reader = createTestHarness({
		models: [{ ...baseModel, baseUrl: `${mock.url}/v1` }],
		defaultModelId: baseModel.id,
		sessionStore: store,
	});
	await reader.clientConn.initialize(stdInitParams);

	const resumeResult = await reader.clientConn.resumeSession({ sessionId, cwd, mcpServers: [] });
	const resumedOption = asSelectOption(resumeResult.configOptions?.[0]);
	expect(resumedOption.currentValue).toBe(baseModel.id);

	// Critical contrast vs loadSession: NO history replay notifications.
	const replayKinds = new Set(["user_message_chunk", "agent_message_chunk", "tool_call", "tool_call_update"]);
	expect(reader.updates.filter((u) => replayKinds.has(u.update.sessionUpdate))).toHaveLength(0);

	// Subsequent prompts work because the session is now loaded in cache.
	await reader.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "second" }] });
	expect(chunkedAgentText(reader.updates)).toBe("ack");
});

test("permanent delete via _bodhi-pi/session/delete", async () => {
	const mock = await startMock();
	mock.onMessage(/.*/, { content: "ack" });

	const baseModel = getModel("openai", "gpt-5-mini");
	const store = createInMemorySessionStore();
	const cwd = "/test/delete";

	const { clientConn } = createTestHarness({
		models: [{ ...baseModel, baseUrl: `${mock.url}/v1` }],
		defaultModelId: baseModel.id,
		sessionStore: store,
	});
	const initResult = await clientConn.initialize(stdInitParams);
	expect(initResult.agentCapabilities?._meta).toMatchObject({
		"bodhi-pi": { version: BODHI_PI_VERSION },
	});

	const { sessionId } = await clientConn.newSession({ cwd, mcpServers: [] });
	await clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "x" }] });

	await clientConn.extMethod("_bodhi-pi/session/delete", { sessionId });

	expect(await store.load(sessionId)).toBeUndefined();
	const list = await clientConn.listSessions({});
	expect(list.sessions.some((s: { sessionId: string }) => s.sessionId === sessionId)).toBe(false);

	await expect(clientConn.loadSession({ sessionId, cwd, mcpServers: [] })).rejects.toThrow(/unknown session/);
});

test("initialize advertises agentInfo with bodhi-pi name + version", async () => {
	const mock = await startMock();
	mock.onMessage(/.*/, { content: "ack" });

	const baseModel = getModel("openai", "gpt-5-mini");
	const { clientConn } = createTestHarness({
		models: [{ ...baseModel, baseUrl: `${mock.url}/v1` }],
		defaultModelId: baseModel.id,
		sessionStore: createInMemorySessionStore(),
	});

	const initResult = await clientConn.initialize(stdInitParams);
	expect(initResult.agentInfo).toEqual({ name: "bodhi-pi", version: expect.any(String) });
});

test("initialize advertises capabilities._meta['bodhi-pi'] with version + availability flags", async () => {
	const mock = await startMock();
	mock.onMessage(/.*/, { content: "ack" });

	const baseModel = getModel("openai", "gpt-5-mini");
	const { clientConn } = createTestHarness({
		models: [{ ...baseModel, baseUrl: `${mock.url}/v1` }],
		defaultModelId: baseModel.id,
		sessionStore: createInMemorySessionStore(),
	});

	const initResult = await clientConn.initialize(stdInitParams);
	expect(initResult.agentCapabilities?._meta).toMatchObject({
		"bodhi-pi": { version: BODHI_PI_VERSION },
	});
});

test("initialize advertises per-namespace availability reflecting the injected adapter set", async () => {
	const mock = await startMock();
	mock.onMessage(/.*/, { content: "ack" });
	const baseModel = getModel("openai", "gpt-5-mini");
	const model = { ...baseModel, baseUrl: `${mock.url}/v1` };

	// Harness wires kvStore by default → kv:true, mcp:true. Terminal/scriptExecutor absent.
	const withKv = createTestHarness({
		models: [model],
		defaultModelId: model.id,
		sessionStore: createInMemorySessionStore(),
	});
	const withKvInit = await withKv.clientConn.initialize(stdInitParams);
	const withKvAvail = (
		withKvInit.agentCapabilities?._meta as { "bodhi-pi"?: { available?: Record<string, boolean> } }
	)?.["bodhi-pi"]?.available;
	expect(withKvAvail).toEqual({
		kv: true,
		mcp: true,
		terminal: false,
		scriptExecutor: false,
		settings: true,
	});

	// Construct an agent directly without kvStore to verify kv:false / mcp:false.
	const { createBodhiPiAgent: makeAgent, createInMemoryFilesystem: fs } = await import("@/index.js");
	const { createInProcessAcpPair } = await import("./helpers/in-process-connection.js");
	const { clientConn: bareConn } = createInProcessAcpPair(
		makeAgent({
			models: [model],
			defaultModelId: model.id,
			sessionStore: createInMemorySessionStore(),
			filesystem: fs(),
			getApiKey: () => "test-key",
		}),
		() => ({
			sessionUpdate: async () => {},
			requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
		}),
	);
	const bareInit = await bareConn.initialize(stdInitParams);
	const bareAvail = (bareInit.agentCapabilities?._meta as { "bodhi-pi"?: { available?: Record<string, boolean> } })?.[
		"bodhi-pi"
	]?.available;
	expect(bareAvail).toEqual({
		kv: false,
		mcp: false,
		terminal: false,
		scriptExecutor: false,
		settings: true,
	});
});

test("listSessions.updatedAt bumps on each prompt", async () => {
	const mock = await startMock();
	mock.onMessage(/.*/, { content: "noted" });

	const baseModel = getModel("openai", "gpt-5-mini");
	const store = createInMemorySessionStore();
	const cwd = "/test/updated-at";

	const { clientConn } = createTestHarness({
		models: [{ ...baseModel, baseUrl: `${mock.url}/v1` }],
		defaultModelId: baseModel.id,
		sessionStore: store,
	});
	await clientConn.initialize(stdInitParams);
	const { sessionId } = await clientConn.newSession({ cwd, mcpServers: [] });

	const beforeRecord = await store.load(sessionId);
	expect(beforeRecord, "session record present").toBeDefined();
	const initialUpdatedAt = (beforeRecord as { updatedAt: number }).updatedAt;
	const initialCreatedAt = (beforeRecord as { createdAt: number }).createdAt;
	expect(initialUpdatedAt).toBe(initialCreatedAt);

	// Poll until the store's `updatedAt` strictly exceeds initialUpdatedAt — the
	// prompt's `message_end` handler bumps it. Polling beats a fixed sleep
	// because some CI clocks tick at >2 ms resolution; a 5 ms `setTimeout` was
	// flaky under load.
	const deadline = Date.now() + 1000;
	while (Date.now() < deadline) {
		await clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] });
		const after = await store.load(sessionId);
		if (after && after.updatedAt > initialUpdatedAt) break;
		await new Promise((r) => setImmediate(r));
	}

	const list = await clientConn.listSessions({ cwd });
	const entry = list.sessions.find((s: { sessionId: string }) => s.sessionId === sessionId);
	expect(entry, "session present in list").toBeDefined();
	const listedUpdatedAt = new Date((entry as { updatedAt: string }).updatedAt).getTime();
	expect(listedUpdatedAt).toBeGreaterThan(initialUpdatedAt);
});

test("prompt echoes userMessageId from the request", async () => {
	const faux = newFaux();
	faux.setResponses([fauxAssistantMessage("ok")]);
	const model = faux.getModel() as Model<Api>;

	const { clientConn } = createTestHarness({
		models: [model],
		defaultModelId: model.id,
		sessionStore: createInMemorySessionStore(),
	});
	await clientConn.initialize(stdInitParams);
	const { sessionId } = await clientConn.newSession({ cwd: "/", mcpServers: [] });

	const result = await clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: "hi" }],
		messageId: "msg-abc-123",
	});
	expect(result.userMessageId).toBe("msg-abc-123");
});

test("stopReason maps from pi-agent-core 'length' to ACP 'max_tokens'", async () => {
	const faux = newFaux();
	faux.setResponses([fauxAssistantMessage("truncated", { stopReason: "length" })]);
	const model = faux.getModel() as Model<Api>;

	const { clientConn } = createTestHarness({
		models: [model],
		defaultModelId: model.id,
		sessionStore: createInMemorySessionStore(),
	});
	await clientConn.initialize(stdInitParams);
	const { sessionId } = await clientConn.newSession({ cwd: "/", mcpServers: [] });

	const result = await clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "x" }] });
	expect(result.stopReason).toBe("max_tokens");
});

test("cancel during prompt yields stopReason 'cancelled'", async () => {
	// Slow streaming so we can land a cancel between start and end.
	const faux = newFaux({ tokensPerSecond: 30 });
	faux.setResponses([fauxAssistantMessage("a long enough message to be interrupted by cancellation")]);
	const model = faux.getModel() as Model<Api>;

	const { clientConn, updates } = createTestHarness({
		models: [model],
		defaultModelId: model.id,
		sessionStore: createInMemorySessionStore(),
	});
	await clientConn.initialize(stdInitParams);
	const { sessionId } = await clientConn.newSession({ cwd: "/", mcpServers: [] });

	const promptPromise = clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "stream" }] });

	// Wait for the first agent_message_chunk notification — proves the stream is
	// actually mid-flight. Beats a fixed `setTimeout` because slow CI runners can
	// miss a 30 ms window even on a successful stream-start.
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		const seenChunk = updates.some(
			(u) => (u.update as { sessionUpdate?: string }).sessionUpdate === "agent_message_chunk",
		);
		if (seenChunk) break;
		await new Promise((r) => setImmediate(r));
	}

	await clientConn.cancel({ sessionId });
	const result = await promptPromise;
	expect(result.stopReason).toBe("cancelled");
});

test("BodhiPiConfig.systemPrompt threads into the pi-agent-core context", async () => {
	const seen: string[] = [];
	const faux = newFaux();
	// Use a factory response so we can capture the systemPrompt that pi-agent-core
	// passes into the LLM call's Context.
	faux.setResponses([
		(ctx) => {
			seen.push(ctx.systemPrompt ?? "<none>");
			return fauxAssistantMessage("ok");
		},
	]);
	const model = faux.getModel() as Model<Api>;

	const SENTINEL = "you are a unit-test sentinel";
	const { clientConn } = createTestHarness({
		models: [model],
		defaultModelId: model.id,
		sessionStore: createInMemorySessionStore(),
		systemPrompt: SENTINEL,
	});
	await clientConn.initialize(stdInitParams);
	const { sessionId } = await clientConn.newSession({ cwd: "/", mcpServers: [] });
	await clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "ping" }] });

	expect(seen).toHaveLength(1);
	expect(seen[0]).toContain(SENTINEL);
});

test("systemPrompt is reapplied on loadSession (config-time, not session state)", async () => {
	const seen: string[] = [];
	const faux1 = newFaux();
	faux1.setResponses([
		(ctx) => {
			seen.push(ctx.systemPrompt ?? "<none>");
			return fauxAssistantMessage("ok");
		},
	]);
	const model1 = faux1.getModel() as Model<Api>;

	const PROMPT_A = "agent personality A";
	const store = createInMemorySessionStore();
	const writer = createTestHarness({
		models: [model1],
		defaultModelId: model1.id,
		sessionStore: store,
		systemPrompt: PROMPT_A,
	});
	await writer.clientConn.initialize(stdInitParams);
	const { sessionId } = await writer.clientConn.newSession({ cwd: "/", mcpServers: [] });
	await writer.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "ping" }] });

	// A different host comes back with a different systemPrompt + a different faux provider.
	const faux2 = newFaux();
	faux2.setResponses([
		(ctx) => {
			seen.push(ctx.systemPrompt ?? "<none>");
			return fauxAssistantMessage("ok");
		},
	]);
	const model2 = faux2.getModel() as Model<Api>;

	const PROMPT_B = "agent personality B (loaded later)";
	const reader = createTestHarness({
		models: [model2],
		defaultModelId: model2.id,
		sessionStore: store,
		systemPrompt: PROMPT_B,
	});
	await reader.clientConn.initialize(stdInitParams);
	await reader.clientConn.loadSession({ sessionId, cwd: "/", mcpServers: [] });
	await reader.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "ping" }] });

	expect(seen).toHaveLength(2);
	expect(seen[0]).toContain(PROMPT_A);
	expect(seen[1]).toContain(PROMPT_B);
	// systemPrompt is config-time only: the second call's prompt must NOT carry PROMPT_A.
	expect(seen[1]).not.toContain(PROMPT_A);
});

test("listSessions omits nextCursor when there's no next page", async () => {
	const mock = await startMock();
	mock.onMessage(/.*/, { content: "ack" });

	const baseModel = getModel("openai", "gpt-5-mini");
	const { clientConn } = createTestHarness({
		models: [{ ...baseModel, baseUrl: `${mock.url}/v1` }],
		defaultModelId: baseModel.id,
		sessionStore: createInMemorySessionStore(),
	});
	await clientConn.initialize(stdInitParams);
	await clientConn.newSession({ cwd: "/x", mcpServers: [] });

	const list = (await clientConn.listSessions({})) as Record<string, unknown>;
	expect("nextCursor" in list).toBe(false);
});
