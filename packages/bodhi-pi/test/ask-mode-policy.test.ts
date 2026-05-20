import {
	type Api,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	fauxToolCall,
	type Model,
	registerFauxProvider,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createInMemoryFilesystem } from "@/index.js";
import { LIFECYCLE_EVENT_METHOD } from "@/wire/constants.js";
import { stdInitParams } from "./helpers/acp-constants.js";
import { createTestHarness, type TestHarness } from "./helpers/harness.js";
import { toolCallStarts, toolCallUpdates } from "./helpers/tool-call-asserts.js";

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

function approvalRequests(h: TestHarness): unknown[] {
	return h.extNotifications
		.filter(
			(n) => n.method === LIFECYCLE_EVENT_METHOD && (n.params as { type: string }).type === "tool_approval_request",
		)
		.map((n) => n.params);
}

test("ask mode auto-allows read without prompting", async () => {
	const faux = newProvider();
	const filesystem = createInMemoryFilesystem();
	await filesystem.mkdir("/proj", { recursive: true });
	await filesystem.writeTextFile("/proj/readme.md", "hello");
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("read", { path: "/proj/readme.md" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("read it"),
	]);
	const harness = createTestHarness({ models: [modelOf(faux)], defaultModelId: modelOf(faux).id, filesystem });

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "read it" }] });

	expect(approvalRequests(harness), "read is auto-allowed — no approval prompt").toHaveLength(0);
	const ends = toolCallUpdates(harness.updates);
	expect(ends).toHaveLength(1);
	expect(ends[0].status).toBe("completed");
});

test("ask mode prompts before running write, emits a pending card, then runs on allow", async () => {
	const faux = newProvider();
	const filesystem = createInMemoryFilesystem();
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("write", { path: "/proj/note.txt", content: "hi" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("wrote it"),
	]);
	const harness = createTestHarness({
		models: [modelOf(faux)],
		defaultModelId: modelOf(faux).id,
		filesystem,
		autoApproveAll: false,
		approvalResponses: [{ outcome: { outcome: "selected", optionId: "allow_once" } }],
	});

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "write a note" }] });

	expect(approvalRequests(harness), "write (edit category) prompts").toHaveLength(1);
	const starts = toolCallStarts(harness.updates);
	expect(
		starts.some((s) => s.status === "pending"),
		"a pending tool_call card precedes execution",
	).toBe(true);
	const ends = toolCallUpdates(harness.updates);
	expect(ends[ends.length - 1].status).toBe("completed");
	expect(await filesystem.exists("/proj/note.txt"), "file written after approval").toBe(true);
});
