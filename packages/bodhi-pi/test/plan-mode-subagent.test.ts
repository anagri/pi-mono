import {
	type Api,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	fauxToolCall,
	type Model,
	registerFauxProvider,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createInMemoryFilesystem, EXT_SUBAGENT_RUN } from "@/index.js";
import { LIFECYCLE_EVENT_METHOD } from "@/wire/constants.js";
import { stdInitParams } from "./helpers/acp-constants.js";
import { seedSubagent } from "./helpers/filesystem.js";
import { createTestHarness } from "./helpers/harness.js";

// "writer" profile carries no `tools:` whitelist so the child inherits every built-in,
// including `write`. The plan-mode gate is what blocks the write at call time.
const WRITER_PROFILE_BODY = "---\ndescription: writes files\n---\nYou write files when asked.\n";

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

test("subagent spawned from plan-mode parent inherits plan and blocks `write`", async () => {
	const filesystem = createInMemoryFilesystem();
	await seedSubagent(filesystem, "/proj", "writer", WRITER_PROFILE_BODY);
	const faux = newProvider();
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("write", { path: "/proj/out.txt", content: "hi" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("explored without writing"),
	]);
	const harness = createTestHarness({
		models: [modelOf(faux)],
		defaultModelId: modelOf(faux).id,
		filesystem,
		defaultMode: "plan",
	});

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	const result = (await harness.clientConn.extMethod(EXT_SUBAGENT_RUN, {
		sessionId,
		agent: "writer",
		task: "look at /proj",
	})) as { status: string; summary?: string };
	expect(result.status).toBe("completed");

	const blocked = harness.extNotifications.filter(
		(n) => n.method === LIFECYCLE_EVENT_METHOD && (n.params as { type: string }).type === "tool_blocked",
	);
	expect(blocked, "child should block write same as parent").toHaveLength(1);
	const payload = blocked[0].params as { toolName: string; mode: string; sessionId: string };
	expect(payload.toolName).toBe("write");
	expect(payload.mode).toBe("plan");
	expect(payload.sessionId, "block fires on the CHILD session, not the parent").not.toBe(sessionId);
});

test("subagent spawned from edit-mode parent inherits edit and lets `write` through", async () => {
	const filesystem = createInMemoryFilesystem();
	await seedSubagent(filesystem, "/proj", "writer", WRITER_PROFILE_BODY);
	const faux = newProvider();
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("write", { path: "/proj/out.txt", content: "ok" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("wrote it"),
	]);
	const harness = createTestHarness({
		models: [modelOf(faux)],
		defaultModelId: modelOf(faux).id,
		filesystem,
		defaultMode: "edit",
	});

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	const result = (await harness.clientConn.extMethod(EXT_SUBAGENT_RUN, {
		sessionId,
		agent: "writer",
		task: "do work",
	})) as { status: string };
	expect(result.status).toBe("completed");

	const blocked = harness.extNotifications.filter(
		(n) => n.method === LIFECYCLE_EVENT_METHOD && (n.params as { type: string }).type === "tool_blocked",
	);
	expect(blocked, "edit mode parent → edit child → no block").toHaveLength(0);
});
