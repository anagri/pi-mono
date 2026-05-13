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

let activeHarness: E2EHarness | undefined;

afterEach(async () => {
	if (activeHarness) {
		await activeHarness.cleanup();
		activeHarness = undefined;
	}
});

test("real LLM (gpt-4o-mini) fires the full event sequence around a single text turn", async () => {
	const model = getModel("openai", "gpt-4o-mini");
	const apiKey = process.env.OPENAI_API_KEY!;
	const h = await createE2EHarness({
		models: [model],
		defaultModelId: model.id,
		getApiKey: (p) => (p === "openai" ? apiKey : undefined),
	});
	activeHarness = h;

	await h.clientConn.initialize(stdInitParams);
	const { sessionId } = await h.clientConn.newSession({ cwd: h.cwd, mcpServers: [] });
	const result = await h.clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: "Answer in one word: what day comes after Monday?" }],
	});

	expect(result.stopReason).toBe("end_turn");
	await h.flushEvents();

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
	expect(start, "agent_start present").toBeDefined();
	expect(end, "agent_end present").toBeDefined();
	expect(start?.userPrompt).toMatch(/Monday/);
	expect(start?.sessionId).toBe(sessionId);
	expect(end?.stopReason).toBe("end_turn");
	expect(end?.sessionId).toBe(sessionId);

	const updates = h.events.filter((e): e is MessageUpdateEvent => e.type === "message_update");
	const textDeltas = updates.filter((u) => u.assistantMessageEvent.type === "text_delta");
	expect(textDeltas.length, "at least one text_delta indicates streaming").toBeGreaterThan(0);

	const req = h.events.find((e): e is BeforeProviderRequestEvent => e.type === "before_provider_request");
	const res = h.events.find((e): e is AfterProviderResponseEvent => e.type === "after_provider_response");
	expect(req?.provider).toBe("openai");
	expect(req?.modelId).toBe(model.id);
	expect(res?.status).toBe(200);
});

test("real LLM tool turn (gpt-4o-mini) fires tool_call + tool_execution_* + tool_result", async () => {
	const model = getModel("openai", "gpt-4o-mini");
	const apiKey = process.env.OPENAI_API_KEY!;
	const h = await createE2EHarness({
		models: [model],
		defaultModelId: model.id,
		getApiKey: (p) => (p === "openai" ? apiKey : undefined),
	});
	activeHarness = h;

	await h.filesystem.mkdir(`${h.cwd}/proj`, { recursive: true });
	await h.filesystem.writeTextFile(`${h.cwd}/proj/README.md`, "# project readme\n\nhello world");

	await h.clientConn.initialize(stdInitParams);
	const { sessionId } = await h.clientConn.newSession({ cwd: `${h.cwd}/proj`, mcpServers: [] });
	const result = await h.clientConn.prompt({
		sessionId,
		prompt: [
			{
				type: "text",
				text: `Read the file ${h.cwd}/proj/README.md and tell me what's in it. You must use the read tool.`,
			},
		],
	});

	expect(result.stopReason).toBe("end_turn");
	await h.flushEvents();

	const types = h.events.map((e) => e.type);
	// Per agent.ts emit order: tool_execution_start brackets the call; the
	// mutable tool_call / tool_result hooks fire inside that bracket; the call
	// closes with tool_execution_end.
	expectSubsequence(types, ["tool_execution_start", "tool_call", "tool_result", "tool_execution_end"]);

	const callEv = h.events.find((e): e is ToolCallEvent => e.type === "tool_call");
	const execEnd = h.events.find((e): e is ToolExecutionEndEvent => e.type === "tool_execution_end");
	expect(callEv, "tool_call present").toBeDefined();
	expect(execEnd, "tool_execution_end present").toBeDefined();
	expect(callEv?.toolName).toBe("read");
	expect(execEnd?.toolName).toBe("read");
	expect(execEnd?.isError).toBe(false);
});
