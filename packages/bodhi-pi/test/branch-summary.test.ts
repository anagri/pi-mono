import { LLMock } from "@copilotkit/aimock";
import { type FauxProviderRegistration, getModel } from "@earendil-works/pi-ai";
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

test("cross-branch /goto appends a branch_summary entry; /tree surfaces it on the new branch", async () => {
	const mock = await startMock();
	mock.onMessage(/Outcome/, { content: "rigged-branch-summary" });
	mock.onMessage(/.*/, { content: "ok" });

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
	expect(firstUserId).toBeDefined();

	await clientConn.extMethod(EXT_SESSION_NAVIGATE, { sessionId, targetEntryId: firstUserId });

	const tree = (await clientConn.extMethod(EXT_SESSION_TREE, { sessionId })) as {
		nodes: { id: string; type: string; isLeaf: boolean }[];
	};
	const branchSummaryNodes = tree.nodes.filter((n) => n.type === "branch_summary");
	expect(branchSummaryNodes.length).toBe(1);
	expect(branchSummaryNodes[0].isLeaf).toBe(true);
});

test("forward navigation (target descends from current leaf) does NOT generate a branch_summary", async () => {
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
	await clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "world" }] });

	const tree1 = (await clientConn.extMethod(EXT_SESSION_TREE, { sessionId })) as {
		leafId: string;
		nodes: { id: string; type: string }[];
	};
	const currentLeaf = tree1.leafId;

	// Self-navigate: target == current leaf is a no-op, no summary expected.
	await clientConn.extMethod(EXT_SESSION_NAVIGATE, { sessionId, targetEntryId: currentLeaf });

	const tree2 = (await clientConn.extMethod(EXT_SESSION_TREE, { sessionId })) as {
		nodes: { type: string }[];
	};
	expect(tree2.nodes.find((n) => n.type === "branch_summary")).toBeUndefined();
});
