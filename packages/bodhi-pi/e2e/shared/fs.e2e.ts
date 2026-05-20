import { getModel } from "@earendil-works/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { chunkedAgentText } from "@test/helpers/notifications.js";
import { expect, test } from "vitest";
import { newAllowAllSession } from "../helpers/allow-all-session.js";
import { envKeysFor } from "../helpers/api-keys.js";
import { createE2EHarness } from "../helpers/harness.js";
import { useHarness } from "../helpers/use-harness.js";

// Built-in filesystem tools (write / read / grep) round-trip through real
// disk under cli/http and through the in-memory FS under in-memory. One
// Haiku-backed flow with three soft-assertion steps replaces what was
// previously two granular tests (write+read, grep); same coverage, one
// harness setup.

const harness = useHarness();

test("filesystem tools (Haiku): write → read → grep across seeded files", async () => {
	const haiku = getModel("anthropic", "claude-haiku-4-5-20251001");
	const h = harness.set(
		await createE2EHarness({
			models: [haiku],
			defaultModelId: haiku.id,
			getApiKey: envKeysFor("anthropic"),
		}),
	);

	// Pre-seed grep targets so they don't compete with the write step's output.
	await h.setupFiles({
		"apple.txt": "this file has nothing of interest",
		"banana.txt": "this file mentions banana once",
		"cherry.txt": "another distractor file",
	});

	await h.clientConn.initialize(stdInitParams);
	const { sessionId } = await newAllowAllSession(h.clientConn, { cwd: h.cwd, mcpServers: [] });

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
