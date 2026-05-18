import {
	type Api,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	fauxToolCall,
	type Model,
	registerFauxProvider,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createInMemoryFilesystem, EXT_SUBAGENT_CHILDREN } from "@/index.js";
import type { SubagentService } from "@/subagents/subagent-service.js";
import type { SubagentProfile } from "@/subagents/types.js";
import { createSubagentBatchTool } from "@/tools/subagent-batch.js";
import { stdInitParams } from "./helpers/acp-constants.js";
import { seedSubagent } from "./helpers/filesystem.js";
import { createTestHarness } from "./helpers/harness.js";
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

function makeProfile(name: string): SubagentProfile {
	return {
		name,
		description: `${name} profile`,
		context: "fresh",
		maxTurns: 5,
		body: "test body",
		filePath: `inline:${name}`,
		source: "project",
	};
}

test("subagent_batch parameters schema enforces minItems: 2 on tasks and has no attractor fields beyond failFast", () => {
	const tool = createSubagentBatchTool({
		sessionId: "session-x",
		profiles: [makeProfile("alpha"), makeProfile("beta")],
		service: { batchConcurrencyCap: 5 } as SubagentService,
	});
	const schema = tool.parameters as unknown as {
		properties: { tasks: { minItems: number; items: { properties: Record<string, unknown> } }; failFast: unknown };
		additionalProperties: boolean;
	};
	expect(schema.properties.tasks.minItems).toBe(2);
	expect(Object.keys(schema.properties).sort()).toEqual(["failFast", "tasks"]);
	expect(Object.keys(schema.properties.tasks.items.properties).sort()).toEqual(["agent", "model", "task"]);
	expect(schema.additionalProperties).toBe(false);
});

test("LLM tool_use for subagent_batch with tasks.length === 1 is rejected (minItems: 2) and no children spawn", async () => {
	const filesystem = createInMemoryFilesystem();
	await seedSubagent(filesystem, "/proj", "alpha", "---\ndescription: alpha\n---\nYou are alpha.\n");
	await seedSubagent(filesystem, "/proj", "beta", "---\ndescription: beta\n---\nYou are beta.\n");

	const faux = newProvider();
	const model = faux.getModel() as Model<Api>;
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("subagent_batch", { tasks: [{ agent: "alpha", task: "single" }] })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("ok"),
	]);

	const harness = createTestHarness({ models: [model], defaultModelId: model.id, filesystem });
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await harness.clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: "send a single-task batch" }],
	});

	const updates = toolCallUpdates(harness.updates);
	const failed = updates.find((u) => u.status === "failed");
	expect(failed, "single-task batch is rejected by minItems: 2").toBeDefined();

	const children = await harness.sessionStore.list({
		parentSessionId: sessionId,
		includeSubagentChildren: true,
	});
	expect(children.sessions).toHaveLength(0);
});

test("LLM tool_use for subagent_batch WITHOUT failFast runs every child to completion (collect-all default surfaces per-child errors)", async () => {
	const filesystem = createInMemoryFilesystem();
	await seedSubagent(filesystem, "/proj", "alpha", "---\ndescription: alpha\n---\nYou are alpha.\n");
	await seedSubagent(filesystem, "/proj", "beta", "---\ndescription: beta\n---\nYou are beta.\n");

	const faux = newProvider();
	const model = faux.getModel() as Model<Api>;
	faux.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall("subagent_batch", {
					tasks: [
						{ agent: "alpha", task: "task a" },
						{ agent: "beta", task: "task b" },
					],
				}),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("alpha done"),
		fauxAssistantMessage("beta done"),
		fauxAssistantMessage("parent ack"),
	]);

	const harness = createTestHarness({ models: [model], defaultModelId: model.id, filesystem });
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await harness.clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: "batch alpha beta" }],
	});

	const childrenResp = (await harness.clientConn.extMethod(EXT_SUBAGENT_CHILDREN, { sessionId })) as {
		children: Array<{ sessionId: string }>;
	};
	expect(childrenResp.children, "both children spawned under collect-all").toHaveLength(2);

	const updates = toolCallUpdates(harness.updates);
	const batchTerminal = updates.find((u) => u.status === "completed" || u.status === "failed");
	expect(batchTerminal?.status).toBe("completed");
});

test("LLM tool_use for subagent_batch WITH failFast: true reaches the executor (both branches covered per C0)", async () => {
	const filesystem = createInMemoryFilesystem();
	await seedSubagent(filesystem, "/proj", "alpha", "---\ndescription: alpha\n---\nYou are alpha.\n");
	await seedSubagent(filesystem, "/proj", "beta", "---\ndescription: beta\n---\nYou are beta.\n");

	const faux = newProvider();
	const model = faux.getModel() as Model<Api>;
	faux.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall("subagent_batch", {
					tasks: [
						{ agent: "alpha", task: "task a" },
						{ agent: "beta", task: "task b" },
					],
					failFast: true,
				}),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("alpha done"),
		fauxAssistantMessage("beta done"),
		fauxAssistantMessage("parent ack"),
	]);

	const harness = createTestHarness({ models: [model], defaultModelId: model.id, filesystem });
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await harness.clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: "batch alpha beta with failFast" }],
	});

	const childrenResp = (await harness.clientConn.extMethod(EXT_SUBAGENT_CHILDREN, { sessionId })) as {
		children: Array<{ sessionId: string }>;
	};
	expect(childrenResp.children, "failFast: true still spawns both children when none fail").toHaveLength(2);

	const updates = toolCallUpdates(harness.updates);
	const batchTerminal = updates.find((u) => u.status === "completed" || u.status === "failed");
	expect(batchTerminal?.status).toBe("completed");
});
