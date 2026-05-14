import { LLMock } from "@copilotkit/aimock";
import { type FauxProviderRegistration, getModel } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test } from "vitest";
import { EXT_SESSION_COMPACT } from "@/wire/constants.js";
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

test(`${EXT_SESSION_COMPACT} returns summary + firstKeptEntryId; post-compact prompt round-trips without error`, async () => {
	const mock = await startMock();
	mock.onMessage(/Monday/i, { content: "tuesday" });
	mock.onMessage(/Tuesday/i, { content: "wednesday" });
	mock.onMessage(/Wednesday/i, { content: "thursday" });
	mock.onMessage(/Goal/, { content: "## Goal\nrigged-summary-text" });
	mock.onMessage(/.*/, { content: "post-compact-reply" });

	const baseModel = getModel("openai", "gpt-5-mini");
	const { clientConn, updates } = createTestHarness({
		models: [{ ...baseModel, baseUrl: `${mock.url}/v1` }],
		defaultModelId: baseModel.id,
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

	const response = (await clientConn.extMethod(EXT_SESSION_COMPACT, { sessionId })) as {
		summary: string;
		firstKeptEntryId: string;
		tokensBefore: number;
	};
	expect(response.summary).toContain("rigged-summary-text");
	expect(typeof response.firstKeptEntryId).toBe("string");
	expect(typeof response.tokensBefore).toBe("number");

	updates.length = 0;
	const after = await clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: "anything else to add?" }],
	});
	expect(after.stopReason).toBe("end_turn");
	const text = updates
		.flatMap((u) => (u.update.sessionUpdate === "agent_message_chunk" ? [u.update.content] : []))
		.flatMap((c) => (c.type === "text" ? [c.text] : []))
		.join("");
	expect(text).toContain("post-compact-reply");
});

test(`${EXT_SESSION_COMPACT} fails fast when session is not loaded`, async () => {
	const baseModel = getModel("openai", "gpt-5-mini");
	const { clientConn } = createTestHarness({
		models: [baseModel],
		defaultModelId: baseModel.id,
	});

	await clientConn.initialize(stdInitParams);

	await expect(clientConn.extMethod(EXT_SESSION_COMPACT, { sessionId: "does-not-exist" })).rejects.toThrow(
		/not loaded/,
	);
});

test(`${EXT_SESSION_COMPACT} rejects empty sessions with a clear error`, async () => {
	const baseModel = getModel("openai", "gpt-5-mini");
	const { clientConn } = createTestHarness({
		models: [baseModel],
		defaultModelId: baseModel.id,
	});

	await clientConn.initialize(stdInitParams);
	const { sessionId } = await clientConn.newSession({ cwd: process.cwd(), mcpServers: [] });
	await expect(clientConn.extMethod(EXT_SESSION_COMPACT, { sessionId })).rejects.toThrow(/nothing to compact/);
});
