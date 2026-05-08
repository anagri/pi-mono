import { expect, test } from "./fixtures";

const SAY_HELLO_SKILL = [
	"---",
	"description: Say hello to a person",
	"---",
	"When you receive a name from the user, reply with exactly the words: hello, <name>",
	"Replace <name> with the value the user supplied. Output nothing else.",
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
