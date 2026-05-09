import fsNode from "node:fs/promises";
import path from "node:path";
import { getModel } from "@mariozechner/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { type CliTestHarness, createCliTestHarness } from "@test/helpers/cli-harness.js";
import { chunkedAgentText } from "@test/helpers/notifications.js";
import { seedWorkspace, templates } from "@test/helpers/seed-workspace.js";
import { afterEach, expect, test } from "vitest";

const OPENAI_KEY = process.env.OPENAI_API_KEY!;

let harness: CliTestHarness;

afterEach(async () => {
	await harness?.cleanup();
});

test("/<no-args> command (.bodhi-pi/commands/*.md) expands and the LLM sees the body", async () => {
	harness = await createCliTestHarness({ model: getModel("openai", "gpt-4o-mini"), apiKey: OPENAI_KEY });
	await seedWorkspace(harness.tmpDir, { commands: { "say-tuesday.md": templates.commands.sayTuesday } });

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: harness.tmpDir, mcpServers: [] });
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "/say-tuesday" }] });

	expect(chunkedAgentText(harness.updates).toLowerCase()).toContain("tuesday");
});

test("/<known> arg expands $1 with user-supplied value across two consecutive prompts", async () => {
	harness = await createCliTestHarness({ model: getModel("openai", "gpt-4o-mini"), apiKey: OPENAI_KEY });
	await seedWorkspace(harness.tmpDir, { commands: { "echo.md": templates.commands.echo } });

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: harness.tmpDir, mcpServers: [] });

	for (const word of ["banana", "cherry"]) {
		harness.updates.length = 0;
		await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: `/echo ${word}` }] });
		expect(chunkedAgentText(harness.updates).toLowerCase(), `expected ${word} in response`).toContain(word);
	}
});

test("/<known> arg expands into a tool-using prompt and the file is written to the real Node filesystem", async () => {
	harness = await createCliTestHarness({ model: getModel("openai", "gpt-4o-mini"), apiKey: OPENAI_KEY });
	const writeFileTemplate = [
		"---",
		"description: Write a fixed line into a file",
		"argument-hint: <path>",
		"---",
		"Use the write tool to create the file $1 with exactly the text: hello world",
	].join("\n");
	await seedWorkspace(harness.tmpDir, { commands: { "write-file.md": writeFileTemplate } });

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: harness.tmpDir, mcpServers: [] });
	const target = path.join(harness.tmpDir, "out.txt");
	await harness.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: `/write-file ${target}` }] });

	const stored = await fsNode.readFile(target, "utf8");
	expect(stored.toLowerCase()).toContain("hello world");
});

test("available_commands_update lists project commands after newSession", async () => {
	harness = await createCliTestHarness({ model: getModel("openai", "gpt-4o-mini"), apiKey: OPENAI_KEY });
	await seedWorkspace(harness.tmpDir, {
		commands: {
			"echo.md": templates.commands.echo,
			"say-tuesday.md": templates.commands.sayTuesday,
		},
	});

	await harness.clientConn.initialize(stdInitParams);
	await harness.clientConn.newSession({ cwd: harness.tmpDir, mcpServers: [] });

	const update = harness.updates.find((u) => u.update.sessionUpdate === "available_commands_update");
	expect(update, "expected available_commands_update notification on session/new").toBeDefined();
	const names = ((update?.update as { availableCommands?: Array<{ name: string }> }).availableCommands ?? []).map(
		(c) => c.name,
	);
	expect(names).toContain("echo");
	expect(names).toContain("say-tuesday");
});
