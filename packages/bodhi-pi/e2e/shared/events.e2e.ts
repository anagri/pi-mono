import { getModel } from "@earendil-works/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { afterEach, expect, test } from "vitest";
import type {
	AfterProviderResponseEvent,
	AgentEndEvent,
	AgentStartEvent,
	BeforeProviderRequestEvent,
	MessageUpdateEvent,
	ToolCallEvent,
	ToolExecutionEndEvent,
} from "@/index.js";
import { expectSubsequence } from "../helpers/events-assert.js";
import { createE2EHarness, type E2EHarness } from "../helpers/harness.js";

// Lifecycle-event coverage across the two distinct shapes: a plain text turn
// and a tool-using turn. Both share the same gpt-4o-mini setup; one harness,
// two prompts back-to-back, with `harness.events` reset between so the
// subsequence assertion runs against a clean slate per turn.

let activeHarness: E2EHarness | undefined;

afterEach(async () => {
	if (activeHarness) {
		await activeHarness.cleanup();
		activeHarness = undefined;
	}
});

test("events: text turn + tool turn fire the expected sequences and payloads", async () => {
	const model = getModel("openai", "gpt-4o-mini");
	const apiKey = process.env.OPENAI_API_KEY!;
	const h = await createE2EHarness({
		models: [model],
		defaultModelId: model.id,
		getApiKey: (p) => (p === "openai" ? apiKey : undefined),
	});
	activeHarness = h;

	// Step-2 seed (tool turn reads proj/README.md). Seeded up-front because
	// the harness forbids in-session writes — uniform Option B across runtimes.
	await h.setupFiles({
		"proj/README.md": "# project readme\n\nhello world",
	});

	await h.clientConn.initialize(stdInitParams);

	// Step 1: plain text turn — full lifecycle sequence + per-event payload checks.
	const { sessionId: sidText } = await h.clientConn.newSession({ cwd: h.cwd, mcpServers: [] });
	const textResult = await h.clientConn.prompt({
		sessionId: sidText,
		prompt: [{ type: "text", text: "Answer in one word: what day comes after Monday?" }],
	});
	expect.soft(textResult.stopReason).toBe("end_turn");
	await h.flushEvents();

	{
		const types = h.events.map((e) => e.type);
		expectSubsequence(types, [
			"session_start",
			"input",
			"before_agent_start",
			"agent_start",
			"turn_start",
			"message_start",
			"message_update",
			"message_end",
			"turn_end",
			"agent_end",
		]);

		const start = h.events.find((e): e is AgentStartEvent => e.type === "agent_start");
		const end = h.events.find((e): e is AgentEndEvent => e.type === "agent_end");
		expect.soft(start?.userPrompt).toMatch(/Monday/);
		expect.soft(start?.sessionId).toBe(sidText);
		expect.soft(end?.stopReason).toBe("end_turn");
		expect.soft(end?.sessionId).toBe(sidText);

		const updates = h.events.filter((e): e is MessageUpdateEvent => e.type === "message_update");
		const textDeltas = updates.filter((u) => u.assistantMessageEvent.type === "text_delta");
		expect.soft(textDeltas.length, "at least one text_delta indicates streaming").toBeGreaterThan(0);

		const req = h.events.find((e): e is BeforeProviderRequestEvent => e.type === "before_provider_request");
		const res = h.events.find((e): e is AfterProviderResponseEvent => e.type === "after_provider_response");
		expect.soft(req?.provider).toBe("openai");
		expect.soft(req?.modelId).toBe(model.id);
		expect.soft(res?.status).toBe(200);
	}

	// Reset between turns so the next subsequence assertion runs against a
	// clean slate. Within a single channel events arrive in order, so clearing
	// the snapshot is safe — the next prompt produces its own complete sequence.
	h.events.length = 0;

	// Step 2: tool turn — tool_execution_* brackets, tool_call/tool_result hooks inside.
	const { sessionId: sidTool } = await h.clientConn.newSession({ cwd: `${h.cwd}/proj`, mcpServers: [] });
	const toolResult = await h.clientConn.prompt({
		sessionId: sidTool,
		prompt: [
			{
				type: "text",
				text: `Read the file ${h.cwd}/proj/README.md and tell me what's in it. You must use the read tool.`,
			},
		],
	});
	expect.soft(toolResult.stopReason).toBe("end_turn");
	await h.flushEvents();

	{
		const types = h.events.map((e) => e.type);
		// Per agent.ts emit order: tool_execution_start brackets the call; the
		// mutable tool_call / tool_result hooks fire inside that bracket; the
		// call closes with tool_execution_end.
		expectSubsequence(types, ["tool_execution_start", "tool_call", "tool_result", "tool_execution_end"]);

		const callEv = h.events.find((e): e is ToolCallEvent => e.type === "tool_call");
		const execEnd = h.events.find((e): e is ToolExecutionEndEvent => e.type === "tool_execution_end");
		expect.soft(callEv?.toolName).toBe("read");
		expect.soft(execEnd?.toolName).toBe("read");
		expect.soft(execEnd?.isError).toBe(false);
	}
});
