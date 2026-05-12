import { expect, test } from "./fixtures.js";

test.describe("project slash commands (real LLM)", () => {
	test.use({ scenario: ["commands-echo", "commands-say-tuesday"] });

	test("/<known> arg expands $1 and reaches the model", async ({ app }) => {
		await app.setup("gpt-4o-mini");

		await app.send("/help");
		const help = app.systemMessages().last();
		await expect(help).toContainText("echo");
		await expect(help).toContainText("say-tuesday");

		await app.send("/echo banana");
		await app.expectChatStatus("idle");
		await expect(app.page.locator('[data-testid="message"][data-role="assistant"]').last()).toContainText(/banana/i);

		await app.send("/say-tuesday");
		await app.expectChatStatus("idle");
		await expect(app.page.locator('[data-testid="message"][data-role="assistant"]').last()).toContainText(/tuesday/i);
	});
});

test.describe("unknown slash command falls through (real LLM)", () => {
	test("/<unknown> passes through verbatim to the agent", async ({ app }) => {
		await app.setup("gpt-4o-mini");

		await app.send("/totally-not-a-command Reply with the single word: gravy");
		await app.expectChatStatus("idle");
		await expect(app.page.locator('[data-testid="message"][data-role="assistant"]').last()).toContainText(/gravy/i);
	});
});
