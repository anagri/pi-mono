import { expect, test } from "./fixtures";

test("M4 multi-model switching with /model", async ({ chat }) => {
	await test.step("boot to idle with no default model, then login + select gpt-4o-mini", async () => {
		await chat.goto();
		await chat.waitForState("idle");
		await expect(chat.statusBar).toHaveAttribute("data-current-model", "");
		await chat.login("openai", process.env.OPENAI_API_KEY!);
		await chat.model("gpt-4o-mini");
	});

	await test.step("/help lists local commands", async () => {
		await chat.send("/help");
		await expect(chat.messages("system").last()).toContainText("/help");
		await expect(chat.messages("system").last()).toContainText("/model");
	});

	await test.step("first turn against gpt-4o-mini", async () => {
		await chat.send("Reply with the single word: alpha");
		await chat.waitForState("streaming");
		await chat.waitForState("idle");
		expect((await chat.lastMessage("assistant")).toLowerCase()).toContain("alpha");
	});

	await test.step("/model with no args lists models", async () => {
		await chat.send("/model");
		await expect(chat.messages("system").last()).toContainText("gpt-4o-mini");
		await expect(chat.messages("system").last()).toContainText("gpt-4o");
	});

	await test.step("/model gpt-4o switches", async () => {
		await chat.model("gpt-4o");
	});

	await test.step("second turn routes to gpt-4o", async () => {
		await chat.send("Reply with the single word: beta");
		await chat.waitForState("streaming");
		await chat.waitForState("idle");
		expect((await chat.lastMessage("assistant")).toLowerCase()).toContain("beta");
	});

	await test.step("/model unknown reports error", async () => {
		await chat.send("/model not-a-model");
		await expect(chat.messages("system").last()).toContainText(/error/i);
		// status bar should still reflect the last good model
		await expect(chat.statusBar).toHaveAttribute("data-current-model", "gpt-4o");
	});
});
