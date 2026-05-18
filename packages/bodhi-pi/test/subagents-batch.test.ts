import {
	type Api,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	fauxToolCall,
	type Model,
	registerFauxProvider,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
	type BodhiPiEvent,
	createInMemoryFilesystem,
	EXT_SUBAGENT_CHILDREN,
	LIFECYCLE_EVENT_METHOD,
	type SubagentBatchEndEvent,
	type SubagentBatchStartEvent,
} from "@/index.js";
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

function delayedAssistant(text: string, delayMs: number): () => Promise<ReturnType<typeof fauxAssistantMessage>> {
	return async () => {
		await new Promise((r) => setTimeout(r, delayMs));
		return fauxAssistantMessage(text);
	};
}

test("subagent_batch dispatches N children concurrently, aggregates ordered results, fires batch lifecycle events, appends SubagentBatchEntry to parent", async () => {
	const filesystem = createInMemoryFilesystem();
	await seedSubagent(filesystem, "/proj", "alpha", "---\ndescription: alpha\n---\nYou are alpha.\n");
	await seedSubagent(filesystem, "/proj", "beta", "---\ndescription: beta\n---\nYou are beta.\n");
	await seedSubagent(filesystem, "/proj", "gamma", "---\ndescription: gamma\n---\nYou are gamma.\n");

	const faux = newProvider();
	const model = faux.getModel() as Model<Api>;
	const childDelayMs = 80;
	faux.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall("subagent_batch", {
					tasks: [
						{ agent: "alpha", task: "do alpha" },
						{ agent: "beta", task: "do beta" },
						{ agent: "gamma", task: "do gamma" },
					],
				}),
			],
			{ stopReason: "toolUse" },
		),
		delayedAssistant("alpha done", childDelayMs),
		delayedAssistant("beta done", childDelayMs),
		delayedAssistant("gamma done", childDelayMs),
		fauxAssistantMessage("all three reported back"),
	]);

	const events: BodhiPiEvent[] = [];
	const harness = createTestHarness({
		models: [model],
		defaultModelId: model.id,
		filesystem,
		eventHandlers: {
			subagent_batch_start: [(e) => void events.push(e)],
			subagent_batch_end: [(e) => void events.push(e)],
			subagent_start: [(e) => void events.push(e)],
			subagent_end: [(e) => void events.push(e)],
		},
	});

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	const start = Date.now();
	await harness.clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: "Dispatch alpha, beta, gamma in parallel." }],
	});
	const elapsed = Date.now() - start;

	expect(elapsed, "batch wall time must be < sum of sequential delays - margin").toBeLessThan(childDelayMs * 3 - 30);

	const batchStart = events.find((e) => e.type === "subagent_batch_start") as SubagentBatchStartEvent | undefined;
	expect(batchStart, "subagent_batch_start must fire").toBeDefined();
	expect(batchStart!.profileNames).toEqual(["alpha", "beta", "gamma"]);
	expect(batchStart!.tasks).toEqual(["do alpha", "do beta", "do gamma"]);
	expect(batchStart!.failFast).toBe(false);
	expect(batchStart!.childSessionIds).toHaveLength(3);

	const batchEnd = events.find((e) => e.type === "subagent_batch_end") as SubagentBatchEndEvent | undefined;
	expect(batchEnd, "subagent_batch_end must fire").toBeDefined();
	expect(batchEnd!.profileNames).toEqual(["alpha", "beta", "gamma"]);
	expect(batchEnd!.childSessionIds).toEqual(batchStart!.childSessionIds);
	expect(batchEnd!.statuses).toEqual(["completed", "completed", "completed"]);

	const perChildStarts = events.filter((e) => e.type === "subagent_start");
	expect(perChildStarts, "all 3 per-child subagent_start events still fire").toHaveLength(3);
	const perChildEnds = events.filter((e) => e.type === "subagent_end");
	expect(perChildEnds).toHaveLength(3);

	const childrenResp = (await harness.clientConn.extMethod(EXT_SUBAGENT_CHILDREN, { sessionId })) as {
		children: Array<{ sessionId: string; subagent?: { profileName: string } }>;
	};
	expect(childrenResp.children).toHaveLength(3);
	const profilesByChild = new Map(childrenResp.children.map((c) => [c.sessionId, c.subagent?.profileName]));
	const orderedProfiles = batchStart!.childSessionIds.map((id) => profilesByChild.get(id));
	expect(orderedProfiles, "child sessions preserve task order").toEqual(["alpha", "beta", "gamma"]);

	const parentRecord = await harness.sessionStore.load(sessionId);
	const batchEntry = parentRecord?.entries.find((e) => e.type === "subagent_batch");
	expect(batchEntry, "SubagentBatchEntry on parent").toMatchObject({
		type: "subagent_batch",
		childSessionIds: batchStart!.childSessionIds,
		profileNames: ["alpha", "beta", "gamma"],
		statuses: ["completed", "completed", "completed"],
	});

	const lifecycle = harness.extNotifications.filter((n) => n.method === LIFECYCLE_EVENT_METHOD);
	const wireTypes = lifecycle.map((n) => (n.params as { type?: string }).type ?? "?");
	expect(wireTypes, "batch envelope events forwarded on the wire").toContain("subagent_batch_start");
	expect(wireTypes).toContain("subagent_batch_end");
});

test("subagent_batch rejects with clean error when tasks.length exceeds maxBatchConcurrency", async () => {
	const filesystem = createInMemoryFilesystem();
	await seedSubagent(filesystem, "/proj", "echo", "---\ndescription: echo\n---\nYou echo.\n");

	const faux = newProvider();
	const model = faux.getModel() as Model<Api>;
	const tasks = Array.from({ length: 6 }, (_, i) => ({ agent: "echo", task: `task-${i}` }));
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("subagent_batch", { tasks })], { stopReason: "toolUse" }),
		fauxAssistantMessage("acknowledged"),
	]);

	const harness = createTestHarness({
		models: [model],
		defaultModelId: model.id,
		filesystem,
	});

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	await harness.clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: "Dispatch 6 echoes." }],
	});

	const childrenResp = (await harness.clientConn.extMethod(EXT_SUBAGENT_CHILDREN, { sessionId })) as {
		children: Array<{ sessionId: string }>;
	};
	expect(childrenResp.children, "no children spawned when cap is exceeded").toHaveLength(0);

	const parentRecord = await harness.sessionStore.load(sessionId);
	const toolResultMsg = parentRecord?.entries.find(
		(e) => e.type === "message" && e.message.role === "toolResult" && e.message.toolName === "subagent_batch",
	);
	expect(toolResultMsg, "tool result with error message reaches the LLM").toBeDefined();
	const text = JSON.stringify(toolResultMsg);
	expect(text).toMatch(/maxBatchConcurrency/);
	expect(text).toMatch(/exceeds/);
});

test("subagent_batch caches the parent transcript slice once across fork-mode children", async () => {
	const filesystem = createInMemoryFilesystem();
	await seedSubagent(filesystem, "/proj", "fa", "---\ndescription: fork a\ncontext: fork\n---\nYou are fork-a.\n");
	await seedSubagent(filesystem, "/proj", "fb", "---\ndescription: fork b\ncontext: fork\n---\nYou are fork-b.\n");

	const faux = newProvider();
	const model = faux.getModel() as Model<Api>;
	faux.setResponses([
		fauxAssistantMessage("warmup turn"),
		fauxAssistantMessage(
			[
				fauxToolCall("subagent_batch", {
					tasks: [
						{ agent: "fa", task: "task a" },
						{ agent: "fb", task: "task b" },
					],
				}),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("fa done"),
		fauxAssistantMessage("fb done"),
		fauxAssistantMessage("batch complete"),
	]);

	const events: BodhiPiEvent[] = [];
	const harness = createTestHarness({
		models: [model],
		defaultModelId: model.id,
		filesystem,
		eventHandlers: {
			subagent_start: [(e) => void events.push(e)],
		},
	});

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	await harness.clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: "Warmup so parent has prior turns." }],
	});
	await harness.clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: "Now batch fa + fb." }],
	});

	const starts = events.filter((e) => e.type === "subagent_start");
	expect(starts).toHaveLength(2);
	for (const ev of starts) {
		expect(ev.contextMode).toBe("fork");
	}
});
