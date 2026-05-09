import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures";

// See cli-node review Batch E.4 — single source of truth for fixture bytes.
const FIXTURES_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"bodhi-pi-cli",
	"test",
	"fixtures",
);
const fixture = (rel: string): string => fs.readFileSync(path.join(FIXTURES_ROOT, rel), "utf8");

const SAY_HELLO_SKILL = fixture("skills-say-hello/.bodhi-pi/skills/say-hello/SKILL.md");
// SKILL.md uses {SCRIPT_PATH}; for the web seed mount, the script lives at
// `/mnt/demo/.bodhi-pi/skills/days-since-birthday/script.js`.
const HIDDEN_DAYS_SKILL = fixture(
	"skills-days-since-birthday/.bodhi-pi/skills/days-since-birthday/SKILL.md",
).replaceAll("{SCRIPT_PATH}", "/mnt/demo/.bodhi-pi/skills/days-since-birthday/script.js");
const HIDDEN_DAYS_SCRIPT = fixture("skills-days-since-birthday/.bodhi-pi/skills/days-since-birthday/script.js");

test.describe("M10 markdown skills", () => {
	test.use({
		workspaceSeed: {
			name: "demo",
			files: {
				"/.bodhi-pi/skills/say-hello/SKILL.md": SAY_HELLO_SKILL,
			},
		},
	});

	test("/skill:<name> wraps body and reaches the model", async ({ chat }) => {
		await test.step("boot", async () => {
			await chat.goto();
			await chat.waitForState("idle", 60_000);
		});

		await test.step("/help advertises skill:say-hello", async () => {
			await chat.send("/help");
			await expect(chat.messages("system").last()).toContainText("skill:say-hello");
		});

		await test.step("/skill:say-hello world produces 'hello, world'", async () => {
			await chat.send("/skill:say-hello world");
			await chat.waitForState("streaming");
			await chat.waitForState("idle", 60_000);
			// Tolerate transient gpt-4o-mini variations on punctuation/casing —
			// the e2e contract is that 'hello' and 'world' both show up in the
			// reply, proving the skill body reached the model.
			const reply = (await chat.lastMessage("assistant")).toLowerCase();
			expect(reply).toContain("hello");
			expect(reply).toContain("world");
		});
	});
});

test.describe("M16 hidden skill (disable-model-invocation)", () => {
	test.use({
		workspaceSeed: {
			name: "demo",
			files: {
				"/.bodhi-pi/skills/days-since-birthday/SKILL.md": HIDDEN_DAYS_SKILL,
				"/.bodhi-pi/skills/days-since-birthday/script.js": HIDDEN_DAYS_SCRIPT,
			},
		},
	});

	test("hidden skill is still advertised in /help and invokable via /skill:", async ({ chat }) => {
		await test.step("boot", async () => {
			await chat.goto();
			await chat.waitForState("idle", 60_000);
		});

		await test.step("/help advertises the hidden skill name", async () => {
			await chat.send("/help");
			// Hidden only means "kept out of <available_skills> in the system prompt".
			// available_commands_update still lists it so the user can invoke explicitly.
			await expect(chat.messages("system").last()).toContainText("skill:days-since-birthday");
		});

		await test.step("/skill:days-since-birthday 2000-01-01 returns 9624", async () => {
			await chat.send("/skill:days-since-birthday 2000-01-01");
			await chat.waitForState("streaming");
			await chat.waitForState("idle", 90_000);
			await expect(chat.toolCalls({ name: "run_script" }).first()).toBeVisible();
			expect(await chat.lastMessage("assistant")).toContain("9624");
		});
	});
});

test.describe("M16 unknown /skill: passthrough", () => {
	test.use({ workspaceSeed: { name: "demo", files: {} } });

	test("/skill:nonexistent forwards the literal text to the LLM", async ({ chat }) => {
		await chat.goto();
		await chat.waitForState("idle", 60_000);
		await chat.send("/skill:nonexistent Reply with the single word: gravy");
		await chat.waitForState("streaming");
		await chat.waitForState("idle", 60_000);
		// No skill matches → expandSkillCommand returns the text unchanged →
		// the LLM follows the inlined instruction.
		expect((await chat.lastMessage("assistant")).toLowerCase()).toContain("gravy");
	});
});
