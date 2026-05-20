import { getModel } from "@earendil-works/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { chunkedAgentText } from "@test/helpers/notifications.js";
import { expect, test } from "vitest";
import { newAllowAllSession } from "../helpers/allow-all-session.js";
import { envKeysFor } from "../helpers/api-keys.js";
import { createE2EHarness } from "../helpers/harness.js";
import { useHarness } from "../helpers/use-harness.js";

// gpt-4o-mini (non-reasoning) avoids pi-ai's openai-responses reasoning-item
// round-trip issue: with store:false and no encrypted_content include, reasoning
// items from a prior turn 404 on the next call. Same workaround coding-agent uses.

const harness = useHarness();

test("project slash commands: no-args expand, $1 substitution, tool-using expansion", async () => {
	const model = getModel("openai", "gpt-4o-mini");
	const h = harness.set(
		await createE2EHarness({
			models: [model],
			defaultModelId: model.id,
			getApiKey: envKeysFor("openai"),
		}),
	);

	await h.setupFiles({
		".bodhi-pi/commands/say-tuesday.md":
			'---\ndescription: Say tuesday\n---\nReply with exactly the single word "tuesday" and nothing else.\n',
		".bodhi-pi/commands/echo.md":
			"---\ndescription: Echo a word\nargument-hint: <word>\n---\nReply with exactly the single word: $1\nAnd nothing else.\n",
		".bodhi-pi/commands/write-file.md":
			"---\ndescription: Write a fixed line into a file\nargument-hint: <path>\n---\nUse the write tool to create the file $1 with exactly the text: hello world\n",
	});

	await h.clientConn.initialize(stdInitParams);
	const { sessionId } = await newAllowAllSession(h.clientConn, { cwd: h.cwd, mcpServers: [] });

	// Step 1: no-arg command expands.
	h.updates.length = 0;
	await h.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "/say-tuesday" }] });
	expect.soft(chunkedAgentText(h.updates).toLowerCase()).toContain("tuesday");

	// Step 2: $1 substitution across two distinct values.
	for (const word of ["banana", "cherry"]) {
		h.updates.length = 0;
		await h.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: `/echo ${word}` }] });
		expect.soft(chunkedAgentText(h.updates).toLowerCase()).toContain(word);
	}

	// Step 3: expanded prompt drives a tool call.
	h.updates.length = 0;
	const outFile = `${h.cwd}/out.txt`;
	await h.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: `/write-file ${outFile}` }] });

	expect.soft(await h.filesystem.exists(outFile)).toBe(true);
	const stored = await h.filesystem.readTextFile(outFile);
	expect.soft(stored.toLowerCase()).toContain("hello world");
});
