import {
	type AssistantMessage,
	type Context,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	registerFauxProvider,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test } from "vitest";
import { EXT_SESSION_TREE } from "@/acp/constants.js";
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

/** Faux response: assistant message with stopReason=error and an overflow-pattern errorMessage. */
function overflowResponse(): (ctx: Context) => AssistantMessage {
	return () => {
		const m = fauxAssistantMessage("");
		return {
			...m,
			stopReason: "error",
			errorMessage: "prompt is too long: 213462 tokens > 200000 maximum",
		};
	};
}

test("overflow on first attempt → auto-compact + retry succeeds; CompactionEntry appended", async () => {
	const faux = newProvider();
	const baseModel = faux.getModel();
	const tinyModel = { ...baseModel, contextWindow: 200000 };

	// 1) overflow → 2) summarize call → 3) successful retry.
	faux.setResponses([
		overflowResponse(),
		fauxAssistantMessage("## Goal\nrigged-summary"),
		fauxAssistantMessage("recovered"),
	]);

	const { clientConn } = createTestHarness({
		models: [tinyModel],
		defaultModelId: tinyModel.id,
	});

	await clientConn.initialize(stdInitParams);
	const { sessionId } = await clientConn.newSession({ cwd: process.cwd(), mcpServers: [] });

	const result = await clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: "first turn" }],
	});
	expect(result.stopReason).toBe("end_turn");

	const tree = (await clientConn.extMethod(EXT_SESSION_TREE, { sessionId })) as {
		nodes: { type: string }[];
	};
	expect(tree.nodes.filter((n) => n.type === "compaction").length).toBe(1);
});

test("a non-overflow error is NOT recovered — propagates to the caller", async () => {
	const faux = newProvider();
	const baseModel = faux.getModel();
	const model = { ...baseModel, contextWindow: 200000 };

	faux.setResponses([
		() => {
			const m = fauxAssistantMessage("");
			return { ...m, stopReason: "error", errorMessage: "rate limit exceeded; please retry" };
		},
	]);

	const { clientConn } = createTestHarness({
		models: [model],
		defaultModelId: model.id,
	});

	await clientConn.initialize(stdInitParams);
	const { sessionId } = await clientConn.newSession({ cwd: process.cwd(), mcpServers: [] });

	await expect(clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "first turn" }] })).rejects.toThrow(
		/rate limit/,
	);
});

test("a second overflow in the same prompt → fails (one-shot guard)", async () => {
	const faux = newProvider();
	const baseModel = faux.getModel();
	const model = { ...baseModel, contextWindow: 200000 };

	// 1) overflow → 2) summarize → 3) overflow again on retry.
	faux.setResponses([overflowResponse(), fauxAssistantMessage("## Goal\nrigged-summary"), overflowResponse()]);

	const { clientConn } = createTestHarness({
		models: [model],
		defaultModelId: model.id,
	});

	await clientConn.initialize(stdInitParams);
	const { sessionId } = await clientConn.newSession({ cwd: process.cwd(), mcpServers: [] });

	await expect(clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "first turn" }] })).rejects.toThrow(
		/prompt is too long/,
	);
});
