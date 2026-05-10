import { expect, test } from "./fixtures";

test.describe("M8 markdown skills", () => {
	test.use({ scenario: "skills-say-hello" });

	test("/skill:say-hello triggers the skill prompt and the model echoes", async ({ app }) => {
		await app.goto();
		await app.setSettings({ email: "alice@example.com", id: 1, sendToken: true });
		await app.clickConnect();
		await app.expectStatus("connected");

		// Need a session for available_commands_update.
		await app.send("/new");

		await app.send("/help");
		await expect(app.page.getByTestId("system-message").last()).toContainText("say-hello");

		await app.send("/skill:say-hello Maya");
		await app.expectChatStatus("idle");
		const text = (await app.lastMessageText("assistant")).toLowerCase();
		expect(text).toContain("hello");
		expect(text).toContain("maya");
	});
});
