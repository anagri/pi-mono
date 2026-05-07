import {
	type Api,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	type Model,
	registerFauxProvider,
	type TextContent,
} from "@mariozechner/pi-ai";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createInMemoryFilesystem, createInMemorySessionStore } from "../src/index.js";
import { stdInitParams } from "./helpers/acp-constants.js";
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

function userTextOf(content: string | Array<TextContent | unknown>): string {
	if (typeof content === "string") return content;
	return content
		.filter((b): b is TextContent => (b as { type?: unknown }).type === "text")
		.map((b) => b.text)
		.join("");
}

interface CapturingFaux {
	faux: FauxProviderRegistration;
	model: Model<Api>;
	capturedUserPrompts: string[];
}

function capturingFaux(): CapturingFaux {
	const faux = newProvider();
	const model = faux.getModel() as Model<Api>;
	const capturedUserPrompts: string[] = [];
	faux.setResponses([
		(ctx) => {
			for (const m of ctx.messages) {
				if (m.role === "user") capturedUserPrompts.push(userTextOf(m.content));
			}
			return fauxAssistantMessage("ok");
		},
	]);
	return { faux, model, capturedUserPrompts };
}

async function seedCommand(
	filesystem: ReturnType<typeof createInMemoryFilesystem>,
	cwd: string,
	name: string,
	body: string,
): Promise<void> {
	const dir = `${cwd === "/" ? "" : cwd}/.bodhi-pi/commands`;
	await filesystem.mkdir(dir, { recursive: true });
	await filesystem.writeTextFile(`${dir}/${name}`, body);
}

function commandsUpdates(updates: ReturnType<typeof createTestHarness>["updates"]) {
	return updates.filter((u) => u.update.sessionUpdate === "available_commands_update");
}

test("session/new emits available_commands_update with empty list when dir missing", async () => {
	const { model } = capturingFaux();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });

	await harness.clientConn.initialize(stdInitParams);
	await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	const cmd = commandsUpdates(harness.updates);
	expect(cmd).toHaveLength(1);
	expect(cmd[0].update).toMatchObject({
		sessionUpdate: "available_commands_update",
		availableCommands: [],
	});
});

test("session/new emits sorted commands with frontmatter mapped to AvailableCommand", async () => {
	const { model } = capturingFaux();
	const filesystem = createInMemoryFilesystem();
	const cwd = "/proj";
	await seedCommand(filesystem, cwd, "zeta.md", "---\ndescription: zeta cmd\n---\nbody-z\n");
	await seedCommand(
		filesystem,
		cwd,
		"alpha.md",
		"---\ndescription: alpha cmd\nargument-hint: <name>\n---\nbody-a $1\n",
	);
	const harness = createTestHarness({ models: [model], defaultModelId: model.id, filesystem });

	await harness.clientConn.initialize(stdInitParams);
	await harness.clientConn.newSession({ cwd, mcpServers: [] });

	const cmd = commandsUpdates(harness.updates);
	expect(cmd).toHaveLength(1);
	expect(cmd[0].update).toMatchObject({
		sessionUpdate: "available_commands_update",
		availableCommands: [
			{ name: "alpha", description: "alpha cmd", input: { hint: "<name>" } },
			{ name: "zeta", description: "zeta cmd" },
		],
	});
});

test("session/load re-emits available_commands_update", async () => {
	const { model } = capturingFaux();
	const sessionStore = createInMemorySessionStore();
	const filesystem = createInMemoryFilesystem();
	const cwd = "/proj";
	await seedCommand(filesystem, cwd, "ping.md", "---\ndescription: ping\n---\npong\n");

	const writer = createTestHarness({ models: [model], defaultModelId: model.id, sessionStore, filesystem });
	await writer.clientConn.initialize(stdInitParams);
	const { sessionId } = await writer.clientConn.newSession({ cwd, mcpServers: [] });

	const reader = createTestHarness({ models: [model], defaultModelId: model.id, sessionStore, filesystem });
	await reader.clientConn.initialize(stdInitParams);
	await reader.clientConn.loadSession({ sessionId, cwd, mcpServers: [] });

	const cmd = commandsUpdates(reader.updates);
	expect(cmd).toHaveLength(1);
	expect(cmd[0].update).toMatchObject({
		sessionUpdate: "available_commands_update",
		availableCommands: [{ name: "ping", description: "ping" }],
	});
});

test("session/resume re-emits available_commands_update", async () => {
	const { model } = capturingFaux();
	const sessionStore = createInMemorySessionStore();
	const filesystem = createInMemoryFilesystem();
	const cwd = "/proj";
	await seedCommand(filesystem, cwd, "ping.md", "---\ndescription: ping\n---\npong\n");

	const writer = createTestHarness({ models: [model], defaultModelId: model.id, sessionStore, filesystem });
	await writer.clientConn.initialize(stdInitParams);
	const { sessionId } = await writer.clientConn.newSession({ cwd, mcpServers: [] });

	const reader = createTestHarness({ models: [model], defaultModelId: model.id, sessionStore, filesystem });
	await reader.clientConn.initialize(stdInitParams);
	await reader.clientConn.resumeSession({ sessionId, cwd, mcpServers: [] });

	const cmd = commandsUpdates(reader.updates);
	expect(cmd).toHaveLength(1);
	expect(cmd[0].update).toMatchObject({ availableCommands: [{ name: "ping" }] });
});

test("/<known> args expands template body before LLM sees it", async () => {
	const { faux, model, capturedUserPrompts } = capturingFaux();
	const filesystem = createInMemoryFilesystem();
	const cwd = "/proj";
	await seedCommand(
		filesystem,
		cwd,
		"echo.md",
		"---\ndescription: echo\nargument-hint: <word>\n---\nReply with: $1\n",
	);
	const harness = createTestHarness({ models: [model], defaultModelId: model.id, filesystem });

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd, mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "/echo banana" }] });

	expect(capturedUserPrompts).toContain("Reply with: banana\n");
	expect(faux.state.callCount).toBe(1);
});

test("/<unknown> arg passes through verbatim", async () => {
	const { capturedUserPrompts, model } = capturingFaux();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "/notreal hi" }] });

	expect(capturedUserPrompts).toContain("/notreal hi");
});

test("plain text without leading slash is passed through unchanged", async () => {
	const { capturedUserPrompts, model } = capturingFaux();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "hello there" }] });

	expect(capturedUserPrompts).toContain("hello there");
});
