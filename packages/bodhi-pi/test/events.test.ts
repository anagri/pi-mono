import { LLMock } from "@copilotkit/aimock";
import {
	type Api,
	type Context,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	fauxToolCall,
	getModel,
	type Model,
	registerFauxProvider,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
	type AfterProviderResponseEvent,
	type AgentEndEvent,
	type AgentStartEvent,
	type BeforeAgentStartEvent,
	type BeforeProviderRequestEvent,
	type BodhiPiEventHandlers,
	createInMemoryFilesystem,
	type InputEvent,
	type MessageEndEvent,
	type MessageStartEvent,
	type ModelSelectEvent,
	type SessionShutdownEvent,
	type SessionStartEvent,
	type ToolCallEvent,
	type ToolExecutionEndEvent,
	type ToolExecutionStartEvent,
	type ToolResultEvent,
	type TurnEndEvent,
	type TurnStartEvent,
} from "@/index.js";
import { stdInitParams } from "./helpers/acp-constants.js";
import { recorder } from "./helpers/event-recorder.js";
import { createTestHarness } from "./helpers/harness.js";

let providers: FauxProviderRegistration[] = [];
let mocks: LLMock[] = [];

beforeEach(() => {
	providers = [];
	mocks = [];
});

afterEach(async () => {
	for (const p of providers) p.unregister();
	providers = [];
	await Promise.all(mocks.map((m) => m.stop()));
	mocks = [];
});

async function startMock(): Promise<LLMock> {
	const mock = new LLMock({ port: 0 });
	await mock.start();
	mocks.push(mock);
	return mock;
}

function newProvider(): FauxProviderRegistration {
	const p = registerFauxProvider();
	providers.push(p);
	return p;
}

function modelOf(faux: FauxProviderRegistration): Model<Api> {
	return faux.getModel() as Model<Api>;
}

// `recorder` lives at `test/helpers/event-recorder.ts` — the single source of
// truth for the 19-event lifecycle. Imported above.

test("session_start fires for new/load/resume; session_shutdown for close/delete", async () => {
	const faux = newProvider();
	faux.setResponses([fauxAssistantMessage("ok")]);
	const { log, handlers } = recorder();
	const harness = createTestHarness({
		models: [modelOf(faux)],
		defaultModelId: modelOf(faux).id,
		eventHandlers: handlers,
	});

	await harness.clientConn.initialize(stdInitParams);
	const newRes = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	const sid = newRes.sessionId;

	await harness.clientConn.closeSession({ sessionId: sid });
	await harness.clientConn.loadSession({ sessionId: sid, cwd: "/proj", mcpServers: [] });
	await harness.clientConn.closeSession({ sessionId: sid });
	await harness.clientConn.resumeSession({ sessionId: sid, cwd: "/proj", mcpServers: [] });
	await harness.clientConn.closeSession({ sessionId: sid });
	await harness.clientConn.extMethod("_bodhi-pi/session/delete", { sessionId: sid });

	const starts = log.filter((e): e is SessionStartEvent => e.type === "session_start");
	expect(starts.map((e) => e.reason)).toEqual(["new", "load", "resume"]);
	for (const s of starts) expect(s.sessionId).toBe(sid);

	const shutdowns = log.filter((e): e is SessionShutdownEvent => e.type === "session_shutdown");
	expect(shutdowns).toHaveLength(4);
	for (const s of shutdowns) expect(s.sessionId).toBe(sid);
});

test("prompt fires agent_start, turn_start, message_*, turn_end, agent_end in order", async () => {
	const faux = newProvider();
	faux.setResponses([fauxAssistantMessage("hello")]);
	const { log, handlers } = recorder();
	const harness = createTestHarness({
		models: [modelOf(faux)],
		defaultModelId: modelOf(faux).id,
		eventHandlers: handlers,
	});
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	const result = await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] });

	expect(result.stopReason).toBe("end_turn");
	const types = log.map((e) => e.type);
	const start = types.indexOf("agent_start");
	const end = types.indexOf("agent_end");
	expect(start).toBeGreaterThan(-1);
	expect(end).toBeGreaterThan(start);
	expect(types.slice(start, end + 1)).toContain("turn_start");
	expect(types.slice(start, end + 1)).toContain("turn_end");
	expect(types.slice(start, end + 1)).toContain("message_start");
	expect(types.slice(start, end + 1)).toContain("message_end");

	const agentStart = log.find((e): e is AgentStartEvent => e.type === "agent_start");
	expect(agentStart?.userPrompt).toBe("hi");
	const agentEnd = log.find((e): e is AgentEndEvent => e.type === "agent_end");
	expect(agentEnd?.stopReason).toBe("end_turn");
});

test("input handler mutates user text before the LLM sees it", async () => {
	const faux = newProvider();
	let receivedText: string | undefined;
	faux.setResponses([
		(ctx: Context) => {
			const lastUser = [...ctx.messages].reverse().find((m) => m.role === "user");
			if (lastUser && Array.isArray(lastUser.content)) {
				const t = lastUser.content.find((b) => b.type === "text");
				receivedText = t?.text;
			}
			return fauxAssistantMessage("ok");
		},
	]);
	const handlers: BodhiPiEventHandlers = {
		input: [(e) => (e.text === "raw" ? { text: "rewritten" } : undefined)],
	};
	const harness = createTestHarness({
		models: [modelOf(faux)],
		defaultModelId: modelOf(faux).id,
		eventHandlers: handlers,
	});
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "raw" }] });

	expect(receivedText).toBe("rewritten");
});

test("input handler with handled:true short-circuits without calling the LLM", async () => {
	const faux = newProvider();
	let llmCalled = false;
	faux.setResponses([
		() => {
			llmCalled = true;
			return fauxAssistantMessage("should not run");
		},
	]);
	const handlers: BodhiPiEventHandlers = {
		input: [() => ({ handled: true })],
	};
	const harness = createTestHarness({
		models: [modelOf(faux)],
		defaultModelId: modelOf(faux).id,
		eventHandlers: handlers,
	});
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	const result = await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "anything" }] });

	expect(llmCalled).toBe(false);
	expect(result.stopReason).toBe("end_turn");
});

test("before_agent_start handler mutates system prompt before the LLM call", async () => {
	const faux = newProvider();
	let observedSystem: string | undefined;
	faux.setResponses([
		(ctx: Context) => {
			observedSystem = ctx.systemPrompt;
			return fauxAssistantMessage("ok");
		},
	]);
	const handlers: BodhiPiEventHandlers = {
		before_agent_start: [() => ({ systemPrompt: "you are a pirate" })],
	};
	const harness = createTestHarness({
		models: [modelOf(faux)],
		defaultModelId: modelOf(faux).id,
		systemPrompt: "you are a friendly assistant",
		eventHandlers: handlers,
	});
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] });

	expect(observedSystem).toBe("you are a pirate");
});

test("tool_call handler mutates input args before tool executes", async () => {
	const faux = newProvider();
	const filesystem = createInMemoryFilesystem();
	await filesystem.mkdir("/proj", { recursive: true });
	await filesystem.writeTextFile("/proj/real.txt", "real content");
	await filesystem.writeTextFile("/proj/decoy.txt", "decoy content");
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("read", { path: "/proj/decoy.txt" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	const handlers: BodhiPiEventHandlers = {
		tool_call: [
			(e) => {
				if (e.toolName === "read" && e.input.path === "/proj/decoy.txt") {
					(e.input as { path: string }).path = "/proj/real.txt";
				}
				return undefined;
			},
		],
	};
	const harness = createTestHarness({
		models: [modelOf(faux)],
		defaultModelId: modelOf(faux).id,
		filesystem,
		eventHandlers: handlers,
	});
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "read" }] });

	const endEv = harness.updates.find(
		(u) =>
			u.update.sessionUpdate === "tool_call_update" &&
			u.update.toolCallId !== undefined &&
			u.update.status === "completed",
	);
	expect(endEv).toBeDefined();
	const flat = JSON.stringify(endEv);
	expect(flat).toContain("real content");
	expect(flat).not.toContain("decoy content");
});

test("tool_call handler with block:true prevents execution and surfaces reason", async () => {
	const faux = newProvider();
	const filesystem = createInMemoryFilesystem();
	await filesystem.mkdir("/proj", { recursive: true });
	await filesystem.writeTextFile("/proj/secret.txt", "should never read");
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("read", { path: "/proj/secret.txt" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	const handlers: BodhiPiEventHandlers = {
		tool_call: [() => ({ block: true, reason: "policy denied" })],
	};
	const harness = createTestHarness({
		models: [modelOf(faux)],
		defaultModelId: modelOf(faux).id,
		filesystem,
		eventHandlers: handlers,
	});
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "read" }] });

	const failed = harness.updates.find(
		(u) => u.update.sessionUpdate === "tool_call_update" && u.update.status === "failed",
	);
	expect(failed).toBeDefined();
	expect(JSON.stringify(failed)).toContain("policy denied");
});

test("tool_result handler rewrites tool output content", async () => {
	const faux = newProvider();
	const filesystem = createInMemoryFilesystem();
	await filesystem.mkdir("/proj", { recursive: true });
	await filesystem.writeTextFile("/proj/leak.txt", "API_KEY=sk-ABC123");
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("read", { path: "/proj/leak.txt" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	const handlers: BodhiPiEventHandlers = {
		tool_result: [
			(e) => {
				if (e.toolName !== "read") return;
				const newContent = e.result.content.map((c) =>
					c.type === "text" ? { ...c, text: c.text.replace(/sk-[A-Z0-9]+/g, "[REDACTED]") } : c,
				);
				return { content: newContent };
			},
		],
	};
	const harness = createTestHarness({
		models: [modelOf(faux)],
		defaultModelId: modelOf(faux).id,
		filesystem,
		eventHandlers: handlers,
	});
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "read" }] });

	const completed = harness.updates.find(
		(u) => u.update.sessionUpdate === "tool_call_update" && u.update.status === "completed",
	);
	expect(JSON.stringify(completed)).toContain("[REDACTED]");
	expect(JSON.stringify(completed)).not.toContain("sk-ABC123");
});

test("model_select fires on setSessionConfigOption with correct from/to ids", async () => {
	const fauxA = newProvider();
	const fauxB = newProvider();
	fauxA.setResponses([fauxAssistantMessage("a")]);
	fauxB.setResponses([fauxAssistantMessage("b")]);
	const modelA = { ...modelOf(fauxA), id: "model-a" };
	const modelB = { ...modelOf(fauxB), id: "model-b" };
	const { log, handlers } = recorder();
	const harness = createTestHarness({
		models: [modelA, modelB],
		defaultModelId: "model-a",
		eventHandlers: handlers,
	});
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	await harness.clientConn.setSessionConfigOption({ sessionId, configId: "model", value: "model-b" });

	const sel = log.find((e): e is ModelSelectEvent => e.type === "model_select");
	expect(sel).toBeDefined();
	expect(sel?.fromModelId).toBe("model-a");
	expect(sel?.toModelId).toBe("model-b");
});

test("tool_execution_* events fire around tool execution", async () => {
	const faux = newProvider();
	const filesystem = createInMemoryFilesystem();
	await filesystem.mkdir("/proj", { recursive: true });
	await filesystem.writeTextFile("/proj/x.txt", "x");
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("read", { path: "/proj/x.txt" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	const { log, handlers } = recorder();
	const harness = createTestHarness({
		models: [modelOf(faux)],
		defaultModelId: modelOf(faux).id,
		filesystem,
		eventHandlers: handlers,
	});
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "read" }] });

	const start = log.find((e): e is ToolExecutionStartEvent => e.type === "tool_execution_start");
	const end = log.find((e): e is ToolExecutionEndEvent => e.type === "tool_execution_end");
	expect(start?.toolName).toBe("read");
	expect(end?.toolName).toBe("read");
	expect(end?.isError).toBe(false);
});

test("before_provider_request and after_provider_response fire around the HTTP call (aimock)", async () => {
	// Faux provider skips the HTTP layer, so onPayload/onResponse never fire.
	// aimock runs a real HTTP server and exercises the full transport, which is
	// where pi-agent-core actually invokes onPayload/onResponse.
	const mock = await startMock();
	mock.onMessage(/.*/, { content: "ok" });
	const baseModel = getModel("openai", "gpt-5-mini");
	const model = { ...baseModel, baseUrl: `${mock.url}/v1` };
	const { log, handlers } = recorder();
	const harness = createTestHarness({
		models: [model],
		defaultModelId: model.id,
		eventHandlers: handlers,
	});
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] });

	const req = log.find((e): e is BeforeProviderRequestEvent => e.type === "before_provider_request");
	const res = log.find((e): e is AfterProviderResponseEvent => e.type === "after_provider_response");
	expect(req?.modelId).toBe(model.id);
	expect(req?.provider).toBe(model.provider);
	expect(req?.payload).toBeDefined();
	expect(res).toBeDefined();
	expect(typeof res?.status).toBe("number");
});

test("handler errors are isolated; peer handlers still run", async () => {
	const faux = newProvider();
	faux.setResponses([fauxAssistantMessage("ok")]);
	const peerLog: string[] = [];
	const handlers: BodhiPiEventHandlers = {
		agent_start: [
			() => {
				throw new Error("first handler boom");
			},
			() => void peerLog.push("second handler ran"),
		],
	};
	const harness = createTestHarness({
		models: [modelOf(faux)],
		defaultModelId: modelOf(faux).id,
		eventHandlers: handlers,
	});
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	const result = await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] });

	expect(result.stopReason).toBe("end_turn");
	expect(peerLog).toContain("second handler ran");
});

test("event payloads include the correct sessionId across the lifecycle", async () => {
	const faux = newProvider();
	faux.setResponses([fauxAssistantMessage("ok")]);
	const { log, handlers } = recorder();
	const harness = createTestHarness({
		models: [modelOf(faux)],
		defaultModelId: modelOf(faux).id,
		eventHandlers: handlers,
	});
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] });
	await harness.clientConn.closeSession({ sessionId });

	for (const ev of log) {
		expect((ev as { sessionId?: string }).sessionId).toBe(sessionId);
	}
});

// ensure unused-import warnings don't fire on the destructured types we exported.
test("type symbol smoke", () => {
	const _ignore:
		| BeforeAgentStartEvent
		| InputEvent
		| TurnStartEvent
		| TurnEndEvent
		| MessageStartEvent
		| MessageEndEvent
		| ToolCallEvent
		| ToolResultEvent
		| undefined = undefined;
	void _ignore;
	expect(true).toBe(true);
});
