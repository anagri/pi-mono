import { expect, test } from "./fixtures";

test("M12 cross-provider chat threads openai and anthropic responses in the same session", async ({ app }) => {
	await app.goto();
	await app.setSettings({ email: "cross-provider@example.com", id: 350, sendToken: true });
	await app.clickConnect();
	await app.expectStatus("connected");

	await app.send("Reply with the single word: openai-side");
	await app.expectChatStatus("idle");
	expect((await app.lastMessageText("assistant")).toLowerCase()).toContain("openai-side");

	await app.send("/model claude-haiku-4-5");
	await expect(app.status).toHaveAttribute("data-current-model", "claude-haiku-4-5");

	await app.send("Reply with the single word: anthropic-side");
	await app.expectChatStatus("idle");
	expect((await app.lastMessageText("assistant")).toLowerCase()).toContain("anthropic-side");

	// Both responses persist in the message log.
	const messages = app.page.getByTestId("message");
	await expect(messages.filter({ hasText: "openai-side" }).first()).toBeVisible();
	await expect(messages.filter({ hasText: "anthropic-side" }).first()).toBeVisible();
});
