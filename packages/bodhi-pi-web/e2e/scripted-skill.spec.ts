import { expect, test } from "./fixtures";

const SKILL_DIR = "/mnt/demo/.bodhi-pi/skills/days-since-birthday";

const SCRIPT = [
	"const baseline = Date.UTC(2026, 4, 8);",
	'const ms = baseline - new Date(args[0] + "T00:00:00Z").getTime();',
	"console.log(Math.floor(ms / 86400000));",
].join("\n");

const SKILL_MD = [
	"---",
	"description: Compute days between a YYYY-MM-DD birthday and the baseline date.",
	"---",
	`You have a JavaScript helper at ${SKILL_DIR}/script.js. Call the run_script tool with:`,
	"",
	`- path: "${SKILL_DIR}/script.js"`,
	'- args: ["<YYYY-MM-DD>"] where the date comes from the user\'s message.',
	"",
	"The script writes a single integer (number of days) to stdout. Reply with exactly that integer and nothing else.",
].join("\n");

const BIRTHDAY = "2000-01-01";
const EXPECTED_DAYS = "9624";

test.describe("M11 scripted skill via run_script", () => {
	test.use({
		workspaceSeed: {
			name: "demo",
			files: {
				"/.bodhi-pi/skills/days-since-birthday/SKILL.md": SKILL_MD,
				"/.bodhi-pi/skills/days-since-birthday/script.js": SCRIPT,
			},
		},
	});

	test("/skill:days-since-birthday calls run_script and reports the integer", async ({ chat }) => {
		await test.step("boot", async () => {
			await chat.goto();
			await chat.waitForState("idle", 60_000);
		});

		await test.step("send the scripted skill invocation", async () => {
			await chat.send(`/skill:days-since-birthday ${BIRTHDAY}`);
			await chat.waitForState("streaming");
			await chat.waitForState("idle", 90_000);
		});

		await test.step("run_script tool ran", async () => {
			await expect(chat.toolCalls({ name: "run_script" }).first()).toBeVisible();
		});

		await test.step("assistant replies with the expected day count", async () => {
			expect(await chat.lastMessage("assistant")).toContain(EXPECTED_DAYS);
		});
	});
});
