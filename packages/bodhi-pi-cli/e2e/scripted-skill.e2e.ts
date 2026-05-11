import path from "node:path";
import { getModel } from "@earendil-works/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { type CliTestHarness, createCliTestHarness } from "@test/helpers/cli-harness.js";
import { chunkedAgentText } from "@test/helpers/notifications.js";
import { loadFixture, seedWorkspace } from "@test/helpers/seed-workspace.js";
import { toolCallStarts } from "@test/helpers/tool-call-asserts.js";
import { afterEach, expect, test } from "vitest";

const OPENAI_KEY = process.env.OPENAI_API_KEY!;

// Hardcoded baseline (UTC, 0-indexed month) — keep BIRTHDAY consistent with
// EXPECTED_DAYS. Same baseline as bodhi-pi/e2e/scripted-skill.e2e.ts so an
// agent-level regression and a Node-host regression flag the same number.
const BIRTHDAY = "2000-01-01";
const EXPECTED_DAYS = "9624";

let harness: CliTestHarness;

afterEach(async () => {
	await harness?.cleanup();
});

test("scripted skill invokes run_script via createNodeScriptExecutor and reports the integer", async () => {
	harness = await createCliTestHarness({ model: getModel("openai", "gpt-4o-mini"), apiKey: OPENAI_KEY });

	const skillDirAbsolute = path.join(harness.tmpDir, ".bodhi-pi", "skills", "days-since-birthday");
	const scriptAbsolute = path.join(skillDirAbsolute, "script.js");
	const skillTemplate = await loadFixture("skills-days-since-birthday/.bodhi-pi/skills/days-since-birthday/SKILL.md");
	const scriptBody = await loadFixture("skills-days-since-birthday/.bodhi-pi/skills/days-since-birthday/script.js");
	// SKILL.md uses {SCRIPT_PATH} placeholder — only the absolute script path
	// is dynamic (depends on the per-test tmpdir), everything else is on-disk.
	const interpolated = skillTemplate.replaceAll("{SCRIPT_PATH}", scriptAbsolute);
	await seedWorkspace(harness.tmpDir, {
		skills: {
			"days-since-birthday/SKILL.md": interpolated,
			"days-since-birthday/script.js": scriptBody,
		},
	});

	await harness.clientConn.initialize(stdInitParams);
	const { sessionId } = await harness.clientConn.newSession({ cwd: harness.tmpDir, mcpServers: [] });
	await harness.clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: `/skill:days-since-birthday ${BIRTHDAY}` }],
	});

	const starts = toolCallStarts(harness.updates);
	const runStart = starts.find((s) => (s.rawInput as { path?: string })?.path === scriptAbsolute);
	expect(runStart, `expected run_script call against ${scriptAbsolute}, got: ${JSON.stringify(starts)}`).toBeDefined();
	expect(runStart?.kind).toBe("execute");

	expect(chunkedAgentText(harness.updates)).toContain(EXPECTED_DAYS);
});
