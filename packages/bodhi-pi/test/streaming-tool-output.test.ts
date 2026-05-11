import {
	type Api,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	fauxToolCall,
	type Model,
	registerFauxProvider,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { ExtensionFactory } from "@/index.js";
import { stdInitParams } from "./helpers/acp-constants.js";
import { asRegistered } from "./helpers/extension-fixtures.js";
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
 * Streaming tool: emits two `onUpdate` partial results before returning,
 * proving that `tool_execution_update` events flow through the ACP
 * `tool_call_update.content` channel as in-progress notifications.
 */
const streamingTool: ExtensionFactory = (pi) => {
	pi.registerTool({
		name: "stream_demo",
		description: "Test-only tool: emits two partial results then completes.",
		parameters: Type.Object({}, { additionalProperties: true }),
		execute: async (_id, _params, _signal, onUpdate) => {
			onUpdate?.({ content: [{ type: "text", text: "chunk 1" }], details: {} });
			onUpdate?.({ content: [{ type: "text", text: "chunk 1 + chunk 2" }], details: {} });
			return {
				content: [{ type: "text", text: "chunk 1 + chunk 2 + final" }],
				details: {},
			};
		},
	});
};

test("tool_execution_update is forwarded to ACP as in_progress tool_call_update content", async () => {
	const faux = newProvider();
	const model = faux.getModel() as Model<Api>;
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("stream_demo", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	const harness = createTestHarness({
		models: [model],
		defaultModelId: model.id,
		extensionFactories: [asRegistered("stream-demo", streamingTool)],
	});

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "stream it" }] });

	const toolEvents = harness.updates
		.map((u) => u.update)
		.filter(
			(u): u is Extract<typeof u, { sessionUpdate: "tool_call" | "tool_call_update" }> =>
				u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update",
		);

	const startIdx = toolEvents.findIndex((e) => e.sessionUpdate === "tool_call");
	const completedIdx = toolEvents.findIndex((e) => e.sessionUpdate === "tool_call_update" && e.status === "completed");
	expect(startIdx).toBeGreaterThanOrEqual(0);
	expect(completedIdx).toBeGreaterThan(startIdx);

	const inProgress = toolEvents
		.slice(startIdx + 1, completedIdx)
		.filter((e) => e.sessionUpdate === "tool_call_update" && e.status === "in_progress");
	expect(inProgress.length).toBeGreaterThanOrEqual(2);

	// First in-progress carries the first chunk.
	const firstText = JSON.stringify(inProgress[0]);
	expect(firstText).toContain("chunk 1");

	// Final completed update carries the full result text.
	const completed = toolEvents[completedIdx];
	expect(JSON.stringify(completed)).toContain("chunk 1 + chunk 2 + final");
});
