import { type Api, getModel, type Model } from "@mariozechner/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { requireEnv } from "@test/helpers/env.js";
import { createTestHarness } from "@test/helpers/harness.js";
import { chunkedAgentText } from "@test/helpers/notifications.js";
import { expect, test } from "vitest";
import { createInMemoryFilesystem, type Filesystem } from "@/index.js";

const PROVIDER = "openai";
// gpt-4o-mini (non-reasoning) avoids pi-ai's openai-responses reasoning-item
// round-trip issue: with store:false and no encrypted_content include, reasoning
// items from a prior turn 404 on the next call. Same workaround coding-agent uses
// (packages/coding-agent/test/print-mode.test.ts).
const MODEL_ID = "gpt-4o-mini";
const CWD = "/proj";
const COMMANDS_DIR = `${CWD}/.bodhi-pi/commands`;

async function seedCommands(fs: Filesystem): Promise<void> {
	await fs.mkdir(COMMANDS_DIR, { recursive: true });
	await fs.writeTextFile(
		`${COMMANDS_DIR}/say-tuesday.md`,
		'---\ndescription: Say tuesday\n---\nReply with exactly the single word "tuesday" and nothing else.\n',
	);
	await fs.writeTextFile(
		`${COMMANDS_DIR}/echo.md`,
		"---\ndescription: Echo a word\nargument-hint: <word>\n---\nReply with exactly the single word: $1\nAnd nothing else.\n",
	);
	await fs.writeTextFile(
		`${COMMANDS_DIR}/write-file.md`,
		"---\ndescription: Write a fixed line into a file\nargument-hint: <path>\n---\nUse the write tool to create the file $1 with exactly the text: hello world\n",
	);
}

function harness(model: Model<Api>, apiKey: string, filesystem: Filesystem) {
	return createTestHarness({
		models: [model],
		defaultModelId: model.id,
		getApiKey: (p) => (p === PROVIDER ? apiKey : undefined),
		filesystem,
	});
}

test("/<no-args> command expands and the LLM sees the expanded prompt", async () => {
	const apiKey = requireEnv("OPENAI_API_KEY");
	const fs = createInMemoryFilesystem();
	await seedCommands(fs);
	const h = harness(getModel(PROVIDER, MODEL_ID), apiKey, fs);

	await h.clientConn.initialize(stdInitParams);
	const { sessionId } = await h.clientConn.newSession({ cwd: CWD, mcpServers: [] });

	await h.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "/say-tuesday" }] });
	expect(chunkedAgentText(h.updates).toLowerCase()).toContain("tuesday");
});

test("/<known> arg expands $1 with the user-supplied value", async () => {
	const apiKey = requireEnv("OPENAI_API_KEY");
	const fs = createInMemoryFilesystem();
	await seedCommands(fs);
	const h = harness(getModel(PROVIDER, MODEL_ID), apiKey, fs);

	await h.clientConn.initialize(stdInitParams);
	const { sessionId } = await h.clientConn.newSession({ cwd: CWD, mcpServers: [] });

	for (const word of ["banana", "cherry"]) {
		h.updates.length = 0;
		await h.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: `/echo ${word}` }] });
		expect(chunkedAgentText(h.updates).toLowerCase()).toContain(word);
	}
});

test("/<known> arg expands into a tool-using prompt and the file gets written", async () => {
	const apiKey = requireEnv("OPENAI_API_KEY");
	const fs = createInMemoryFilesystem();
	await seedCommands(fs);
	const h = harness(getModel(PROVIDER, MODEL_ID), apiKey, fs);

	await h.clientConn.initialize(stdInitParams);
	const { sessionId } = await h.clientConn.newSession({ cwd: CWD, mcpServers: [] });

	await h.clientConn.prompt({ sessionId, prompt: [{ type: "text", text: "/write-file /out.txt" }] });

	expect(await fs.exists("/out.txt")).toBe(true);
	const stored = await fs.readTextFile("/out.txt");
	expect(stored.toLowerCase()).toContain("hello world");
});
