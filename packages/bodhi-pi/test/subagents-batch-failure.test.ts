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

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

test("collect-all default: one failing child does NOT cancel siblings; each child's status surfaces independently", async () => {
	const filesystem = createInMemoryFilesystem();
	await seedSubagent(filesystem, "/proj", "good-a", "---\ndescription: good a\n---\nYou are good-a.\n");
	await seedSubagent(filesystem, "/proj", "bad-b", "---\ndescription: bad b\n---\nYou are bad-b.\n");
	await seedSubagent(filesystem, "/proj", "good-c", "---\ndescription: good c\n---\nYou are good-c.\n");

	const faux = newProvider();
	const model = faux.getModel() as Model<Api>;
	scriptSubagentRun(faux, {
		parentTurns: [
			{
				tool: "subagent_batch",
				args: {
					tasks: [
						{ agent: "good-a", task: "ok a" },
						{ agent: "bad-b", task: "fail b" },
						{ agent: "good-c", task: "ok c" },
					],
				},
			},
		],
		childResponses: [
			async () => {
				await sleep(50);
				return fauxAssistantMessage("a done");
			},
			async () => {
				await sleep(20);
				return fauxAssistantMessage("b boom", { stopReason: "error", errorMessage: "boom" });
			},
			async () => {
				await sleep(50);
				return fauxAssistantMessage("c done");
			},
		],
		finalText: "parent wrap-up",
	});

	const harness = createTestHarness({ models: [model], defaultModelId: model.id, filesystem });
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	await harness.clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: "batch a, b (failing), c" }],
	});

	const childrenResp = (await harness.clientConn.extMethod(EXT_SUBAGENT_CHILDREN, { sessionId })) as {
		children: Array<{ sessionId: string; subagent?: { profileName: string } }>;
	};
	expect(childrenResp.children).toHaveLength(3);

	const byProfile = new Map<string, string>();
	for (const c of childrenResp.children) {
		const rec = await harness.sessionStore.load(c.sessionId);
		const complete = rec?.entries.find((e) => e.type === "subagent_complete");
		expect(complete, `child ${c.subagent?.profileName} has subagent_complete`).toBeDefined();
		byProfile.set(c.subagent?.profileName ?? "?", (complete as { status: string }).status);
	}
	expect(byProfile.get("good-a"), "good-a completes despite bad-b failing").toBe("completed");
	expect(byProfile.get("bad-b"), "bad-b is recorded as failed").toBe("failed");
	expect(byProfile.get("good-c"), "good-c completes despite bad-b failing").toBe("completed");

	const parentRecord = await harness.sessionStore.load(sessionId);
	const batchEntry = parentRecord?.entries.find((e) => e.type === "subagent_batch");
	expect(batchEntry, "batch entry records per-child statuses").toMatchObject({
		profileNames: ["good-a", "bad-b", "good-c"],
		statuses: ["completed", "failed", "completed"],
	});
});

test("failFast: true cancels in-flight siblings when one child fails before others finish", async () => {
	const filesystem = createInMemoryFilesystem();
	await seedSubagent(filesystem, "/proj", "slow-a", "---\ndescription: slow a\n---\nYou are slow-a.\n");
	await seedSubagent(filesystem, "/proj", "quick-fail-b", "---\ndescription: quick fail\n---\nYou fail fast.\n");
	await seedSubagent(filesystem, "/proj", "slow-c", "---\ndescription: slow c\n---\nYou are slow-c.\n");

	const faux = newProvider();
	const model = faux.getModel() as Model<Api>;
	scriptSubagentRun(faux, {
		parentTurns: [
			{
				tool: "subagent_batch",
				args: {
					tasks: [
						{ agent: "slow-a", task: "wait" },
						{ agent: "quick-fail-b", task: "fail" },
						{ agent: "slow-c", task: "wait" },
					],
					failFast: true,
				},
			},
		],
		childResponses: [
			abortableAssistant("a done", 2000),
			async () => {
				await sleep(50);
				return fauxAssistantMessage("b boom", { stopReason: "error", errorMessage: "boom" });
			},
			abortableAssistant("c done", 2000),
		],
		finalText: "parent wrap-up",
	});

	const harness = createTestHarness({ models: [model], defaultModelId: model.id, filesystem });
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	const start = Date.now();
	await harness.clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: "failFast batch where b fails fast" }],
	});
	const elapsed = Date.now() - start;
	expect(elapsed, "failFast aborts siblings before their 2000ms response settles").toBeLessThan(1500);

	const childrenResp = (await harness.clientConn.extMethod(EXT_SUBAGENT_CHILDREN, { sessionId })) as {
		children: Array<{ sessionId: string; subagent?: { profileName: string } }>;
	};
	expect(childrenResp.children).toHaveLength(3);

	const byProfile = new Map<string, string>();
	for (const c of childrenResp.children) {
		const rec = await harness.sessionStore.load(c.sessionId);
		const complete = rec?.entries.find((e) => e.type === "subagent_complete");
		expect(complete, `child ${c.subagent?.profileName} has subagent_complete`).toBeDefined();
		byProfile.set(c.subagent?.profileName ?? "?", (complete as { status: string }).status);
	}
	expect(byProfile.get("quick-fail-b"), "quick-fail-b failed and triggered abort").toBe("failed");
	expect(byProfile.get("slow-a"), "slow-a is cancelled by failFast").toBe("cancelled");
	expect(byProfile.get("slow-c"), "slow-c is cancelled by failFast").toBe("cancelled");
});
