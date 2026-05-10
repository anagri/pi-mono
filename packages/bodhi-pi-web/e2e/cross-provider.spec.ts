import { expect, test } from "./fixtures";

test("M13 cross-provider switch: gpt-4o-mini → claude-haiku-4-5", async ({ chat }) => {
	const provenance =
		"Are you made by Anthropic or by OpenAI? Answer with exactly one of those two words and nothing else.";

	await test.step("boot defaults to gpt-4o-mini", async () => {
		await chat.goto();
		await chat.waitForState("idle");
		await expect(chat.statusBar).toHaveAttribute("data-current-model", "gpt-4o-mini");
	});

	await test.step("OpenAI turn says openai", async () => {
		await chat.send(provenance);
		await chat.waitForState("streaming");
		await chat.waitForState("idle");
		expect((await chat.lastMessage("assistant")).toLowerCase()).toContain("openai");
	});

	await test.step("/model claude-haiku-4-5 swaps the active provider", async () => {
		await chat.send("/model claude-haiku-4-5");
		await expect(chat.statusBar).toHaveAttribute("data-current-model", "claude-haiku-4-5");
	});

	await test.step("Anthropic turn says anthropic", async () => {
		await chat.send(provenance);
		await chat.waitForState("streaming");
		await chat.waitForState("idle");
		expect((await chat.lastMessage("assistant")).toLowerCase()).toContain("anthropic");
	});
});
