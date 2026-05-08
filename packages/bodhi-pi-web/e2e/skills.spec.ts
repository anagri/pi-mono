import { expect, test } from "./fixtures";

const SAY_HELLO_SKILL = [
	"---",
	"description: Say hello to a person",
	"---",
	"When you receive a name from the user, reply with exactly the words: hello, <name>",
	"Replace <name> with the value the user supplied. Output nothing else.",
].join("\n");

const HIDDEN_DAYS_SKILL = [
	"---",
	"description: Compute days between a YYYY-MM-DD birthday and the baseline date.",
	"disable-model-invocation: true",
	"---",
	"You have a JavaScript helper at /mnt/demo/.bodhi-pi/skills/days-since-birthday/script.js.",
	"Call run_script with:",
	"",
	'- path: "/mnt/demo/.bodhi-pi/skills/days-since-birthday/script.js"',
	'- args: ["<YYYY-MM-DD>"] where the date comes from the user\'s message.',
	"",
	"Reply with exactly that integer and nothing else.",
].join("\n");

const HIDDEN_DAYS_SCRIPT = [
	"const baseline = Date.UTC(2026, 4, 8);",
	'const ms = baseline - new Date(args[0] + "T00:00:00Z").getTime();',
	"console.log(Math.floor(ms / 86400000));",
].join("\n");

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
