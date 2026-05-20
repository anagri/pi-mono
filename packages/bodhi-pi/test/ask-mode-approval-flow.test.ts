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
import { toolCallUpdates } from "./helpers/tool-call-asserts.js";

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

function lifecycleByType(h: TestHarness, type: string): Array<Record<string, unknown>> {
	return h.extNotifications
		.filter((n) => n.method === LIFECYCLE_EVENT_METHOD && (n.params as { type: string }).type === type)
		.map((n) => n.params as Record<string, unknown>);
}

test("allow_once runs the tool and fires tool_approval_response{allow_once} on the wire", async () => {
	const faux = newProvider();
	const filesystem = createInMemoryFilesystem();
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("write", { path: "/proj/a.txt", content: "hi" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
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
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "write a" }] });

	expect(lifecycleByType(harness, "tool_approval_request")).toHaveLength(1);
	const responses = lifecycleByType(harness, "tool_approval_response");
	expect(responses).toHaveLength(1);
	expect(responses[0].kind).toBe("allow_once");
	expect(await filesystem.exists("/proj/a.txt")).toBe(true);
	const ends = toolCallUpdates(harness.updates);
	expect(ends[ends.length - 1].status).toBe("completed");
});

test("reject_once blocks the tool — both tool_approval_response{reject_once} and tool_blocked fire", async () => {
	const faux = newProvider();
	const filesystem = createInMemoryFilesystem();
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("write", { path: "/proj/b.txt", content: "no" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("ok"),
	]);
	const harness = createTestHarness({
		models: [modelOf(faux)],
		defaultModelId: modelOf(faux).id,
		filesystem,
		autoApproveAll: false,
		approvalResponses: [{ outcome: { outcome: "selected", optionId: "reject_once" } }],
	});

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "write b" }] });

	const responses = lifecycleByType(harness, "tool_approval_response");
	expect(responses).toHaveLength(1);
	expect(responses[0].kind).toBe("reject_once");
	expect(lifecycleByType(harness, "tool_blocked")).toHaveLength(1);
	expect(await filesystem.exists("/proj/b.txt"), "rejected write does not touch the filesystem").toBe(false);
	const ends = toolCallUpdates(harness.updates);
	expect(ends[ends.length - 1].status).toBe("failed");
});

test("allow_always records a grant so the same tool runs again without re-prompting", async () => {
	const faux = newProvider();
	const filesystem = createInMemoryFilesystem();
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("write", { path: "/proj/x.txt", content: "1" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("first"),
		fauxAssistantMessage([fauxToolCall("write", { path: "/proj/y.txt", content: "2" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("second"),
	]);
	const harness = createTestHarness({
		models: [modelOf(faux)],
		defaultModelId: modelOf(faux).id,
		filesystem,
		autoApproveAll: false,
		// Only one verdict in the queue — the second write must ride the session grant, not a prompt.
		approvalResponses: [{ outcome: { outcome: "selected", optionId: "allow_always" } }],
	});

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "write x" }] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "write y" }] });

	expect(lifecycleByType(harness, "tool_approval_request"), "only the first write prompts").toHaveLength(1);
	expect(await filesystem.exists("/proj/x.txt")).toBe(true);
	expect(await filesystem.exists("/proj/y.txt"), "second write rode the allow_always grant").toBe(true);
});
