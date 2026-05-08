import { getModel } from "@mariozechner/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { requireEnv } from "@test/helpers/env.js";
import { createTestHarness } from "@test/helpers/harness.js";
import { expect, test } from "vitest";
import {
	type AfterProviderResponseEvent,
	type AgentEndEvent,
	type AgentStartEvent,
	type BeforeProviderRequestEvent,
	type BodhiPiEvent,
	type BodhiPiEventHandlers,
	createInMemoryFilesystem,
	type ToolCallEvent,
	type ToolExecutionEndEvent,
} from "@/index.js";

function recorder() {
	const log: BodhiPiEvent[] = [];
	const push = (e: BodhiPiEvent) => void log.push(e);
	const handlers: BodhiPiEventHandlers = {
		session_start: [push],
		session_shutdown: [push],
		agent_start: [push],
		agent_end: [push],
		turn_start: [push],
		turn_end: [push],
		message_start: [push],
		message_end: [push],
		tool_execution_start: [push],
		tool_execution_end: [push],
		input: [push],
		before_agent_start: [push],
		before_provider_request: [push],
		after_provider_response: [push],
		tool_call: [push],
		tool_result: [push],
		model_select: [push],
	};
	return { log, handlers };
}

test("real LLM (gpt-4o-mini) fires the full event sequence around a single text turn", async () => {
	const apiKey = requireEnv("OPENAI_API_KEY");
	const model = getModel("openai", "gpt-4o-mini");
	const { log, handlers } = recorder();
	const { clientConn } = createTestHarness({
		models: [model],
		defaultModelId: model.id,
		getApiKey: (p) => (p === "openai" ? apiKey : undefined),
		eventHandlers: handlers,
	});

	await clientConn.initialize(stdInitParams);
	const { sessionId } = await clientConn.newSession({ cwd: process.cwd(), mcpServers: [] });
	const result = await clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: "Answer in one word: what day comes after Monday?" }],
	});

	expect(result.stopReason).toBe("end_turn");

	const types = log.map((e) => e.type);
	expect(types).toContain("session_start");
	expect(types).toContain("input");
	expect(types).toContain("before_agent_start");
	expect(types).toContain("agent_start");
	expect(types).toContain("turn_start");
	expect(types).toContain("message_start");
	expect(types).toContain("message_end");
	expect(types).toContain("turn_end");
	expect(types).toContain("agent_end");

	const start = log.find((e): e is AgentStartEvent => e.type === "agent_start");
	const end = log.find((e): e is AgentEndEvent => e.type === "agent_end");
	expect(start?.userPrompt).toMatch(/Monday/);
	expect(end?.stopReason).toBe("end_turn");

	const req = log.find((e): e is BeforeProviderRequestEvent => e.type === "before_provider_request");
	const res = log.find((e): e is AfterProviderResponseEvent => e.type === "after_provider_response");
	expect(req?.provider).toBe("openai");
	expect(req?.modelId).toBe(model.id);
	expect(res?.status).toBe(200);
});

test("real LLM tool turn (gpt-4o-mini) fires tool_call + tool_execution_* + tool_result", async () => {
	const apiKey = requireEnv("OPENAI_API_KEY");
	const model = getModel("openai", "gpt-4o-mini");
	const filesystem = createInMemoryFilesystem();
	await filesystem.mkdir("/proj", { recursive: true });
	await filesystem.writeTextFile("/proj/README.md", "# project readme\n\nhello world");

	const { log, handlers } = recorder();
	const { clientConn } = createTestHarness({
		models: [model],
		defaultModelId: model.id,
		getApiKey: (p) => (p === "openai" ? apiKey : undefined),
		filesystem,
		eventHandlers: handlers,
	});

	await clientConn.initialize(stdInitParams);
	const { sessionId } = await clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	const result = await clientConn.prompt({
		sessionId,
		prompt: [
			{
				type: "text",
				text: "Read the file /proj/README.md and tell me what's in it. You must use the read tool.",
			},
		],
	});

	expect(result.stopReason).toBe("end_turn");

	const callEv = log.find((e): e is ToolCallEvent => e.type === "tool_call");
	const execEnd = log.find((e): e is ToolExecutionEndEvent => e.type === "tool_execution_end");
	expect(callEv).toBeDefined();
	expect(execEnd).toBeDefined();
	expect(execEnd?.isError).toBe(false);
});
