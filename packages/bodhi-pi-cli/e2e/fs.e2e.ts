import nodeFs from "node:fs/promises";
import path from "node:path";
import { getModel } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, expect, test } from "vitest";
import { stdInitParams } from "../test/helpers/acp-constants.js";
import { type CliTestHarness, createCliTestHarness } from "../test/helpers/cli-harness.js";
import { chunkedAgentText } from "../test/helpers/notifications.js";
import { toolCallUpdates, toolUpdateText } from "../test/helpers/tool-call-asserts.js";

const OPENAI_KEY = process.env.OPENAI_API_KEY!;

let harness: CliTestHarness;

beforeEach(async () => {
	harness = await createCliTestHarness({ model: getModel("openai", "gpt-4o-mini"), apiKey: OPENAI_KEY });
});

afterEach(async () => {
	await harness.cleanup();
});

test("write tool creates a real file in tmpDir", async () => {
	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: harness.tmpDir, mcpServers: [] });

	const target = path.join(harness.tmpDir, "output.txt");
	await harness.clientConn.prompt({
		sessionId,
		prompt: [
			{ type: "text", text: `Use the write tool to create the file ${target} with exactly the text: disk-written` },
		],
	});

	const content = await nodeFs.readFile(target, "utf-8");
	expect(content.trim()).toContain("disk-written");
});

test("read tool reads a pre-seeded file from tmpDir", async () => {
	const seedPath = path.join(harness.tmpDir, "seed.txt");
	await nodeFs.writeFile(seedPath, "real disk content", "utf-8");

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: harness.tmpDir, mcpServers: [] });

	await harness.clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: `Use the read tool on ${seedPath}.` }],
	});

	// Assert via tool result, not LLM response — the tool must have read the real disk file
	const completed = toolCallUpdates(harness.updates).filter((u) => u.status === "completed");
	expect(completed.length).toBeGreaterThanOrEqual(1);
	expect(toolUpdateText(completed[0])).toContain("real disk content");
});

test("ls tool lists real files in tmpDir", async () => {
	await nodeFs.writeFile(path.join(harness.tmpDir, "alpha.txt"), "a", "utf-8");
	await nodeFs.writeFile(path.join(harness.tmpDir, "beta.txt"), "b", "utf-8");

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: harness.tmpDir, mcpServers: [] });

	await harness.clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: `Use the ls tool on ${harness.tmpDir} and tell me what files are there.` }],
	});

	const text = chunkedAgentText(harness.updates).toLowerCase();
	expect(text).toContain("alpha.txt");
	expect(text).toContain("beta.txt");
});
