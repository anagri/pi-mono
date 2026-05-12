import { expect, test } from "./fixtures";
import { loadScenario } from "./helpers/seed";

test.describe("M10 markdown skills", () => {
	test.use({
		workspaceSeed: {
			name: "demo",
			files: loadScenario("skills-say-hello"),
		},
	});

	test("/skill:<name> wraps body and reaches the model", async ({ chat }) => {
		await test.step("boot", async () => {
			await chat.setup("openai", process.env.OPENAI_API_KEY!, "gpt-4o-mini");
		});

		await test.step("/help advertises skill:say-hello", async () => {
			await chat.send("/help");
			await expect(chat.messages("system").last()).toContainText("skill:say-hello");
		});

		await test.step("/skill:say-hello world produces 'hello, world'", async () => {
			await chat.send("/skill:say-hello world");
			await chat.waitForState("streaming");
			await chat.waitForState("idle");
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
			files: loadScenario("skills-days-since-birthday"),
		},
	});

	test("hidden skill is still advertised in /help and invokable via /skill:", async ({ chat }) => {
		await test.step("boot", async () => {
			await chat.setup("openai", process.env.OPENAI_API_KEY!, "gpt-4o-mini");
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
			await chat.waitForState("idle");
			await expect(chat.toolCalls({ name: "run_script" }).first()).toBeVisible();
			expect(await chat.lastMessage("assistant")).toContain("9624");
		});
	});
});

test.describe("M16 unknown /skill: passthrough", () => {
	test.use({ workspaceSeed: { name: "demo", files: {} } });

	test("/skill:nonexistent forwards the literal text to the LLM", async ({ chat }) => {
		await chat.setup("openai", process.env.OPENAI_API_KEY!, "gpt-4o-mini");
		await chat.send("/skill:nonexistent Reply with the single word: gravy");
		await chat.waitForState("streaming");
		await chat.waitForState("idle");
		// No skill matches → expandSkillCommand returns the text unchanged →
		// the LLM follows the inlined instruction.
		expect((await chat.lastMessage("assistant")).toLowerCase()).toContain("gravy");
	});
});
