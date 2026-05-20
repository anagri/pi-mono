import { getModel } from "@earendil-works/pi-ai";
import { stdInitParams } from "@test/helpers/acp-constants.js";
import { chunkedAgentText } from "@test/helpers/notifications.js";
import { toolCallStarts } from "@test/helpers/tool-call-asserts.js";
import { expect, test } from "vitest";
import { newAllowAllSession } from "../helpers/allow-all-session.js";
import { envKeysFor } from "../helpers/api-keys.js";
import { createE2EHarness } from "../helpers/harness.js";
import { useHarness } from "../helpers/use-harness.js";

// Hardcoded baseline date (UTC, 0-indexed month) so the test is deterministic
// across runs regardless of when CI fires it. Keep BIRTHDAY consistent with
// EXPECTED_DAYS — recompute if you bump the baseline.
const SCRIPT = `
const baseline = Date.UTC(2026, 4, 8);
const ms = baseline - new Date(args[0] + "T00:00:00Z").getTime();
console.log(Math.floor(ms / 86400000));
`;

const BIRTHDAY = "2000-01-01";
const EXPECTED_DAYS = "9624";

const harness = useHarness();

test("scripted skill: /skill:days-since-birthday invokes run_script and reports the integer", async () => {
	const model = getModel("openai", "gpt-4o-mini");
	const h = harness.set(
		await createE2EHarness({
			models: [model],
			defaultModelId: model.id,
			getApiKey: envKeysFor("openai"),
		}),
	);

	const skillDir = `${h.cwd}/.bodhi-pi/skills/days-since-birthday`;
	await h.setupFiles({
		".bodhi-pi/skills/days-since-birthday/SKILL.md": `---\ndescription: Compute days between a YYYY-MM-DD birthday and the baseline date.\n---\nYou have a JavaScript helper at ${skillDir}/script.js. Call the run_script tool with:\n\n- path: "${skillDir}/script.js"\n- args: ["<YYYY-MM-DD>"] where the date comes from the user's message.\n\nThe script writes a single integer (number of days) to stdout. Reply with exactly that integer and nothing else.\n`,
		".bodhi-pi/skills/days-since-birthday/script.js": SCRIPT,
	});

	await h.clientConn.initialize(stdInitParams);
	const { sessionId } = await newAllowAllSession(h.clientConn, { cwd: h.cwd, mcpServers: [] });
	await h.clientConn.prompt({
		sessionId,
		prompt: [{ type: "text", text: `/skill:days-since-birthday ${BIRTHDAY}` }],
	});

	const starts = toolCallStarts(h.updates);
	const runStart = starts.find((s) => s.rawInput.path === `${skillDir}/script.js`);
	expect(runStart, `expected run_script call, got: ${JSON.stringify(starts)}`).toBeDefined();
	expect(runStart?.kind).toBe("execute");

	expect(chunkedAgentText(h.updates)).toContain(EXPECTED_DAYS);
});
