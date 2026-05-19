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
	type SubagentEndEvent,
	type SubagentStartEvent,
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

test("parallel `subagent` tool calls in one assistant turn spawn truly-parallel children (serverTime overlap proves concurrency)", async () => {
	const filesystem = createInMemoryFilesystem();
	await seedSubagent(filesystem, "/proj", "alpha", "---\ndescription: alpha\n---\nYou are alpha.\n");
	await seedSubagent(filesystem, "/proj", "beta", "---\ndescription: beta\n---\nYou are beta.\n");
	await seedSubagent(filesystem, "/proj", "gamma", "---\ndescription: gamma\n---\nYou are gamma.\n");

	const faux = newProvider();
	const model = faux.getModel() as Model<Api>;
	const childDelayMs = 120;
	faux.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall("subagent", { agent: "alpha", task: "do alpha" }),
				fauxToolCall("subagent", { agent: "beta", task: "do beta" }),
				fauxToolCall("subagent", { agent: "gamma", task: "do gamma" }),
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
			subagent_start: [(e) => void events.push(e)],
			subagent_end: [(e) => void events.push(e)],
		},
	});

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	await harness.clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: "Run alpha, beta, gamma via separate subagent calls in parallel." }],
	});

	const starts = events.filter((e): e is SubagentStartEvent => e.type === "subagent_start");
	const ends = events.filter((e): e is SubagentEndEvent => e.type === "subagent_end");
	expect(starts, "all 3 children must start").toHaveLength(3);
	expect(ends, "all 3 children must end").toHaveLength(3);

	const startsByProfile = new Map(starts.map((e) => [e.profileName, e]));
	const endsByProfile = new Map(ends.map((e) => [e.profileName, e]));
	const profiles = ["alpha", "beta", "gamma"] as const;
	for (const p of profiles) {
		const s = startsByProfile.get(p);
		const e = endsByProfile.get(p);
		expect(s, `start.serverTime for ${p}`).toBeDefined();
		expect(e, `end.serverTime for ${p}`).toBeDefined();
		expect(typeof s?.serverTime, `start.serverTime number for ${p}`).toBe("number");
		expect(typeof e?.serverTime, `end.serverTime number for ${p}`).toBe("number");
		expect(e?.status).toBe("completed");
	}

	const startTimes = profiles.map((p) => startsByProfile.get(p)!.serverTime ?? 0);
	const endTimes = profiles.map((p) => endsByProfile.get(p)!.serverTime ?? 0);
	const maxStart = Math.max(...startTimes);
	const minEnd = Math.min(...endTimes);
	expect(
		maxStart,
		"true parallelism: latest start must precede earliest end (children overlap in wall-clock time)",
	).toBeLessThanOrEqual(minEnd);

	const childrenResp = (await harness.clientConn.extMethod(EXT_SUBAGENT_CHILDREN, { sessionId })) as {
		children: Array<{ sessionId: string; subagent?: { profileName: string } }>;
	};
	expect(childrenResp.children, "3 children persisted on parent").toHaveLength(3);
	const persistedProfiles = childrenResp.children.map((c) => c.subagent?.profileName).sort();
	expect(persistedProfiles).toEqual(["alpha", "beta", "gamma"]);

	const lifecycle = harness.extNotifications.filter((n) => n.method === LIFECYCLE_EVENT_METHOD);
	const wireStarts = lifecycle.filter((n) => (n.params as { type?: string }).type === "subagent_start");
	const wireEnds = lifecycle.filter((n) => (n.params as { type?: string }).type === "subagent_end");
	expect(wireStarts, "3 subagent_start events on the wire").toHaveLength(3);
	expect(wireEnds, "3 subagent_end events on the wire").toHaveLength(3);
	for (const n of [...wireStarts, ...wireEnds]) {
		expect(typeof (n.params as { serverTime?: number }).serverTime, "wire-forwarded serverTime is a number").toBe(
			"number",
		);
	}
});

test("parallel `subagent` tool calls do NOT emit the (now-internal) subagent_batch_start envelope", async () => {
	const filesystem = createInMemoryFilesystem();
	await seedSubagent(filesystem, "/proj", "echo", "---\ndescription: echo\n---\nYou echo.\n");

	const faux = newProvider();
	const model = faux.getModel() as Model<Api>;
	faux.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall("subagent", { agent: "echo", task: "one" }),
				fauxToolCall("subagent", { agent: "echo", task: "two" }),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("one done"),
		fauxAssistantMessage("two done"),
		fauxAssistantMessage("both done"),
	]);

	const events: BodhiPiEvent[] = [];
	const harness = createTestHarness({
		models: [model],
		defaultModelId: model.id,
		filesystem,
		eventHandlers: {
			subagent_batch_start: [(e) => void events.push(e)],
			subagent_batch_end: [(e) => void events.push(e)],
		},
	});

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	await harness.clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: "Two parallel subagent calls." }],
	});

	expect(events, "subagent_batch_* events must NOT fire when parallel dispatch goes through subagent tool").toEqual(
		[],
	);
});
