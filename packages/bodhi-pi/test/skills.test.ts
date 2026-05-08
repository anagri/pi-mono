import {
	type Api,
	type Context,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	type Model,
	registerFauxProvider,
	type TextContent,
} from "@mariozechner/pi-ai";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createInMemoryFilesystem, createInMemorySessionStore } from "../src/index.js";
import { stdInitParams } from "./helpers/acp-constants.js";
import { seedCommand, seedSkill } from "./helpers/filesystem.js";
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
	capturedSystemPrompts: Array<string | undefined>;
	capturedUserPrompts: string[];
}

function capturingFaux(): CapturingFaux {
	const faux = newProvider();
	const model = faux.getModel() as Model<Api>;
	const capturedSystemPrompts: Array<string | undefined> = [];
	const capturedUserPrompts: string[] = [];
	faux.setResponses([
		(ctx: Context) => {
			capturedSystemPrompts.push(ctx.systemPrompt);
			for (const m of ctx.messages) {
				if (m.role === "user") capturedUserPrompts.push(userTextOf(m.content));
			}
			return fauxAssistantMessage("ok");
		},
	]);
	return { faux, model, capturedSystemPrompts, capturedUserPrompts };
}

function commandsUpdate(updates: ReturnType<typeof createTestHarness>["updates"]) {
	return updates.find((u) => u.update.sessionUpdate === "available_commands_update")?.update;
}

test("session/new with no skills emits empty available commands", async () => {
	const { model } = capturingFaux();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });

	await harness.clientConn.initialize(stdInitParams);
	await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });

	const upd = commandsUpdate(harness.updates);
	expect(upd).toMatchObject({ availableCommands: [] });
});

test("visible skills appear as `skill:<name>` in available_commands_update and in the system prompt", async () => {
	const { model, capturedSystemPrompts } = capturingFaux();
	const filesystem = createInMemoryFilesystem();
	const cwd = "/proj";
	await seedSkill(filesystem, cwd, "alpha", "---\ndescription: alpha task\n---\nbody-a\n");
	await seedSkill(filesystem, cwd, "zeta", "---\ndescription: zeta task\n---\nbody-z\n");
	const harness = createTestHarness({ models: [model], defaultModelId: model.id, filesystem });

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd, mcpServers: [] });

	const upd = commandsUpdate(harness.updates);
	expect(upd).toMatchObject({
		availableCommands: [
			{ name: "skill:alpha", description: "alpha task" },
			{ name: "skill:zeta", description: "zeta task" },
		],
	});

	// Touch the model so we capture its system prompt.
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "ping" }] });
	expect(capturedSystemPrompts[0]).toContain("<available_skills>");
	expect(capturedSystemPrompts[0]).toContain("<name>alpha</name>");
	expect(capturedSystemPrompts[0]).toContain("<name>zeta</name>");
});

test("hidden skill (disable-model-invocation: true) is advertised but kept out of system prompt", async () => {
	const { model, capturedSystemPrompts } = capturingFaux();
	const filesystem = createInMemoryFilesystem();
	const cwd = "/proj";
	await seedSkill(
		filesystem,
		cwd,
		"hidden-skill",
		"---\ndescription: hidden task\ndisable-model-invocation: true\n---\nhidden body\n",
	);
	const harness = createTestHarness({ models: [model], defaultModelId: model.id, filesystem });

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd, mcpServers: [] });

	const upd = commandsUpdate(harness.updates);
	expect(upd).toMatchObject({ availableCommands: [{ name: "skill:hidden-skill" }] });

	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "ping" }] });
	expect(capturedSystemPrompts[0] ?? "").not.toContain("<available_skills>");
});

test("session/load re-emits available_commands_update and re-applies augmented system prompt", async () => {
	const { model, capturedSystemPrompts } = capturingFaux();
	const filesystem = createInMemoryFilesystem();
	const sessionStore = createInMemorySessionStore();
	const cwd = "/proj";
	await seedSkill(filesystem, cwd, "ping", "---\ndescription: ping\n---\npong body\n");

	const writer = createTestHarness({ models: [model], defaultModelId: model.id, filesystem, sessionStore });
	await writer.clientConn.initialize(stdInitParams);
	const { sessionId } = await writer.clientConn.newSession({ cwd, mcpServers: [] });

	const reader = createTestHarness({ models: [model], defaultModelId: model.id, filesystem, sessionStore });
	await reader.clientConn.initialize(stdInitParams);
	await reader.clientConn.loadSession({ sessionId, cwd, mcpServers: [] });

	const upd = commandsUpdate(reader.updates);
	expect(upd).toMatchObject({ availableCommands: [{ name: "skill:ping" }] });

	await reader.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "ping" }] });
	const lastPrompt = capturedSystemPrompts[capturedSystemPrompts.length - 1];
	expect(lastPrompt).toContain("<available_skills>");
});

test("/skill:<known> wraps body in <skill> XML and appends args", async () => {
	const { model, capturedUserPrompts } = capturingFaux();
	const filesystem = createInMemoryFilesystem();
	const cwd = "/proj";
	await seedSkill(filesystem, cwd, "greet", "---\ndescription: greet\n---\nSay hello.\n");
	const harness = createTestHarness({ models: [model], defaultModelId: model.id, filesystem });

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd, mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "/skill:greet world" }] });

	const seen = capturedUserPrompts[0];
	expect(seen).toContain('<skill name="greet" location="/proj/.bodhi-pi/skills/greet/SKILL.md">');
	expect(seen).toContain("References are relative to /proj/.bodhi-pi/skills/greet.");
	expect(seen).toContain("Say hello.");
	expect(seen.endsWith("</skill>\n\nworld")).toBe(true);
});

test("/skill:<unknown> passes through verbatim", async () => {
	const { model, capturedUserPrompts } = capturingFaux();
	const harness = createTestHarness({ models: [model], defaultModelId: model.id });

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/proj", mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "/skill:nope arg" }] });

	expect(capturedUserPrompts).toContain("/skill:nope arg");
});

test("skills and slash commands coexist in one notification", async () => {
	const { model } = capturingFaux();
	const filesystem = createInMemoryFilesystem();
	const cwd = "/proj";
	await seedSkill(filesystem, cwd, "do-thing", "---\ndescription: do thing\n---\nbody\n");
	await seedCommand(filesystem, cwd, "echo.md", "---\ndescription: echo\n---\nReply: $1\n");
	const harness = createTestHarness({ models: [model], defaultModelId: model.id, filesystem });

	await harness.clientConn.initialize(stdInitParams);
	await harness.clientConn.newSession({ cwd, mcpServers: [] });

	const upd = commandsUpdate(harness.updates);
	expect(upd).toMatchObject({
		availableCommands: [
			{ name: "echo", description: "echo" },
			{ name: "skill:do-thing", description: "do thing" },
		],
	});
});
