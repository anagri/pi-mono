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
import type { SubagentService } from "@/subagents/subagent-service.js";
import type { SubagentProfile } from "@/subagents/types.js";
import { createSubagentTool } from "@/tools/subagent.js";
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

test("subagent tool parameters schema has no context attractor field and rejects extra properties", () => {
	const tool = createSubagentTool({
		sessionId: "session-x",
		profiles: [makeProfile("alpha"), makeProfile("beta")],
		service: {} as SubagentService,
	});
	const schema = tool.parameters as unknown as {
		properties: Record<string, unknown>;
		additionalProperties: boolean;
	};
	expect(Object.keys(schema.properties)).not.toContain("context");
	expect(Object.keys(schema.properties).sort()).toEqual(["agent", "model", "task"]);
	expect(schema.additionalProperties).toBe(false);
});

test("LLM tool_use for subagent with only {agent, task} succeeds and spawns child", async () => {
	const filesystem = createInMemoryFilesystem();
	await seedSubagent(filesystem, "/proj", "extractor", "---\ndescription: extract\n---\nYou are an extractor.\n");

	const faux = newProvider();
	const model = faux.getModel() as Model<Api>;
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("subagent", { agent: "extractor", task: "do work" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage("child says hi"),
		fauxAssistantMessage("parent wrap-up"),
	]);

	const harness = createTestHarness({ models: [model], defaultModelId: model.id, filesystem });
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await harness.clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: "use subagent" }],
	});

	const updates = toolCallUpdates(harness.updates);
	const subagentTerminal = updates.find((u) => u.status === "completed" || u.status === "failed");
	expect(subagentTerminal?.status).toBe("completed");

	const children = await harness.sessionStore.list({
		parentSessionId: sessionId,
		includeSubagentChildren: true,
	});
	expect(children.sessions).toHaveLength(1);
});

test("LLM tool_use for subagent with an extra context attractor field is rejected and no child spawns", async () => {
	const filesystem = createInMemoryFilesystem();
	await seedSubagent(filesystem, "/proj", "extractor", "---\ndescription: extract\n---\nYou are an extractor.\n");

	const faux = newProvider();
	const model = faux.getModel() as Model<Api>;
	faux.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall("subagent", {
					agent: "extractor",
					task: "do work",
					context: "Background notes the LLM helpfully filled in.",
				}),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("parent wrap-up"),
	]);

	const harness = createTestHarness({ models: [model], defaultModelId: model.id, filesystem });
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await harness.clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: "use subagent with context attractor" }],
	});

	const updates = toolCallUpdates(harness.updates);
	const failed = updates.find((u) => u.status === "failed");
	expect(failed, "expected the tool call to be rejected by additionalProperties: false").toBeDefined();

	const children = await harness.sessionStore.list({
		parentSessionId: sessionId,
		includeSubagentChildren: true,
	});
	expect(children.sessions).toHaveLength(0);
});
