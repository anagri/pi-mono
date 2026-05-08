import { type Api, getModel, type Model } from "@mariozechner/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { requireEnv } from "@test/helpers/env.js";
import { createTestHarness } from "@test/helpers/harness.js";
import { chunkedAgentText } from "@test/helpers/notifications.js";
import { expect, test } from "vitest";
import { createInMemoryFilesystem, type Filesystem } from "@/index.js";

function harnessFor(opts: { model: Model<Api>; apiKey: string; provider: string; filesystem?: Filesystem }) {
	return createTestHarness({
		models: [opts.model],
		defaultModelId: opts.model.id,
		getApiKey: (p) => (p === opts.provider ? opts.apiKey : undefined),
		filesystem: opts.filesystem,
	});
}

test("Haiku writes a file then reads it back", async () => {
	const apiKey = requireEnv("ANTHROPIC_API_KEY");
	const harness = harnessFor({
		model: getModel("anthropic", "claude-haiku-4-5"),
		apiKey,
		provider: "anthropic",
	});

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/", mcpServers: [] });

	await harness.clientConn.prompt({
		sessionId,
		prompt: [
			{
				type: "text",
				text: "Use the write tool to create the file /out.txt with exactly the text: hello world",
			},
		],
	});

	expect(await harness.filesystem.exists("/out.txt")).toBe(true);
	const stored = await harness.filesystem.readTextFile("/out.txt");
	// Substring match — real LLMs may add capitalisation or punctuation.
	expect(stored.trim().toLowerCase()).toContain("hello world");

	harness.updates.length = 0;
	await harness.clientConn.prompt({
		sessionId,
		prompt: [
			{
				type: "text",
				text: "Use the read tool on /out.txt and reply with the file's exact contents and nothing else.",
			},
		],
	});
	expect(chunkedAgentText(harness.updates).toLowerCase()).toContain("hello world");
});

test("Haiku finds a string with grep", async () => {
	const apiKey = requireEnv("ANTHROPIC_API_KEY");
	const filesystem = createInMemoryFilesystem();
	await filesystem.writeTextFile("/apple.txt", "this file has nothing of interest");
	await filesystem.writeTextFile("/banana.txt", "this file mentions banana once");
	await filesystem.writeTextFile("/cherry.txt", "another distractor file");

	const harness = harnessFor({
		model: getModel("anthropic", "claude-haiku-4-5"),
		apiKey,
		provider: "anthropic",
		filesystem,
	});

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: "/", mcpServers: [] });

	await harness.clientConn.prompt({
		sessionId,
		prompt: [
			{
				type: "text",
				text: "Use the grep tool to find which file under / contains the word 'banana'. Reply with just the matching file path and nothing else.",
			},
		],
	});

	expect(chunkedAgentText(harness.updates)).toContain("/banana.txt");
});
