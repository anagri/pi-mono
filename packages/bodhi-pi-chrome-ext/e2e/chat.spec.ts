import { expect, test } from "./fixtures";

test("M3 agent round trip with gpt-4o-mini", async ({ chat }) => {
	await test.step("boot lands on idle state", async () => {
		await chat.goto();
		await chat.waitForState("idle");
		await expect(chat.statusBar).toHaveAttribute("data-current-model", "gpt-4o-mini");
	});

	await test.step("seed openai auth", async () => {
		await chat.login("openai", process.env.OPENAI_API_KEY!);
	});

	await test.step("send a prompt", async () => {
		await chat.send("Reply with the single word: ping");
	});

	await test.step("streaming starts", async () => {
		await chat.waitForState("streaming");
	});

	await test.step("returns to idle when complete", async () => {
		await chat.waitForState("idle");
	});

	await test.step("user message landed", async () => {
		expect(await chat.lastMessage("user")).toContain("ping");
	});

	await test.step("assistant response contains ping", async () => {
		const text = await chat.lastMessage("assistant");
		expect(text.toLowerCase()).toContain("ping");
	});
});
