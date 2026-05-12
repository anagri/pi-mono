import { type Api, getModel, type Model } from "@earendil-works/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { requireEnv } from "@test/helpers/env.js";
import { chunkedAgentText } from "@test/helpers/notifications.js";
import { afterEach, expect, test } from "vitest";
import type { Filesystem } from "@/index.js";
import { createE2EHarness, type E2EHarness } from "../helpers/harness.js";

const PROVIDER = "openai";
// gpt-4o-mini (non-reasoning) avoids pi-ai's openai-responses reasoning-item
// round-trip issue: with store:false and no encrypted_content include, reasoning
// items from a prior turn 404 on the next call. Same workaround coding-agent uses
// (packages/coding-agent/test/print-mode.test.ts).
const MODEL_ID = "gpt-4o-mini";

async function seedCommands(fs: Filesystem, cwd: string): Promise<void> {
	const dir = `${cwd}/.bodhi-pi/commands`;
	await fs.mkdir(dir, { recursive: true });
	await fs.writeTextFile(
		`${dir}/say-tuesday.md`,
		'---\ndescription: Say tuesday\n---\nReply with exactly the single word "tuesday" and nothing else.\n',
	);
	await fs.writeTextFile(
		`${dir}/echo.md`,
		"---\ndescription: Echo a word\nargument-hint: <word>\n---\nReply with exactly the single word: $1\nAnd nothing else.\n",
	);
	await fs.writeTextFile(
		`${dir}/write-file.md`,
		"---\ndescription: Write a fixed line into a file\nargument-hint: <path>\n---\nUse the write tool to create the file $1 with exactly the text: hello world\n",
	);
}

async function harness(model: Model<Api>, apiKey: string): Promise<E2EHarness> {
	return createE2EHarness({
		models: [model],
		defaultModelId: model.id,
		getApiKey: (p) => (p === PROVIDER ? apiKey : undefined),
	});
}

let activeHarness: E2EHarness | undefined;

afterEach(async () => {
	if (activeHarness) {
		await activeHarness.cleanup();
		activeHarness = undefined;
	}
});

test("/<no-args> command expands and the LLM sees the expanded prompt", async () => {
	const apiKey = requireEnv("OPENAI_API_KEY");
	const h = await harness(getModel(PROVIDER, MODEL_ID), apiKey);
	activeHarness = h;
	await seedCommands(h.filesystem, h.cwd);

	await h.clientConn.initialize(stdInitParams);
	const { sessionId } = await h.clientConn.newSession({ cwd: h.cwd, mcpServers: [] });

	await h.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "/say-tuesday" }] });
	expect(chunkedAgentText(h.updates).toLowerCase()).toContain("tuesday");
});

test("/<known> arg expands $1 with the user-supplied value", async () => {
	const apiKey = requireEnv("OPENAI_API_KEY");
	const h = await harness(getModel(PROVIDER, MODEL_ID), apiKey);
	activeHarness = h;
	await seedCommands(h.filesystem, h.cwd);

	await h.clientConn.initialize(stdInitParams);
	const { sessionId } = await h.clientConn.newSession({ cwd: h.cwd, mcpServers: [] });

	for (const word of ["banana", "cherry"]) {
		h.updates.length = 0;
		await h.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: `/echo ${word}` }] });
		expect(chunkedAgentText(h.updates).toLowerCase()).toContain(word);
	}
});

test("/<known> arg expands into a tool-using prompt and the file gets written", async () => {
	const apiKey = requireEnv("OPENAI_API_KEY");
	const h = await harness(getModel(PROVIDER, MODEL_ID), apiKey);
	activeHarness = h;
	await seedCommands(h.filesystem, h.cwd);

	await h.clientConn.initialize(stdInitParams);
	const { sessionId } = await h.clientConn.newSession({ cwd: h.cwd, mcpServers: [] });

	const outFile = `${h.cwd}/out.txt`;
	await h.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: `/write-file ${outFile}` }] });

	expect(await h.filesystem.exists(outFile)).toBe(true);
	const stored = await h.filesystem.readTextFile(outFile);
	expect(stored.toLowerCase()).toContain("hello world");
});
