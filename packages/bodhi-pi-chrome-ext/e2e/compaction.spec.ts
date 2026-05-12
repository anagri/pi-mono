import { expect, test } from "./fixtures";

test("/compact summarizes prior turns and retains pet-name fact afterwards", async ({ chat }) => {
	await chat.setup("openai", process.env.OPENAI_API_KEY!, "gpt-4o-mini");

	await test.step("seed multi-turn history", async () => {
		await chat.send("Remember: my pet's name is Mango. Reply only with: noted");
		await chat.waitForState("streaming");
		await chat.waitForState("idle");
		expect((await chat.lastMessage("assistant")).toLowerCase()).toContain("noted");

		await chat.send("Reply with one short sentence: what comes after Tuesday?");
		await chat.waitForState("streaming");
		await chat.waitForState("idle");
	});

	await test.step("/compact returns a summary system message", async () => {
		await chat.send("/compact");
		const sys = chat.messages("system").last();
		await expect(sys).toContainText(/compacted/);
	});

	await test.step("post-compact context still answers about the pet name", async () => {
		await chat.send("What is my pet's name? Reply with the single word.");
		await chat.waitForState("streaming");
		await chat.waitForState("idle");
		expect((await chat.lastMessage("assistant")).toLowerCase()).toContain("mango");
	});
});
