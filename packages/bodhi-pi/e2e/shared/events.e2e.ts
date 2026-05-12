import { getModel } from "@earendil-works/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { recorder } from "@test/helpers/event-recorder.js";
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
import { createE2EHarness, type E2EHarness } from "../helpers/harness.js";
import { isRuntime } from "../helpers/runtime.js";

// Event-handler tests pass JS callbacks into the agent in-process. They can't
// translate over the cli stdio boundary, so they run under in-memory only.
// The cli runtime project picks up other shared tests instead.

let activeHarness: E2EHarness | undefined;

afterEach(async () => {
	if (activeHarness) {
		await activeHarness.cleanup();
		activeHarness = undefined;
	}
});

test.runIf(isRuntime("in-memory"))(
	"real LLM (gpt-4o-mini) fires the full event sequence around a single text turn",
	async () => {
		const model = getModel("openai", "gpt-4o-mini");
		const apiKey = process.env.OPENAI_API_KEY!;
		const { log, handlers } = recorder();
		const h = await createE2EHarness({
			models: [model],
			defaultModelId: model.id,
			getApiKey: (p) => (p === "openai" ? apiKey : undefined),
			eventHandlers: handlers,
		});
		activeHarness = h;

		await h.clientConn.initialize(stdInitParams);
		const { sessionId } = await h.clientConn.newSession({ cwd: h.cwd, mcpServers: [] });
		const result = await h.clientConn.prompt({
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
		expect(types).toContain("message_update");
		expect(types).toContain("message_end");
		expect(types).toContain("turn_end");
		expect(types).toContain("agent_end");

		const start = log.find((e): e is AgentStartEvent => e.type === "agent_start");
		const end = log.find((e): e is AgentEndEvent => e.type === "agent_end");
		expect(start?.userPrompt).toMatch(/Monday/);
		expect(end?.stopReason).toBe("end_turn");

		const updates = log.filter((e): e is MessageUpdateEvent => e.type === "message_update");
		const textDeltas = updates.filter((u) => u.assistantMessageEvent.type === "text_delta");
		expect(textDeltas.length, "at least one text_delta indicates streaming").toBeGreaterThan(0);

		const req = log.find((e): e is BeforeProviderRequestEvent => e.type === "before_provider_request");
		const res = log.find((e): e is AfterProviderResponseEvent => e.type === "after_provider_response");
		expect(req?.provider).toBe("openai");
		expect(req?.modelId).toBe(model.id);
		expect(res?.status).toBe(200);
	},
);

test.runIf(isRuntime("in-memory"))(
	"real LLM tool turn (gpt-4o-mini) fires tool_call + tool_execution_* + tool_result",
	async () => {
		const model = getModel("openai", "gpt-4o-mini");
		const apiKey = process.env.OPENAI_API_KEY!;

		const { log, handlers } = recorder();
		const h = await createE2EHarness({
			models: [model],
			defaultModelId: model.id,
			getApiKey: (p) => (p === "openai" ? apiKey : undefined),
			eventHandlers: handlers,
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

		const callEv = log.find((e): e is ToolCallEvent => e.type === "tool_call");
		const execEnd = log.find((e): e is ToolExecutionEndEvent => e.type === "tool_execution_end");
		expect(callEv).toBeDefined();
		expect(execEnd).toBeDefined();
		expect(execEnd?.isError).toBe(false);

		const types = log.map((e) => e.type);
		expect(types).toContain("tool_execution_start");
		expect(types).toContain("tool_execution_end");
	},
);
