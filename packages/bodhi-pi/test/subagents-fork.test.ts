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

test("context: fork spawns a child whose initial messages include the parent's transcript", async () => {
	const filesystem = createInMemoryFilesystem();
	await seedSubagent(
		filesystem,
		"/proj",
		"reviewer",
		"---\ndescription: review the parent's read\ncontext: fork\ntools:\n  - read\n---\nYou are a reviewer.\n",
	);
	await filesystem.mkdir("/proj", { recursive: true });
	await filesystem.writeTextFile("/proj/diff.md", "renamed fooHandler to BLUE_FORK_42_handler");

	const capturedChildMessageCount: number[] = [];
	let capturedChildMessages: unknown[] = [];
	const faux = newProvider();
	const model = faux.getModel() as Model<Api>;
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("read", { path: "/proj/diff.md" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("The diff renames fooHandler to BLUE_FORK_42_handler."),
		(ctx) => {
			capturedChildMessageCount.push(ctx.messages.length);
			capturedChildMessages = ctx.messages as unknown[];
			return fauxAssistantMessage("Reviewer sees BLUE_FORK_42_handler in the inherited transcript.");
		},
	]);

	const harness = createTestHarness({ models: [model], defaultModelId: model.id, filesystem });
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	await harness.clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: "Read /proj/diff.md and summarize the change." }],
	});

	const result = (await harness.clientConn.extMethod(EXT_SUBAGENT_RUN, {
		sessionId,
		agent: "reviewer",
		task: "Review the diff you can see in the inherited transcript.",
	})) as { childSessionId: string; status: string };
	expect(result.status).toBe("completed");

	expect(capturedChildMessageCount, "child faux provider must have been called once").toHaveLength(1);
	expect(
		capturedChildMessageCount[0],
		"child should see parent transcript turns + own task user turn",
	).toBeGreaterThanOrEqual(4);

	const childTexts = capturedChildMessages
		.flatMap((m) => (m as { content?: unknown[] }).content ?? [])
		.filter(
			(b): b is { type: "text"; text: string } =>
				typeof b === "object" && b !== null && (b as { type?: string }).type === "text",
		)
		.map((b) => b.text);
	expect(childTexts.some((t) => t.includes("BLUE_FORK_42_handler"))).toBe(true);
	expect(childTexts.some((t) => t.includes("Read /proj/diff.md"))).toBe(true);
});

test("subagent_link entry on the child carries contextMode='fork' when spawned via fork profile", async () => {
	const filesystem = createInMemoryFilesystem();
	await seedSubagent(
		filesystem,
		"/proj",
		"reviewer",
		"---\ndescription: review\ncontext: fork\n---\nYou are a reviewer.\n",
	);

	const faux = newProvider();
	const model = faux.getModel() as Model<Api>;
	faux.setResponses([() => fauxAssistantMessage("reviewer done")]);

	const harness = createTestHarness({ models: [model], defaultModelId: model.id, filesystem });
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	const result = (await harness.clientConn.extMethod(EXT_SUBAGENT_RUN, {
		sessionId,
		agent: "reviewer",
		task: "anything",
	})) as { childSessionId: string };

	const childRecord = await harness.sessionStore.load(result.childSessionId);
	expect(childRecord).toBeDefined();
	const link = childRecord!.entries.find((e) => e.type === "subagent_link");
	expect(link).toMatchObject({ type: "subagent_link", contextMode: "fork" });
});

test("subagent_link entry on the child carries contextMode='fresh' when spawned via fresh profile", async () => {
	const filesystem = createInMemoryFilesystem();
	await seedSubagent(filesystem, "/proj", "echo", "---\ndescription: echo\n---\nYou echo.\n");

	const faux = newProvider();
	const model = faux.getModel() as Model<Api>;
	faux.setResponses([() => fauxAssistantMessage("ok")]);

	const harness = createTestHarness({ models: [model], defaultModelId: model.id, filesystem });
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	const result = (await harness.clientConn.extMethod(EXT_SUBAGENT_RUN, {
		sessionId,
		agent: "echo",
		task: "anything",
	})) as { childSessionId: string };

	const childRecord = await harness.sessionStore.load(result.childSessionId);
	const link = childRecord!.entries.find((e) => e.type === "subagent_link");
	expect(link).toMatchObject({ type: "subagent_link", contextMode: "fresh" });
});

test("fork excludes mcp_inclusion_set and subagent_link entries from the child's view", async () => {
	const filesystem = createInMemoryFilesystem();
	await seedSubagent(
		filesystem,
		"/proj",
		"reviewer",
		"---\ndescription: review\ncontext: fork\n---\nYou are a reviewer.\n",
	);

	let capturedChildMessages: unknown[] = [];
	const faux = newProvider();
	const model = faux.getModel() as Model<Api>;
	faux.setResponses([
		fauxAssistantMessage("parent text turn"),
		(ctx) => {
			capturedChildMessages = ctx.messages as unknown[];
			return fauxAssistantMessage("child done");
		},
	]);

	const harness = createTestHarness({ models: [model], defaultModelId: model.id, filesystem });
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	await harness.clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: "first parent turn" }],
	});

	await harness.sessionStore.append(sessionId, {
		type: "mcp_inclusion_set",
		id: "mcp-noise-1",
		parentId: null,
		timestamp: Date.now(),
		slugs: ["should-not-leak-to-child"],
	});
	await harness.sessionStore.append(sessionId, {
		type: "extension",
		id: "ext-noise-1",
		parentId: null,
		timestamp: Date.now(),
		extensionName: "ext",
		customType: "marker",
		data: { secret: "noise-from-parent" },
	});

	await harness.clientConn.extMethod(EXT_SUBAGENT_RUN, {
		sessionId,
		agent: "reviewer",
		task: "do",
	});

	const childTexts = capturedChildMessages
		.flatMap((m) => (m as { content?: unknown[] }).content ?? [])
		.filter(
			(b): b is { type: "text"; text: string } =>
				typeof b === "object" && b !== null && (b as { type?: string }).type === "text",
		)
		.map((b) => b.text)
		.join("\n");

	expect(childTexts).not.toContain("should-not-leak-to-child");
	expect(childTexts).not.toContain("noise-from-parent");
});
