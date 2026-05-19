import {
	type Api,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	fauxToolCall,
	type Model,
	registerFauxProvider,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createInMemoryFilesystem, createInMemorySessionStore } from "@/index.js";
import { LIFECYCLE_EVENT_METHOD } from "@/wire/constants.js";
import { stdInitParams } from "./helpers/acp-constants.js";
import { createTestHarness } from "./helpers/harness.js";
import { toolCallUpdates, toolUpdateText } from "./helpers/tool-call-asserts.js";

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

function modelOf(faux: FauxProviderRegistration): Model<Api> {
	return faux.getModel() as Model<Api>;
}

test("plan mode blocks `write` with isError tool_result + redirect text", async () => {
	const faux = newProvider();
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("write", { path: "/proj/note.txt", content: "hi" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("adapting to plan mode"),
	]);
	const harness = createTestHarness({
		models: [modelOf(faux)],
		defaultModelId: modelOf(faux).id,
		filesystem: createInMemoryFilesystem(),
		defaultMode: "plan",
	});

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "make an edit" }] });

	const ends = toolCallUpdates(harness.updates);
	expect(ends.length, "tool_call_update for the blocked write").toBeGreaterThanOrEqual(1);
	const blockedUpdate = ends[ends.length - 1];
	expect(blockedUpdate.status).toBe("failed");
	const text = toolUpdateText(blockedUpdate);
	expect(text).toContain("plan mode");
	expect(text).toContain("write");
	expect(text).toContain("/mode edit");
});

test("plan mode allows `read` (no block, no custom_message)", async () => {
	const faux = newProvider();
	const filesystem = createInMemoryFilesystem();
	await filesystem.mkdir("/proj", { recursive: true });
	await filesystem.writeTextFile("/proj/readme.md", "hello");
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("read", { path: "/proj/readme.md" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("read fine"),
	]);
	const harness = createTestHarness({
		models: [modelOf(faux)],
		defaultModelId: modelOf(faux).id,
		filesystem,
		defaultMode: "plan",
	});

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "read it" }] });

	const ends = toolCallUpdates(harness.updates);
	expect(ends).toHaveLength(1);
	expect(ends[0].status).toBe("completed");

	const blocked = harness.extNotifications.filter(
		(n) => n.method === LIFECYCLE_EVENT_METHOD && (n.params as { type: string }).type === "tool_blocked",
	);
	expect(blocked, "no tool_blocked event for an allowed call").toHaveLength(0);
});

test("plan mode appends a custom_message entry on block (visible chat history)", async () => {
	const faux = newProvider();
	const sessionStore = createInMemorySessionStore();
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("write", { path: "/proj/foo.txt", content: "data" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("ok"),
	]);
	const harness = createTestHarness({
		models: [modelOf(faux)],
		defaultModelId: modelOf(faux).id,
		sessionStore,
		defaultMode: "plan",
	});

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "write please" }] });

	const record = await sessionStore.load(sessionId);
	expect(record, "session record should load").toBeTruthy();
	const customEntries = (record?.entries ?? []).filter((e) => e.type === "custom_message");
	expect(customEntries, "exactly one tool_blocked custom_message").toHaveLength(1);
	const entry = customEntries[0] as Extract<(typeof customEntries)[number], { type: "custom_message" }>;
	expect(entry.extensionName).toBe("modes");
	expect(entry.customType).toBe("tool_blocked");
	expect(entry.display).toBe(true);
	expect(entry.content).toContain("plan mode");
	expect(entry.content).toContain("write");
});

test("plan mode emits a tool_blocked lifecycle event with full payload", async () => {
	const faux = newProvider();
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("write", { path: "/x", content: "y" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("ok"),
	]);
	const harness = createTestHarness({
		models: [modelOf(faux)],
		defaultModelId: modelOf(faux).id,
		defaultMode: "plan",
	});

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "edit" }] });

	const blocked = harness.extNotifications.filter(
		(n) => n.method === LIFECYCLE_EVENT_METHOD && (n.params as { type: string }).type === "tool_blocked",
	);
	expect(blocked).toHaveLength(1);
	const payload = blocked[0].params as {
		type: string;
		sessionId: string;
		toolName: string;
		toolCallId: string;
		category: string;
		mode: string;
		reason: string;
	};
	expect(payload.sessionId).toBe(sessionId);
	expect(payload.toolName).toBe("write");
	expect(payload.category).toBe("edit");
	expect(payload.mode).toBe("plan");
	expect(payload.toolCallId.length).toBeGreaterThan(0);
	expect(payload.reason).toContain("plan mode");
});

test("edit mode stays inert: write succeeds (no plan-mode enforcement)", async () => {
	const faux = newProvider();
	const filesystem = createInMemoryFilesystem();
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("write", { path: "/proj/x.txt", content: "ok" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	const harness = createTestHarness({
		models: [modelOf(faux)],
		defaultModelId: modelOf(faux).id,
		filesystem,
		defaultMode: "edit",
	});

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "make it" }] });

	const ends = toolCallUpdates(harness.updates);
	expect(ends).toHaveLength(1);
	expect(ends[0].status).toBe("completed");
	const blocked = harness.extNotifications.filter(
		(n) => n.method === LIFECYCLE_EVENT_METHOD && (n.params as { type: string }).type === "tool_blocked",
	);
	expect(blocked).toHaveLength(0);
});

test("plan-mode system prompt suffix is appended at session boot", async () => {
	const faux = newProvider();
	let observedSystemPrompt = "";
	faux.setResponses([
		(ctx) => {
			observedSystemPrompt = ctx.systemPrompt ?? "";
			return fauxAssistantMessage("ok");
		},
	]);
	const harness = createTestHarness({
		models: [modelOf(faux)],
		defaultModelId: modelOf(faux).id,
		defaultMode: "plan",
	});

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "ping" }] });

	expect(observedSystemPrompt).toContain("PLAN MODE");
	expect(observedSystemPrompt).toContain("read-only");
});

test("ask mode (default): no plan-mode suffix in system prompt", async () => {
	const faux = newProvider();
	let observedSystemPrompt = "";
	faux.setResponses([
		(ctx) => {
			observedSystemPrompt = ctx.systemPrompt ?? "";
			return fauxAssistantMessage("ok");
		},
	]);
	const harness = createTestHarness({
		models: [modelOf(faux)],
		defaultModelId: modelOf(faux).id,
		// no defaultMode → "ask"
	});

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "ping" }] });

	expect(observedSystemPrompt).not.toContain("PLAN MODE");
});
