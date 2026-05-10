import { expect, test } from "./fixtures";

test("/model switches between providers and updates the status bar", async ({ app }) => {
	await app.goto();
	await app.setSettings({ email: "model-switch@example.com", id: 340, sendToken: true });
	await app.clickConnect();
	await app.expectStatus("connected");

	// First prompt establishes the session and locks in the default model attribute.
	await app.send("Reply with the single word: hello");
	await app.expectChatStatus("idle");
	await expect(app.status).toHaveAttribute("data-current-model", "gpt-4o-mini");

	await app.send("/model claude-haiku-4-5");
	await expect(app.page.getByTestId("system-message").filter({ hasText: "model switched to" }).last()).toBeVisible();
	await expect(app.status).toHaveAttribute("data-current-model", "claude-haiku-4-5");

	await app.send("Reply with the single word: switched");
	await app.expectChatStatus("idle");
	expect((await app.lastMessageText("assistant")).toLowerCase()).toContain("switched");
});
