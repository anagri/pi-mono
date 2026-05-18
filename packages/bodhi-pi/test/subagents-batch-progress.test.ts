import {
	type Api,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	fauxToolCall,
	type Model,
	registerFauxProvider,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createInMemoryFilesystem, type SubagentBatchStartEvent, type ToolExecutionUpdateEvent } from "@/index.js";
import { stdInitParams } from "./helpers/acp-constants.js";
import { seedSubagent } from "./helpers/filesystem.js";
import { createTestHarness } from "./helpers/harness.js";

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

test("subagent_batch surfaces per-child progress through a single tool_call_update channel with details.children[]", async () => {
	const filesystem = createInMemoryFilesystem();
	await seedSubagent(filesystem, "/proj", "alpha", "---\ndescription: alpha\ntools:\n  - read\n---\nYou are alpha.\n");
	await seedSubagent(filesystem, "/proj", "beta", "---\ndescription: beta\ntools:\n  - read\n---\nYou are beta.\n");
	await filesystem.mkdir("/proj", { recursive: true });
	await filesystem.writeTextFile("/proj/a.txt", "alpha-content");
	await filesystem.writeTextFile("/proj/b.txt", "beta-content");

	const faux = newProvider();
	const model = faux.getModel() as Model<Api>;
	faux.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall("subagent_batch", {
					tasks: [
						{ agent: "alpha", task: "read /proj/a.txt" },
						{ agent: "beta", task: "read /proj/b.txt" },
					],
				}),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage([fauxToolCall("read", { path: "/proj/a.txt" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxToolCall("read", { path: "/proj/b.txt" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("alpha done"),
		fauxAssistantMessage("beta done"),
		fauxAssistantMessage("done"),
	]);

	let batchToolCallId: string | undefined;
	const partials: ToolExecutionUpdateEvent[] = [];
	const harness = createTestHarness({
		models: [model],
		defaultModelId: model.id,
		filesystem,
		eventHandlers: {
			subagent_batch_start: [
				(e: SubagentBatchStartEvent) => {
					batchToolCallId = e.batchToolCallId;
				},
			],
			tool_execution_update: [
				(e: ToolExecutionUpdateEvent) => {
					if (batchToolCallId && e.toolCallId === batchToolCallId) partials.push(e);
				},
			],
		},
	});

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await harness.clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: "Run alpha and beta in parallel." }],
	});

	expect(batchToolCallId, "batch tool_call id captured").toBeDefined();
	expect(partials.length, "at least one progress tick for the batch tool_call").toBeGreaterThan(0);

	type BatchProgressDetails = {
		kind: string;
		batchToolCallId: string;
		children: Array<{
			childSessionId: string;
			profile: string;
			toolCount: number;
			status: string;
			lastTool?: string;
		}>;
	};
	const last = partials[partials.length - 1].partialResult as { details?: BatchProgressDetails };
	expect(last.details?.kind, "every batch progress tick is tagged subagent_batch_progress").toBe(
		"subagent_batch_progress",
	);
	expect(last.details?.batchToolCallId).toBe(batchToolCallId);
	expect(last.details?.children).toHaveLength(2);
	const profiles = last.details!.children.map((c) => c.profile).sort();
	expect(profiles).toEqual(["alpha", "beta"]);

	const everyTickHasBothChildren = partials.every((p) => {
		const det = (p.partialResult as { details?: BatchProgressDetails }).details;
		return det?.children.length === 2;
	});
	expect(everyTickHasBothChildren, "every coalesced tick carries the full children[] snapshot").toBe(true);
});
