import { LLMock } from "@copilotkit/aimock";
import { type FauxProviderRegistration, getModel } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, expect, test } from "vitest";
import { EXT_SESSION_COMPACT } from "@/acp/constants.js";
import { createInMemorySessionStore } from "@/index.js";
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

test(`${EXT_SESSION_COMPACT} writes a CompactionEntry and rewrites in-memory messages`, async () => {
	const mock = await startMock();
	// Standard chat replies
	mock.onMessage(/Monday/i, { content: "tuesday" });
	mock.onMessage(/Tuesday/i, { content: "wednesday" });
	mock.onMessage(/Wednesday/i, { content: "thursday" });
	// Summarization request matches our SUMMARIZATION_PROMPT framing.
	mock.onMessage(/Goal/, { content: "## Goal\nrigged-summary-text" });

	const baseModel = getModel("openai", "gpt-5-mini");
	const sessionStore = createInMemorySessionStore();
	const { clientConn } = createTestHarness({
		models: [{ ...baseModel, baseUrl: `${mock.url}/v1` }],
		defaultModelId: baseModel.id,
		sessionStore,
	});

	await clientConn.initialize(stdInitParams);
	const { sessionId } = await clientConn.newSession({ cwd: process.cwd(), mcpServers: [] });

	await clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: "Answer in one word: what day comes after Monday?" }],
	});
	await clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: "What about after Tuesday?" }],
	});
	await clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: "And after Wednesday?" }],
	});

	const beforeRecord = await sessionStore.load(sessionId);
	expect(beforeRecord).toBeDefined();
	const beforeEntries = beforeRecord!.entries;
	expect(beforeEntries.length).toBeGreaterThan(0);
	const beforeLeaf = beforeRecord!.leafId;

	const response = (await clientConn.extMethod(EXT_SESSION_COMPACT, { sessionId })) as {
		summary: string;
		firstKeptEntryId: string;
		tokensBefore: number;
	};
	expect(response.summary).toContain("rigged-summary-text");
	expect(typeof response.firstKeptEntryId).toBe("string");

	const afterRecord = await sessionStore.load(sessionId);
	expect(afterRecord).toBeDefined();
	const compactionEntries = afterRecord!.entries.filter((e) => e.type === "compaction");
	expect(compactionEntries).toHaveLength(1);
	const compaction = compactionEntries[0];
	expect(compaction.type === "compaction" ? compaction.summary : "").toContain("rigged-summary-text");
	expect(afterRecord!.leafId).toBe(compaction.id);
	expect(compaction.parentId).toBe(beforeLeaf);
});

test(`${EXT_SESSION_COMPACT} fails fast when session is not loaded`, async () => {
	const baseModel = getModel("openai", "gpt-5-mini");
	const sessionStore = createInMemorySessionStore();
	const { clientConn } = createTestHarness({
		models: [baseModel],
		defaultModelId: baseModel.id,
		sessionStore,
	});

	await clientConn.initialize(stdInitParams);

	await expect(clientConn.extMethod(EXT_SESSION_COMPACT, { sessionId: "does-not-exist" })).rejects.toThrow(
		/not loaded/,
	);
});

test(`${EXT_SESSION_COMPACT} rejects empty sessions with a clear error`, async () => {
	const baseModel = getModel("openai", "gpt-5-mini");
	const sessionStore = createInMemorySessionStore();
	const { clientConn } = createTestHarness({
		models: [baseModel],
		defaultModelId: baseModel.id,
		sessionStore,
	});

	await clientConn.initialize(stdInitParams);
	const { sessionId } = await clientConn.newSession({ cwd: process.cwd(), mcpServers: [] });
	await expect(clientConn.extMethod(EXT_SESSION_COMPACT, { sessionId })).rejects.toThrow(/nothing to compact/);
});
