import { LLMock } from "@copilotkit/aimock";
import { type FauxProviderRegistration, getModel } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, expect, test } from "vitest";
import { EXT_SESSION_ENTRIES, EXT_SESSION_NAVIGATE, EXT_SESSION_TREE } from "@/acp/constants.js";
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

test(`${EXT_SESSION_TREE} returns all entries with leaf marker`, async () => {
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
	await clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "again" }] });

	const tree = (await clientConn.extMethod(EXT_SESSION_TREE, { sessionId })) as {
		leafId: string;
		nodes: { id: string; parentId: string | null; type: string; isLeaf: boolean; childCount: number }[];
	};
	expect(tree.nodes.length).toBeGreaterThan(0);
	const leafNodes = tree.nodes.filter((n) => n.isLeaf);
	expect(leafNodes).toHaveLength(1);
	expect(leafNodes[0].id).toBe(tree.leafId);
});

test(`${EXT_SESSION_NAVIGATE} moves the leaf; subsequent prompts branch from the new leaf`, async () => {
	const mock = await startMock();
	mock.onMessage(/first/i, { content: "first-reply" });
	mock.onMessage(/second/i, { content: "second-reply" });
	mock.onMessage(/branch/i, { content: "branch-reply" });

	const baseModel = getModel("openai", "gpt-5-mini");
	const { clientConn } = createTestHarness({
		models: [{ ...baseModel, baseUrl: `${mock.url}/v1` }],
		defaultModelId: baseModel.id,
	});

	await clientConn.initialize(stdInitParams);
	const { sessionId } = await clientConn.newSession({ cwd: process.cwd(), mcpServers: [] });

	await clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "first turn" }] });
	await clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "second turn" }] });

	const entries = (await clientConn.extMethod(EXT_SESSION_ENTRIES, { sessionId })) as {
		entries: { id: string; role: string; preview: string }[];
	};
	const firstUserId = entries.entries.find((e) => e.role === "user" && e.preview.toLowerCase().includes("first"))?.id;
	expect(typeof firstUserId).toBe("string");

	const nav = (await clientConn.extMethod(EXT_SESSION_NAVIGATE, {
		sessionId,
		targetEntryId: firstUserId,
	})) as { leafId: string };
	expect(nav.leafId).toBe(firstUserId);

	await clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "branch turn" }] });

	const afterEntries = (await clientConn.extMethod(EXT_SESSION_ENTRIES, { sessionId })) as {
		entries: { id: string; role: string; preview: string }[];
	};
	const previews = afterEntries.entries.map((e) => e.preview.toLowerCase());
	expect(previews.some((p) => p.includes("first"))).toBe(true);
	expect(previews.some((p) => p.includes("branch"))).toBe(true);
	expect(previews.some((p) => p.includes("second"))).toBe(false);
});

test(`${EXT_SESSION_NAVIGATE} fails fast on unknown sessionId or targetEntryId`, async () => {
	const baseModel = getModel("openai", "gpt-5-mini");
	const { clientConn } = createTestHarness({
		models: [baseModel],
		defaultModelId: baseModel.id,
	});

	await clientConn.initialize(stdInitParams);
	const { sessionId } = await clientConn.newSession({ cwd: process.cwd(), mcpServers: [] });

	await expect(
		clientConn.extMethod(EXT_SESSION_NAVIGATE, { sessionId: "missing", targetEntryId: "x" }),
	).rejects.toThrow();
	await expect(clientConn.extMethod(EXT_SESSION_NAVIGATE, { sessionId, targetEntryId: "missing" })).rejects.toThrow();
});
