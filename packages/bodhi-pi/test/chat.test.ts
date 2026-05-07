import type { SessionConfigOption, SessionNotification } from "@agentclientprotocol/sdk";
import { LLMock } from "@copilotkit/aimock";
import { getModel } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
	createBodhiPiAgent,
	createInMemoryFilesystem,
	createInMemorySessionStore,
	type SessionStore,
} from "../src/index.js";
import { createInProcessAcpPair } from "./helpers/in-process-connection.js";

type SelectOption = SessionConfigOption & { type: "select" };

function chunkedAgentText(updates: SessionNotification[]): string {
	return updates
		.filter((u) => u.update.sessionUpdate === "agent_message_chunk")
		.map((u) => {
			const content = (u.update as { content: { type: string; text?: string } }).content;
			return content.type === "text" ? (content.text ?? "") : "";
		})
		.join("");
}

function userChunkText(updates: SessionNotification[]): string {
	return updates
		.filter((u) => u.update.sessionUpdate === "user_message_chunk")
		.map((u) => {
			const content = (u.update as { content: { type: string; text?: string } }).content;
			return content.type === "text" ? (content.text ?? "") : "";
		})
		.join("");
}

function asSelectOption(opt: SessionConfigOption | undefined): SelectOption {
	expect(opt, "expected a SessionConfigOption").toBeDefined();
	expect(opt?.type).toBe("select");
	return opt as SelectOption;
}

let mocks: LLMock[] = [];

beforeEach(() => {
	mocks = [];
});

afterEach(async () => {
	await Promise.all(mocks.map((m) => m.stop()));
	mocks = [];
});

async function startMock(): Promise<LLMock> {
	const mock = new LLMock({ port: 0 });
	await mock.start();
	mocks.push(mock);
	return mock;
}

const stdInitParams = {
	protocolVersion: 1,
	clientCapabilities: {
		fs: { readTextFile: false, writeTextFile: false },
		terminal: false,
	},
} as const;

interface ClientHarness {
	clientConn: ReturnType<typeof createInProcessAcpPair>["clientConn"];
	updates: SessionNotification[];
}

function makeClient(opts: {
	models: Parameters<typeof createBodhiPiAgent>[0]["models"];
	defaultModelId: string;
	getApiKey?: (p: string) => string | undefined;
	sessionStore: SessionStore;
}): ClientHarness {
	const updates: SessionNotification[] = [];
	const { clientConn } = createInProcessAcpPair(
		createBodhiPiAgent({
			models: opts.models,
			defaultModelId: opts.defaultModelId,
			getApiKey: opts.getApiKey ?? (() => "test-key"),
			sessionStore: opts.sessionStore,
			filesystem: createInMemoryFilesystem(),
		}),
		() => ({
			sessionUpdate: async (params) => {
				updates.push(params);
			},
			requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
		}),
	);
	return { clientConn, updates };
}

test("simple chat round-trips via ACP through aimock", async () => {
	const mock = await startMock();
	mock.onMessage(/Monday/i, { content: "tuesday" });

	const baseModel = getModel("openai", "gpt-5-mini");
	const { clientConn, updates } = makeClient({
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

	const { clientConn, updates } = makeClient({
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

	const writer = makeClient({
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
	const reader = makeClient({
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
	const { clientConn } = makeClient({
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

	const { clientConn, updates } = makeClient({
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

	const writer = makeClient({
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
	const reader = makeClient({
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

	const writer = makeClient({
		models: [{ ...baseModel, baseUrl: `${mock.url}/v1` }],
		defaultModelId: baseModel.id,
		sessionStore: store,
	});
	await writer.clientConn.initialize(stdInitParams);
	const { sessionId } = await writer.clientConn.newSession({ cwd, mcpServers: [] });
	await writer.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "first" }] });

	const reader = makeClient({
		models: [{ ...baseModel, baseUrl: `${mock.url}/v1` }],
		defaultModelId: baseModel.id,
		sessionStore: store,
	});
	await reader.clientConn.initialize(stdInitParams);

	const resumeResult = await reader.clientConn.resumeSession({ sessionId, cwd, mcpServers: [] });
	const resumedOption = asSelectOption(resumeResult.configOptions?.[0]);
	expect(resumedOption.currentValue).toBe(baseModel.id);

	// Critical contrast vs loadSession: NO history replay notifications.
	expect(reader.updates).toHaveLength(0);

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

	const { clientConn } = makeClient({
		models: [{ ...baseModel, baseUrl: `${mock.url}/v1` }],
		defaultModelId: baseModel.id,
		sessionStore: store,
	});
	const initResult = await clientConn.initialize(stdInitParams);
	expect(initResult.agentCapabilities?._meta).toMatchObject({
		"bodhi-pi": { sessionDelete: true },
	});

	const { sessionId } = await clientConn.newSession({ cwd, mcpServers: [] });
	await clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "x" }] });

	await clientConn.extMethod("_bodhi-pi/session/delete", { sessionId });

	expect(await store.load(sessionId)).toBeUndefined();
	const list = await clientConn.listSessions({});
	expect(list.sessions.some((s: { sessionId: string }) => s.sessionId === sessionId)).toBe(false);

	await expect(clientConn.loadSession({ sessionId, cwd, mcpServers: [] })).rejects.toThrow(/unknown session/);
});
