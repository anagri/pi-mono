import { expect, test } from "./fixtures.js";

const HAS_OPENAI = Boolean(process.env.OPENAI_API_KEY);
const HAS_ANTHROPIC = Boolean(process.env.ANTHROPIC_API_KEY);

test.describe("cross-provider chat in same session", () => {
	test.skip(!(HAS_OPENAI && HAS_ANTHROPIC), "requires OPENAI_API_KEY + ANTHROPIC_API_KEY");

	test("threads openai and anthropic responses in the same session", async ({ app }) => {
		await app.goto();
		await app.setSettings();
		await app.clickConnect();
		await app.expectStatus("connected");

		await app.send("Reply with the single word: openai-side");
		await app.expectChatStatus("idle");
		await expect(app.page.locator('[data-testid="message"][data-role="assistant"]').last()).toContainText(
			/openai-side/i,
		);

		await app.send("/model claude-haiku-4-5");
		await expect(app.status).toHaveAttribute("data-current-model", "claude-haiku-4-5");

		await app.send("Reply with the single word: anthropic-side");
		await app.expectChatStatus("idle");
		await expect(app.page.locator('[data-testid="message"][data-role="assistant"]').last()).toContainText(
			/anthropic-side/i,
		);

		// Both responses persist in the message log.
		const messages = app.page.getByTestId("message");
		await expect(messages.filter({ hasText: "openai-side" }).first()).toBeVisible();
		await expect(messages.filter({ hasText: "anthropic-side" }).first()).toBeVisible();
	});
});
