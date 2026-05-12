import nodeFs from "node:fs/promises";
import path from "node:path";
import { getModel } from "@earendil-works/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { type CliTestHarness, createCliTestHarness } from "@test/helpers/cli-harness.js";
import { toolCallUpdates, toolUpdateText } from "@test/helpers/tool-call-asserts.js";
import { afterEach, beforeEach, expect, test } from "vitest";

const OPENAI_KEY = process.env.OPENAI_API_KEY!;

let harness: CliTestHarness;

beforeEach(async () => {
	harness = await createCliTestHarness({ model: getModel("openai", "gpt-4o-mini"), apiKey: OPENAI_KEY });
});

afterEach(async () => {
	await harness.cleanup();
});

test("run_script executes a real Node process and returns stdout", async () => {
	// Use a relative filename — the run_script tool resolves relative to session cwd (harness.tmpDir)
	await nodeFs.writeFile(path.join(harness.tmpDir, "greet.js"), 'console.log("greetings from " + args[0]);', "utf-8");

	await harness.client.initialize(stdInitParams);
	const { sessionId } = await harness.client.newSession({ cwd: harness.tmpDir, mcpServers: [] });

	await harness.client.prompt({
		sessionId,
		prompt: [{ type: "text", text: 'Use the run_script tool to execute greet.js with args ["node-process"].' }],
	});

	// Assert via tool result — the Node process must have run and produced output
	const completed = toolCallUpdates(harness.updates).filter((u) => u.status === "completed");
	expect(completed.length).toBeGreaterThanOrEqual(1);
	expect(toolUpdateText(completed[0])).toContain("greetings from node-process");
});

test("run_script captures non-zero exit code", async () => {
	await nodeFs.writeFile(path.join(harness.tmpDir, "fail.js"), "process.exit(42);", "utf-8");

	await harness.client.initialize(stdInitParams);
	const { sessionId } = await harness.client.newSession({ cwd: harness.tmpDir, mcpServers: [] });

	await harness.client.prompt({
		sessionId,
		prompt: [
			{
				type: "text",
				text: "Use the run_script tool to execute fail.js. Report the exit code you see in the result.",
			},
		],
	});

	// exitCode 42 must appear in tool result or agent response
	const allUpdates = toolCallUpdates(harness.updates);
	const resultText =
		allUpdates.map(toolUpdateText).join("") +
		harness.updates
			.map((u) => {
				const c = (u.update as { content?: { type: string; text?: string } }).content;
				return c?.type === "text" ? (c.text ?? "") : "";
			})
			.join("");
	expect(resultText).toContain("42");
});
