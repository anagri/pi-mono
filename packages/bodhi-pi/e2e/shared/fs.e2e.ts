import { type Api, getModel, type Model } from "@earendil-works/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { requireEnv } from "@test/helpers/env.js";
import { chunkedAgentText } from "@test/helpers/notifications.js";
import { afterEach, expect, test } from "vitest";
import { createE2EHarness, type E2EHarness } from "../helpers/harness.js";

async function harnessFor(opts: { model: Model<Api>; apiKey: string; provider: string }): Promise<E2EHarness> {
	return createE2EHarness({
		models: [opts.model],
		defaultModelId: opts.model.id,
		getApiKey: (p) => (p === opts.provider ? opts.apiKey : undefined),
	});
}

let activeHarness: E2EHarness | undefined;

afterEach(async () => {
	if (activeHarness) {
		await activeHarness.cleanup();
		activeHarness = undefined;
	}
});

test("Haiku writes a file then reads it back", async () => {
	const apiKey = requireEnv("ANTHROPIC_API_KEY");
	const h = await harnessFor({
		model: getModel("anthropic", "claude-haiku-4-5"),
		apiKey,
		provider: "anthropic",
	});
	activeHarness = h;

	await h.clientConn.initialize(stdInitParams);
	const { sessionId } = await h.clientConn.newSession({ cwd: h.cwd, mcpServers: [] });

	const outFile = `${h.cwd}/out.txt`;
	await h.clientConn.prompt({
		sessionId,
		prompt: [
			{
				type: "text",
				text: `Use the write tool to create the file ${outFile} with exactly the text: hello world`,
			},
		],
	});

	expect(await h.filesystem.exists(outFile)).toBe(true);
	const stored = await h.filesystem.readTextFile(outFile);
	// Substring match — real LLMs may add capitalisation or punctuation.
	expect(stored.trim().toLowerCase()).toContain("hello world");

	h.updates.length = 0;
	await h.clientConn.prompt({
		sessionId,
		prompt: [
			{
				type: "text",
				text: `Use the read tool on ${outFile} and reply with the file's exact contents and nothing else.`,
			},
		],
	});
	expect(chunkedAgentText(h.updates).toLowerCase()).toContain("hello world");
});

test("Haiku finds a string with grep", async () => {
	const apiKey = requireEnv("ANTHROPIC_API_KEY");
	const h = await harnessFor({
		model: getModel("anthropic", "claude-haiku-4-5"),
		apiKey,
		provider: "anthropic",
	});
	activeHarness = h;

	await h.filesystem.writeTextFile(`${h.cwd}/apple.txt`, "this file has nothing of interest");
	await h.filesystem.writeTextFile(`${h.cwd}/banana.txt`, "this file mentions banana once");
	await h.filesystem.writeTextFile(`${h.cwd}/cherry.txt`, "another distractor file");

	await h.clientConn.initialize(stdInitParams);
	const { sessionId } = await h.clientConn.newSession({ cwd: h.cwd, mcpServers: [] });

	await h.clientConn.prompt({
		sessionId,
		prompt: [
			{
				type: "text",
				text: `Use the grep tool to find which file under ${h.cwd} contains the word 'banana'. Reply with just the matching file path and nothing else.`,
			},
		],
	});

	expect(chunkedAgentText(h.updates)).toContain(`${h.cwd}/banana.txt`);
});
