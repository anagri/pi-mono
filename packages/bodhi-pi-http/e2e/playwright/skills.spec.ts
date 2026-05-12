import { expect, test } from "./fixtures.js";

test.describe("markdown skills (real LLM)", () => {
	test.use({ scenario: "skills-say-hello" });

	test("/skill:say-hello triggers the skill prompt and the model echoes", async ({ app }) => {
		await app.setup("gpt-4o-mini");

		await app.send("/help");
		await expect(app.systemMessages().last()).toContainText("say-hello");

		await app.send("/skill:say-hello Maya");
		await app.expectChatStatus("idle");
		const last = app.page.locator('[data-testid="message"][data-role="assistant"]').last();
		await expect(last).toContainText(/hello/i);
		await expect(last).toContainText(/maya/i);
	});
});
