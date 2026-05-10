import { LLMock } from "@copilotkit/aimock";
import { type FauxProviderRegistration, getModel } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, expect, test } from "vitest";
import { EXT_SESSION_EXPORT, EXT_SESSION_SET_NAME, EXT_SESSION_STATS } from "@/acp/constants.js";
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

test(`${EXT_SESSION_SET_NAME} writes a session_info entry; ${EXT_SESSION_STATS} surfaces it as name`, async () => {
	const mock = await startMock();
	mock.onMessage(/.*/, { content: "ok" });

	const baseModel = getModel("openai", "gpt-5-mini");
	const { clientConn } = createTestHarness({
		models: [{ ...baseModel, baseUrl: `${mock.url}/v1` }],
		defaultModelId: baseModel.id,
	});

	await clientConn.initialize(stdInitParams);
	const { sessionId } = await clientConn.newSession({ cwd: process.cwd(), mcpServers: [] });
	await clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "hello" }] });

	const setName = (await clientConn.extMethod(EXT_SESSION_SET_NAME, {
		sessionId,
		name: "my-session",
	})) as { ok: true; name: string };
	expect(setName.ok).toBe(true);
	expect(setName.name).toBe("my-session");

	const stats = (await clientConn.extMethod(EXT_SESSION_STATS, { sessionId })) as {
		messageCount: number;
		toolCallCount: number;
		leafId: string;
		name?: string;
	};
	expect(stats.name).toBe("my-session");
	expect(stats.messageCount).toBeGreaterThanOrEqual(2);
	expect(typeof stats.leafId).toBe("string");
});

test(`${EXT_SESSION_EXPORT} returns JSONL with header + entries on the active branch`, async () => {
	const mock = await startMock();
	mock.onMessage(/.*/, { content: "ok" });

	const baseModel = getModel("openai", "gpt-5-mini");
	const { clientConn } = createTestHarness({
		models: [{ ...baseModel, baseUrl: `${mock.url}/v1` }],
		defaultModelId: baseModel.id,
	});

	await clientConn.initialize(stdInitParams);
	const { sessionId } = await clientConn.newSession({ cwd: process.cwd(), mcpServers: [] });
	await clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "hello" }] });

	const result = (await clientConn.extMethod(EXT_SESSION_EXPORT, { sessionId })) as {
		format: string;
		content: string;
	};
	expect(result.format).toBe("jsonl");
	const lines = result.content.split("\n").filter((l) => l.length > 0);
	expect(lines.length).toBeGreaterThanOrEqual(2);
	const header = JSON.parse(lines[0]) as { type: string; id: string; cwd: string };
	expect(header.type).toBe("session");
	expect(header.id).toBe(sessionId);
	const userEntry = lines
		.slice(1)
		.map((l) => JSON.parse(l))
		.find((e) => e.type === "message" && e.message?.role === "user");
	expect(userEntry).toBeDefined();
});

test(`${EXT_SESSION_SET_NAME} fails fast on unloaded session`, async () => {
	const baseModel = getModel("openai", "gpt-5-mini");
	const { clientConn } = createTestHarness({
		models: [baseModel],
		defaultModelId: baseModel.id,
	});

	await clientConn.initialize(stdInitParams);
	await expect(clientConn.extMethod(EXT_SESSION_SET_NAME, { sessionId: "missing", name: "x" })).rejects.toThrow();
});
