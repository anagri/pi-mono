import {
	type Context,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	registerFauxProvider,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test } from "vitest";
import { EXT_SESSION_TREE } from "@/wire/constants.js";
import { stdInitParams } from "./helpers/acp-constants.js";
import { createTestHarness } from "./helpers/harness.js";

let providers: FauxProviderRegistration[] = [];

beforeEach(() => {
	providers = [];
});

afterEach(() => {
	for (const p of providers) p.unregister();
	providers = [];
});

function newProvider(): FauxProviderRegistration {
	const p = registerFauxProvider();
	providers.push(p);
	return p;
}

/**
 * The faux model's default contextWindow is large; override per-test by
 * cloning the registered model and shrinking it. Auto-compact triggers when
 * contextTokens > contextWindow - reserveTokens.
 */
function rigUsage(totalTokens: number) {
	return (_ctx: Context) => {
		const msg = fauxAssistantMessage("ok");
		return {
			...msg,
			usage: {
				input: Math.floor(totalTokens / 2),
				output: Math.floor(totalTokens / 2),
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
	};
}

test("auto-compact fires after agent_end when usage exceeds contextWindow - reserveTokens", async () => {
	const faux = newProvider();
	const baseModel = faux.getModel();
	const tinyModel = { ...baseModel, contextWindow: 1000 };

	// Order: first response (large usage that exceeds threshold) → triggers compaction;
	// the auto-compact path then makes a fresh provider call for summarization.
	faux.setResponses([rigUsage(1500), fauxAssistantMessage("## Goal\nrigged-summary-text")]);

	const { clientConn } = createTestHarness({
		models: [tinyModel],
		defaultModelId: tinyModel.id,
		// reserveTokens is the slack we keep; threshold = contextWindow - reserveTokens.
		// 1000 - 100 = 900; the rigged usage of 1500 exceeds it.
		compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 30 },
	});

	await clientConn.initialize(stdInitParams);
	const { sessionId } = await clientConn.newSession({ cwd: process.cwd(), mcpServers: [] });

	await clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "hello" }] });

	const tree = (await clientConn.extMethod(EXT_SESSION_TREE, { sessionId })) as {
		nodes: { id: string; type: string }[];
	};
	const compactionNodes = tree.nodes.filter((n) => n.type === "compaction");
	expect(compactionNodes.length).toBe(1);
});

test("auto-compact is skipped when settings.enabled is false", async () => {
	const faux = newProvider();
	const baseModel = faux.getModel();
	const tinyModel = { ...baseModel, contextWindow: 1000 };

	faux.setResponses([rigUsage(1500)]);

	const { clientConn } = createTestHarness({
		models: [tinyModel],
		defaultModelId: tinyModel.id,
		compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 30 },
	});

	await clientConn.initialize(stdInitParams);
	const { sessionId } = await clientConn.newSession({ cwd: process.cwd(), mcpServers: [] });

	await clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "hello" }] });

	const tree = (await clientConn.extMethod(EXT_SESSION_TREE, { sessionId })) as {
		nodes: { type: string }[];
	};
	expect(tree.nodes.find((n) => n.type === "compaction")).toBeUndefined();
});

test("auto-compact is skipped when usage is below threshold", async () => {
	const faux = newProvider();
	const baseModel = faux.getModel();
	const tinyModel = { ...baseModel, contextWindow: 1000 };

	faux.setResponses([rigUsage(50)]);

	const { clientConn } = createTestHarness({
		models: [tinyModel],
		defaultModelId: tinyModel.id,
		compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 30 },
	});

	await clientConn.initialize(stdInitParams);
	const { sessionId } = await clientConn.newSession({ cwd: process.cwd(), mcpServers: [] });

	await clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "hello" }] });

	const tree = (await clientConn.extMethod(EXT_SESSION_TREE, { sessionId })) as {
		nodes: { type: string }[];
	};
	expect(tree.nodes.find((n) => n.type === "compaction")).toBeUndefined();
});
