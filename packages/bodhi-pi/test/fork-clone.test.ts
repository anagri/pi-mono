import { LLMock } from "@copilotkit/aimock";
import { type FauxProviderRegistration, getModel } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, expect, test } from "vitest";
import { EXT_SESSION_CLONE, EXT_SESSION_ENTRIES, EXT_SESSION_FORK } from "@/acp/constants.js";
import { stdInitParams } from "./helpers/acp-constants.js";
import { createTestHarness } from "./helpers/harness.js";

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

test(`${EXT_SESSION_FORK} (position=before) returns selectedText and a new session whose history excludes the forked turn`, async () => {
	const mock = await startMock();
	mock.onMessage(/Monday/i, { content: "tuesday" });
	mock.onMessage(/Tuesday/i, { content: "wednesday" });
	mock.onMessage(/Wednesday/i, { content: "thursday" });

	const baseModel = getModel("openai", "gpt-5-mini");
	const { clientConn, updates } = createTestHarness({
		models: [{ ...baseModel, baseUrl: `${mock.url}/v1` }],
		defaultModelId: baseModel.id,
	});

	await clientConn.initialize(stdInitParams);
	const { sessionId } = await clientConn.newSession({ cwd: process.cwd(), mcpServers: [] });

	await clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "what comes after Monday?" }] });
	await clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "and after Tuesday?" }] });
	await clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "and after Wednesday?" }] });

	const entriesResp = (await clientConn.extMethod(EXT_SESSION_ENTRIES, { sessionId })) as {
		entries: { id: string; role: string; preview: string }[];
	};
	const userEntries = entriesResp.entries.filter((e) => e.role === "user");
	expect(userEntries.length).toBe(3);
	const forkAt = userEntries[2];
	expect(forkAt.preview).toContain("after Wednesday");

	const result = (await clientConn.extMethod(EXT_SESSION_FORK, {
		sessionId,
		entryId: forkAt.id,
		position: "before",
	})) as { newSessionId: string; selectedText?: string };
	expect(typeof result.newSessionId).toBe("string");
	expect(result.newSessionId).not.toBe(sessionId);
	expect(result.selectedText).toContain("after Wednesday");

	const forkedEntries = (await clientConn.extMethod(EXT_SESSION_ENTRIES, {
		sessionId: result.newSessionId,
	})) as { entries: { id: string; role: string; preview: string }[] };
	const forkedUsers = forkedEntries.entries.filter((e) => e.role === "user");
	expect(forkedUsers.length).toBe(2);
	expect(forkedEntries.entries.find((e) => e.id === forkAt.id)).toBeUndefined();
	void updates;
});

test(`${EXT_SESSION_CLONE} duplicates the full chain at the current leaf`, async () => {
	const mock = await startMock();
	mock.onMessage(/Monday/i, { content: "tuesday" });
	mock.onMessage(/Tuesday/i, { content: "wednesday" });

	const baseModel = getModel("openai", "gpt-5-mini");
	const { clientConn } = createTestHarness({
		models: [{ ...baseModel, baseUrl: `${mock.url}/v1` }],
		defaultModelId: baseModel.id,
	});

	await clientConn.initialize(stdInitParams);
	const { sessionId } = await clientConn.newSession({ cwd: process.cwd(), mcpServers: [] });

	await clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "what comes after Monday?" }] });
	await clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "and after Tuesday?" }] });

	const original = (await clientConn.extMethod(EXT_SESSION_ENTRIES, { sessionId })) as {
		entries: { id: string }[];
	};
	const originalCount = original.entries.length;

	const result = (await clientConn.extMethod(EXT_SESSION_CLONE, { sessionId })) as { newSessionId: string };
	expect(typeof result.newSessionId).toBe("string");
	expect(result.newSessionId).not.toBe(sessionId);

	const cloned = (await clientConn.extMethod(EXT_SESSION_ENTRIES, { sessionId: result.newSessionId })) as {
		entries: { id: string }[];
	};
	expect(cloned.entries.length).toBe(originalCount);
});

test(`${EXT_SESSION_FORK} fails fast on unknown sessionId or entryId`, async () => {
	const baseModel = getModel("openai", "gpt-5-mini");
	const { clientConn } = createTestHarness({
		models: [baseModel],
		defaultModelId: baseModel.id,
	});

	await clientConn.initialize(stdInitParams);
	const { sessionId } = await clientConn.newSession({ cwd: process.cwd(), mcpServers: [] });

	await expect(clientConn.extMethod(EXT_SESSION_FORK, { sessionId: "missing", entryId: "x" })).rejects.toThrow();
	await expect(clientConn.extMethod(EXT_SESSION_FORK, { sessionId, entryId: "missing" })).rejects.toThrow();
});
