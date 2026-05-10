import { expect, test } from "./fixtures.js";

const HAS_OPENAI = Boolean(process.env.OPENAI_API_KEY);
const HAS_ANTHROPIC = Boolean(process.env.ANTHROPIC_API_KEY);

test.describe("/model command (real providers)", () => {
	test.skip(!(HAS_OPENAI && HAS_ANTHROPIC), "requires OPENAI_API_KEY + ANTHROPIC_API_KEY");

	test("/model switches between providers and updates the status bar", async ({ app }) => {
		await app.goto();
		await app.setSettings();
		await app.clickConnect();
		await app.expectStatus("connected");
		await expect(app.status).toHaveAttribute("data-current-model", "gpt-4o-mini");

		await app.send("Reply with the single word: hello");
		await app.expectChatStatus("idle");

		await app.send("/model claude-haiku-4-5");
		await expect(app.systemMessages().filter({ hasText: "model switched to" }).last()).toBeVisible();
		await expect(app.status).toHaveAttribute("data-current-model", "claude-haiku-4-5");

		await app.send("Reply with the single word: switched");
		await app.expectChatStatus("idle");
		await expect(app.page.locator('[data-testid="message"][data-role="assistant"]').last()).toContainText(
			/switched/i,
		);
	});
});
