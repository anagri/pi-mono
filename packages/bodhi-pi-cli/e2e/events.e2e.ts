import type { AgentEndEvent, AgentStartEvent, BodhiPiEvent, BodhiPiEventHandlers } from "@bodhiapp/bodhi-pi";
import { getModel } from "@mariozechner/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { type CliTestHarness, createCliTestHarness } from "@test/helpers/cli-harness.js";
import { afterEach, beforeEach, expect, test } from "vitest";

const OPENAI_KEY = process.env.OPENAI_API_KEY!;

let harness: CliTestHarness;
let eventLog: BodhiPiEvent[];

beforeEach(async () => {
	eventLog = [];
	const push = (e: BodhiPiEvent) => void eventLog.push(e);
	const handlers: BodhiPiEventHandlers = {
		session_start: [push],
		agent_start: [push],
		agent_end: [push],
		turn_start: [push],
		turn_end: [push],
		message_start: [push],
		message_end: [push],
		input: [push],
		before_agent_start: [push],
		before_provider_request: [push],
		after_provider_response: [push],
	};
	harness = await createCliTestHarness({
		model: getModel("openai", "gpt-4o-mini"),
		apiKey: OPENAI_KEY,
		eventHandlers: handlers,
	});
});

afterEach(async () => {
	await harness.cleanup();
});

test("CLI host emits the full event sequence around a real LLM turn", async () => {
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: harness.tmpDir, mcpServers: [] });

	const result = await harness.clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: "Reply with exactly one word: hello" }],
	});

	expect(result.stopReason).toBe("end_turn");

	const types = eventLog.map((e) => e.type);
	expect(types).toContain("session_start");
	expect(types).toContain("input");
	expect(types).toContain("before_agent_start");
	expect(types).toContain("agent_start");
	expect(types).toContain("turn_start");
	expect(types).toContain("turn_end");
	expect(types).toContain("agent_end");
	expect(types).toContain("before_provider_request");
	expect(types).toContain("after_provider_response");

	const start = eventLog.find((e): e is AgentStartEvent => e.type === "agent_start");
	const end = eventLog.find((e): e is AgentEndEvent => e.type === "agent_end");
	expect(start?.userPrompt).toContain("hello");
	expect(end?.stopReason).toBe("end_turn");
});
