import type { AgentEndEvent, AgentStartEvent, BodhiPiEvent, MessageUpdateEvent } from "@bodhiapp/bodhi-pi";
import { getModel } from "@earendil-works/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { type CliTestHarness, createCliTestHarness } from "@test/helpers/cli-harness.js";
import { recorder } from "@test/helpers/event-recorder.js";
import { afterEach, beforeEach, expect, test } from "vitest";

const OPENAI_KEY = process.env.OPENAI_API_KEY!;

let harness: CliTestHarness;
let eventLog: BodhiPiEvent[];

beforeEach(async () => {
	const rec = recorder();
	eventLog = rec.log;
	harness = await createCliTestHarness({
		model: getModel("openai", "gpt-4o-mini"),
		apiKey: OPENAI_KEY,
		eventHandlers: rec.handlers,
	});
});

afterEach(async () => {
	await harness.cleanup();
});

test("CLI host emits the full event sequence around a real LLM turn", async () => {
	await harness.client.initialize(stdInitParams);
	const { sessionId } = await harness.client.newSession({ cwd: harness.tmpDir, mcpServers: [] });

	const result = await harness.client.prompt({
		sessionId,
		prompt: [{ type: "text", text: "Reply with exactly one word: hello" }],
	});

	expect(result.stopReason).toBe("end_turn");

	// Coarse-grained ordering: every event type the recorder watches should appear
	// at least once across the run. The recorder covers the full 19-event contract,
	// so a regression where a host stops forwarding any event type is caught here.
	const types = eventLog.map((e) => e.type);
	for (const required of [
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
		"before_provider_request",
		"after_provider_response",
	] as const) {
		expect(types, `event ${required} should fire at least once`).toContain(required);
	}

	const start = eventLog.find((e): e is AgentStartEvent => e.type === "agent_start");
	const end = eventLog.find((e): e is AgentEndEvent => e.type === "agent_end");
	expect(start?.userPrompt).toContain("hello");
	expect(end?.stopReason).toBe("end_turn");

	// Streaming proof: the assistant message should arrive in deltas, not as a
	// single end-of-turn dump. At least one `message_update` carries a `text_delta`.
	const updates = eventLog.filter((e): e is MessageUpdateEvent => e.type === "message_update");
	const textDeltas = updates.filter((u) => u.assistantMessageEvent.type === "text_delta");
	expect(textDeltas.length, "at least one text_delta indicates streaming").toBeGreaterThan(0);
});
