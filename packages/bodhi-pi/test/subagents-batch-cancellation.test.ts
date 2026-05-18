import {
	type Api,
	type FauxProviderRegistration,
	type FauxResponseStep,
	fauxAssistantMessage,
	type Model,
	registerFauxProvider,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createInMemoryFilesystem, EXT_SUBAGENT_CHILDREN } from "@/index.js";
import { stdInitParams } from "./helpers/acp-constants.js";
import { seedSubagent } from "./helpers/filesystem.js";
import { createTestHarness } from "./helpers/harness.js";
import { scriptSubagentRun } from "./helpers/script-subagent-run.js";

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

function abortableAssistant(text: string, delayMs: number): FauxResponseStep {
	return async (_ctx, opts) => {
		await new Promise<void>((resolve) => {
			if (opts?.signal?.aborted) {
				resolve();
				return;
			}
			const timer = setTimeout(resolve, delayMs);
			opts?.signal?.addEventListener(
				"abort",
				() => {
					clearTimeout(timer);
					resolve();
				},
				{ once: true },
			);
		});
		return opts?.signal?.aborted
			? fauxAssistantMessage(`${text} (aborted)`, { stopReason: "aborted" })
			: fauxAssistantMessage(text);
	};
}

test("client.cancel mid-batch aborts every in-flight child", async () => {
	const filesystem = createInMemoryFilesystem();
	await seedSubagent(filesystem, "/proj", "slow-a", "---\ndescription: slow a\n---\nYou are slow-a.\n");
	await seedSubagent(filesystem, "/proj", "slow-b", "---\ndescription: slow b\n---\nYou are slow-b.\n");
	await seedSubagent(filesystem, "/proj", "slow-c", "---\ndescription: slow c\n---\nYou are slow-c.\n");

	const faux = newProvider();
	const model = faux.getModel() as Model<Api>;
	scriptSubagentRun(faux, {
		parentTurns: [
			{
				tool: "subagent_batch",
				args: {
					tasks: [
						{ agent: "slow-a", task: "wait a" },
						{ agent: "slow-b", task: "wait b" },
						{ agent: "slow-c", task: "wait c" },
					],
				},
			},
		],
		childResponses: [
			abortableAssistant("a done", 1500),
			abortableAssistant("b done", 1500),
			abortableAssistant("c done", 1500),
		],
		finalText: "parent wrap-up",
	});

	const harness = createTestHarness({ models: [model], defaultModelId: model.id, filesystem });
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	const promptPromise = harness.clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: "dispatch three slow children" }],
	});
	setTimeout(() => {
		void harness.clientConn.cancel({ sessionId });
	}, 200);
	await promptPromise;

	const childrenResp = (await harness.clientConn.extMethod(EXT_SUBAGENT_CHILDREN, { sessionId })) as {
		children: Array<{ sessionId: string }>;
	};
	expect(childrenResp.children).toHaveLength(3);

	const statuses: string[] = [];
	for (const c of childrenResp.children) {
		const rec = await harness.sessionStore.load(c.sessionId);
		const complete = rec?.entries.find((e) => e.type === "subagent_complete");
		expect(complete, `child ${c.sessionId} must have subagent_complete`).toBeDefined();
		statuses.push((complete as { status: string }).status);
	}
	expect(
		statuses.every((s) => s === "cancelled"),
		`every child aborted on parent cancel; got ${JSON.stringify(statuses)}`,
	).toBe(true);

	const parentRecord = await harness.sessionStore.load(sessionId);
	const batchEntry = parentRecord?.entries.find((e) => e.type === "subagent_batch");
	expect(batchEntry, "SubagentBatchEntry still appended on parent after cancellation").toBeDefined();
	expect((batchEntry as { statuses: string[] }).statuses).toEqual(["cancelled", "cancelled", "cancelled"]);
});
