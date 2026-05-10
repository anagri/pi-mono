import { expect, test } from "./fixtures.js";

const HAS_KEY = Boolean(process.env.OPENAI_API_KEY);

test.describe("project slash commands (real LLM)", () => {
	test.skip(!HAS_KEY, "requires OPENAI_API_KEY");
	test.use({ scenario: ["commands-echo", "commands-say-tuesday"] });

	test("/<known> arg expands $1 and reaches the model", async ({ app }) => {
		await app.goto();
		await app.setSettings();
		await app.clickConnect();
		await app.expectStatus("connected");

		// Project commands surface in /help once a session exists.
		await app.send("/new");
		await expect(app.systemMessages().last()).toContainText("new session");

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
	test.skip(!HAS_KEY, "requires OPENAI_API_KEY");

	test("/<unknown> passes through verbatim to the agent", async ({ app }) => {
		await app.goto();
		await app.setSettings();
		await app.clickConnect();
		await app.expectStatus("connected");

		await app.send("/totally-not-a-command Reply with the single word: gravy");
		await app.expectChatStatus("idle");
		await expect(app.page.locator('[data-testid="message"][data-role="assistant"]').last()).toContainText(/gravy/i);
	});
});
