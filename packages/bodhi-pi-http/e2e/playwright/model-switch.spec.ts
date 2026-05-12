import { expect, test } from "./fixtures.js";

test.describe("/model command (real providers)", () => {
	test("/model switches between providers and updates the status bar", async ({ app }) => {
		await app.connect();
		await app.login("openai", process.env.OPENAI_API_KEY!);
		await app.login("anthropic", process.env.ANTHROPIC_API_KEY!);
		await app.model("gpt-4o-mini");

		await app.send("Reply with the single word: hello");
		await app.expectChatStatus("idle");

		await app.model("claude-haiku-4-5");

		await app.send("Reply with the single word: switched");
		await app.expectChatStatus("idle");
		await expect(app.page.locator('[data-testid="message"][data-role="assistant"]').last()).toContainText(
			/switched/i,
		);
	});
});
