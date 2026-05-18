import {
	type Api,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	fauxToolCall,
	type Model,
	registerFauxProvider,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test } from "vitest";
import { type BodhiPiEvent, createInMemoryFilesystem, EXT_SUBAGENT_CHILDREN } from "@/index.js";
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

test("spawn creates a child session linked via parentSessionId + subagent and persists link + complete entries", async () => {
	const filesystem = createInMemoryFilesystem();
	await seedSubagent(
		filesystem,
		"/proj",
		"extractor",
		"---\ndescription: read and summarize\ntools:\n  - read\n---\nYou are an extractor.\n",
	);

	await filesystem.mkdir("/proj", { recursive: true });
	await filesystem.writeTextFile("/proj/doc.md", "The quick brown fox jumps over the lazy dog.");

	const faux = newProvider();
	const model = faux.getModel() as Model<Api>;
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("subagent", { agent: "extractor", task: "summarize /proj/doc.md" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage([fauxToolCall("read", { path: "/proj/doc.md" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("The fox jumped over the dog."),
		fauxAssistantMessage("Subagent reported back with the summary."),
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
		prompt: [{ type: "text", text: "Use the extractor agent to summarize /proj/doc.md." }],
	});

	const childrenResp = (await harness.clientConn.extMethod(EXT_SUBAGENT_CHILDREN, { sessionId })) as {
		children: Array<{ sessionId: string; parentSessionId?: string; subagent?: { profileName: string } }>;
	};
	expect(childrenResp.children).toHaveLength(1);
	const childId = childrenResp.children[0].sessionId;
	expect(childrenResp.children[0].parentSessionId).toBe(sessionId);
	expect(childrenResp.children[0].subagent).toEqual({ profileName: "extractor" });

	const childRecord = await harness.sessionStore.load(childId);
	expect(childRecord).toBeDefined();
	expect(childRecord!.entries[0]).toMatchObject({
		type: "subagent_link",
		parentSessionId: sessionId,
		profileName: "extractor",
		task: "summarize /proj/doc.md",
		depth: 1,
	});
	const completeEntry = childRecord!.entries.find((e) => e.type === "subagent_complete");
	expect(completeEntry).toMatchObject({
		type: "subagent_complete",
		status: "completed",
	});

	const defaultList = await harness.clientConn.listSessions({ cwd: "/proj" });
	const defaultIds = defaultList.sessions.map((s: { sessionId: string }) => s.sessionId);
	expect(defaultIds).toContain(sessionId);
	expect(defaultIds).not.toContain(childId);

	expect(events.map((e) => e.type)).toEqual(["subagent_start", "subagent_end"]);
	const endEvent = events.find((e) => e.type === "subagent_end")!;
	expect(endEvent).toMatchObject({
		parentSessionId: sessionId,
		childSessionId: childId,
		profile: "extractor",
		status: "completed",
	});
});

test("spawn via _bodhi-pi/subagent/run returns structured result", async () => {
	const filesystem = createInMemoryFilesystem();
	await seedSubagent(filesystem, "/proj", "echo", "---\ndescription: echo back\n---\nYou are an echo agent.\n");

	const faux = newProvider();
	const model = faux.getModel() as Model<Api>;
	faux.setResponses([() => fauxAssistantMessage("hello back")]);

	const harness = createTestHarness({ models: [model], defaultModelId: model.id, filesystem });
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	const res = (await harness.clientConn.extMethod("_bodhi-pi/subagent/run", {
		sessionId,
		agent: "echo",
		task: "say hello",
	})) as { childSessionId: string; status: string; summary?: string; durationMs: number; toolCount: number };

	expect(res.status).toBe("completed");
	expect(res.childSessionId).toBeTypeOf("string");
	expect(res.summary).toContain("hello back");
	expect(res.toolCount).toBe(0);
});
