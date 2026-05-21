import { getModel } from "@earendil-works/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { chunkedAgentText } from "@test/helpers/notifications.js";
import { expect, test } from "vitest";
import { envKeysFor } from "../helpers/api-keys.js";
import { createE2EHarness } from "../helpers/harness.js";
import { useHarness } from "../helpers/use-harness.js";

const harness = useHarness();

test("bash tool (gpt-4o-mini): echo, pwd, pipeline, and shared-fs round-trip", async () => {
	const model = getModel("openai", "gpt-4o-mini");
	const h = harness.set(
		await createE2EHarness({
			models: [model],
			defaultModelId: model.id,
			getApiKey: envKeysFor("openai"),
		}),
	);

	await h.clientConn.initialize(stdInitParams);
	const { sessionId } = await h.clientConn.newSession({ cwd: h.cwd, mcpServers: [] });

	// Step 1: echo via bash
	h.updates.length = 0;
	await h.clientConn.prompt({
		sessionId,
		prompt: [
			{
				type: "text",
				text: "Use the bash tool to run `echo hello-from-bash` and reply with just the command's output.",
			},
		],
	});
	expect.soft(chunkedAgentText(h.updates)).toContain("hello-from-bash");

	// Step 2: pwd via bash (should match the session cwd)
	h.updates.length = 0;
	await h.clientConn.prompt({
		sessionId,
		prompt: [
			{
				type: "text",
				text: "Use the bash tool to run `pwd` and reply with the directory and nothing else.",
			},
		],
	});
	expect.soft(chunkedAgentText(h.updates)).toContain(h.cwd);

	// Step 3: pipeline with separate stdout — `printf` + `wc -l` should report 3 lines.
	h.updates.length = 0;
	await h.clientConn.prompt({
		sessionId,
		prompt: [
			{
				type: "text",
				text:
					"Use the bash tool to run exactly: printf 'a\\nb\\nc\\n' | wc -l . " +
					"Reply with just the number of lines.",
			},
		],
	});
	expect.soft(chunkedAgentText(h.updates)).toContain("3");

	// Step 4: shared filesystem — write a file via the write tool, then read it via bash `cat`.
	const seeded = `${h.cwd}/bash-shared.txt`;
	h.updates.length = 0;
	await h.clientConn.prompt({
		sessionId,
		prompt: [
			{
				type: "text",
				text: `Use the write tool to create ${seeded} with exactly: shared-bash-marker`,
			},
		],
	});
	expect.soft(await h.filesystem.exists(seeded)).toBe(true);

	h.updates.length = 0;
	await h.clientConn.prompt({
		sessionId,
		prompt: [
			{
				type: "text",
				text: `Use the bash tool to run \`cat ${seeded}\` and reply with the file contents and nothing else.`,
			},
		],
	});
	expect.soft(chunkedAgentText(h.updates)).toContain("shared-bash-marker");
}, 180_000); // 4 chained real-LLM prompts; http per-request rebuild + write+cat round-trip pushes well past 60s
