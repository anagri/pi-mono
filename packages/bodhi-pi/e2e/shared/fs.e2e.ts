import { getModel } from "@earendil-works/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { chunkedAgentText } from "@test/helpers/notifications.js";
import { afterEach, expect, test } from "vitest";
import { createE2EHarness, type E2EHarness } from "../helpers/harness.js";

// Built-in filesystem tools (write / read / grep) round-trip through real
// disk under cli/http and through the in-memory FS under in-memory. One
// Haiku-backed flow with three soft-assertion steps replaces what was
// previously two granular tests (write+read, grep); same coverage, one
// harness setup.

let activeHarness: E2EHarness | undefined;

afterEach(async () => {
	if (activeHarness) {
		await activeHarness.cleanup();
		activeHarness = undefined;
	}
});

test("filesystem tools (Haiku): write → read → grep across seeded files", async () => {
	const haiku = getModel("anthropic", "claude-haiku-4-5");
	const h = await createE2EHarness({
		models: [haiku],
		defaultModelId: haiku.id,
		getApiKey: (p) => (p === "anthropic" ? process.env.ANTHROPIC_API_KEY! : undefined),
	});
	activeHarness = h;

	// Pre-seed grep targets so they don't compete with the write step's output.
	await h.filesystem.writeTextFile(`${h.cwd}/apple.txt`, "this file has nothing of interest");
	await h.filesystem.writeTextFile(`${h.cwd}/banana.txt`, "this file mentions banana once");
	await h.filesystem.writeTextFile(`${h.cwd}/cherry.txt`, "another distractor file");

	await h.clientConn.initialize(stdInitParams);
	const { sessionId } = await h.clientConn.newSession({ cwd: h.cwd, mcpServers: [] });

	// Step 1: write
	const outFile = `${h.cwd}/out.txt`;
	h.updates.length = 0;
	await h.clientConn.prompt({
		sessionId,
		prompt: [
			{
				type: "text",
				text: `Use the write tool to create the file ${outFile} with exactly the text: hello world`,
			},
		],
	});
	expect.soft(await h.filesystem.exists(outFile)).toBe(true);
	const stored = await h.filesystem.readTextFile(outFile);
	expect.soft(stored.trim().toLowerCase()).toContain("hello world");

	// Step 2: read
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
	expect.soft(chunkedAgentText(h.updates).toLowerCase()).toContain("hello world");

	// Step 3: grep
	h.updates.length = 0;
	await h.clientConn.prompt({
		sessionId,
		prompt: [
			{
				type: "text",
				text: `Use the grep tool to find which file under ${h.cwd} contains the word 'banana'. Reply with just the matching file path and nothing else.`,
			},
		],
	});
	expect.soft(chunkedAgentText(h.updates)).toContain(`${h.cwd}/banana.txt`);
});
