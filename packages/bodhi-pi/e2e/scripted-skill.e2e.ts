import { type Api, getModel, type Model } from "@mariozechner/pi-ai";
import { expect, test } from "vitest";
import { createInMemoryFilesystem, type Filesystem } from "../src/index.js";
import { stdInitParams } from "../test/helpers/acp-constants.js";
import { requireEnv } from "../test/helpers/env.js";
import { createTestHarness } from "../test/helpers/harness.js";
import { chunkedAgentText } from "../test/helpers/notifications.js";
import { createTestScriptExecutor } from "../test/helpers/script-executor.js";
import { toolCallStarts } from "../test/helpers/tool-call-asserts.js";

const PROVIDER = "openai";
const MODEL_ID = "gpt-4o-mini";
const CWD = "/proj";
const SKILL_DIR = `${CWD}/.bodhi-pi/skills/days-since-birthday`;

// Hardcoded baseline date (UTC, 0-indexed month) so the test is deterministic
// across runs regardless of when CI fires it. Keep BIRTHDAY consistent with
// EXPECTED_DAYS — recompute if you bump the baseline.
const SCRIPT = `
const baseline = Date.UTC(2026, 4, 8);
const ms = baseline - new Date(args[0] + "T00:00:00Z").getTime();
console.log(Math.floor(ms / 86400000));
`;

const SKILL_MD = `---
description: Compute days between a YYYY-MM-DD birthday and the baseline date.
---
You have a JavaScript helper at ${SKILL_DIR}/script.js. Call the run_script tool with:

- path: "${SKILL_DIR}/script.js"
- args: ["<YYYY-MM-DD>"] where the date comes from the user's message.

The script writes a single integer (number of days) to stdout. Reply with exactly that integer and nothing else.
`;

const BIRTHDAY = "2000-01-01";
const EXPECTED_DAYS = "9624";

async function seed(fs: Filesystem): Promise<void> {
	await fs.mkdir(SKILL_DIR, { recursive: true });
	await fs.writeTextFile(`${SKILL_DIR}/SKILL.md`, SKILL_MD);
	await fs.writeTextFile(`${SKILL_DIR}/script.js`, SCRIPT);
}

function harness(model: Model<Api>, apiKey: string, fs: Filesystem) {
	return createTestHarness({
		models: [model],
		defaultModelId: model.id,
		getApiKey: (p) => (p === PROVIDER ? apiKey : undefined),
		filesystem: fs,
		scriptExecutor: createTestScriptExecutor(fs),
	});
}

test("scripted skill: /skill:days-since-birthday invokes run_script and reports the integer", async () => {
	const apiKey = requireEnv("OPENAI_API_KEY");
	const fs = createInMemoryFilesystem();
	await seed(fs);
	const h = harness(getModel(PROVIDER, MODEL_ID), apiKey, fs);

	await h.clientConn.initialize(stdInitParams);
	const { sessionId } = await h.clientConn.newSession({ cwd: CWD, mcpServers: [] });
	await h.clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: `/skill:days-since-birthday ${BIRTHDAY}` }],
	});

	const starts = toolCallStarts(h.updates);
	const runStart = starts.find((s) => s.rawInput.path === `${SKILL_DIR}/script.js`);
	expect(runStart, `expected run_script call, got: ${JSON.stringify(starts)}`).toBeDefined();
	expect(runStart?.kind).toBe("execute");

	expect(chunkedAgentText(h.updates)).toContain(EXPECTED_DAYS);
});
