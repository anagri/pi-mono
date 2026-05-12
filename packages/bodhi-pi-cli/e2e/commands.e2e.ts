import fsNode from "node:fs/promises";
import path from "node:path";
import { getModel } from "@earendil-works/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { type CliTestHarness, createCliTestHarness } from "@test/helpers/cli-harness.js";
import { chunkedAgentText } from "@test/helpers/notifications.js";
import { loadFixture, seedWorkspace } from "@test/helpers/seed-workspace.js";
import { afterEach, expect, test } from "vitest";

const OPENAI_KEY = process.env.OPENAI_API_KEY!;

let harness: CliTestHarness;

afterEach(async () => {
	await harness?.cleanup();
});

test("/<no-args> command (.bodhi-pi/commands/*.md) expands and the LLM sees the body", async () => {
	harness = await createCliTestHarness({ model: getModel("openai", "gpt-4o-mini"), apiKey: OPENAI_KEY });
	await seedWorkspace(harness.tmpDir, {
		commands: { "say-tuesday.md": await loadFixture("commands-say-tuesday/.bodhi-pi/commands/say-tuesday.md") },
	});

	await harness.client.initialize(stdInitParams);
	const { sessionId } = await harness.client.newSession({ cwd: harness.tmpDir, mcpServers: [] });
	await harness.client.prompt({ sessionId, prompt: [{ type: "text", text: "/say-tuesday" }] });

	expect(chunkedAgentText(harness.updates).toLowerCase()).toContain("tuesday");
});

test("/<known> arg expands $1 with user-supplied value across two consecutive prompts", async () => {
	harness = await createCliTestHarness({ model: getModel("openai", "gpt-4o-mini"), apiKey: OPENAI_KEY });
	await seedWorkspace(harness.tmpDir, {
		commands: { "echo.md": await loadFixture("commands-echo/.bodhi-pi/commands/echo.md") },
	});

	await harness.client.initialize(stdInitParams);
	const { sessionId } = await harness.client.newSession({ cwd: harness.tmpDir, mcpServers: [] });

	for (const word of ["banana", "cherry"]) {
		harness.updates.length = 0;
		await harness.client.prompt({ sessionId, prompt: [{ type: "text", text: `/echo ${word}` }] });
		expect(chunkedAgentText(harness.updates).toLowerCase(), `expected ${word} in response`).toContain(word);
	}
});

test("/<known> arg expands into a tool-using prompt and the file is written to the real Node filesystem", async () => {
	harness = await createCliTestHarness({ model: getModel("openai", "gpt-4o-mini"), apiKey: OPENAI_KEY });
	await seedWorkspace(harness.tmpDir, {
		commands: { "write-file.md": await loadFixture("commands-write-file/.bodhi-pi/commands/write-file.md") },
	});

	await harness.client.initialize(stdInitParams);
	const { sessionId } = await harness.client.newSession({ cwd: harness.tmpDir, mcpServers: [] });
	const target = path.join(harness.tmpDir, "out.txt");
	await harness.client.prompt({ sessionId, prompt: [{ type: "text", text: `/write-file ${target}` }] });

	const stored = await fsNode.readFile(target, "utf8");
	expect(stored.toLowerCase()).toContain("hello world");
});

test("available_commands_update lists project commands after newSession", async () => {
	harness = await createCliTestHarness({ model: getModel("openai", "gpt-4o-mini"), apiKey: OPENAI_KEY });
	await seedWorkspace(harness.tmpDir, {
		commands: {
			"echo.md": await loadFixture("commands-multi/.bodhi-pi/commands/echo.md"),
			"say-tuesday.md": await loadFixture("commands-multi/.bodhi-pi/commands/say-tuesday.md"),
		},
	});

	await harness.client.initialize(stdInitParams);
	await harness.client.newSession({ cwd: harness.tmpDir, mcpServers: [] });

	const update = harness.updates.find((u) => u.update.sessionUpdate === "available_commands_update");
	expect(update, "expected available_commands_update notification on session/new").toBeDefined();
	const names = ((update?.update as { availableCommands?: Array<{ name: string }> }).availableCommands ?? []).map(
		(c) => c.name,
	);
	expect(names).toContain("echo");
	expect(names).toContain("say-tuesday");
});
