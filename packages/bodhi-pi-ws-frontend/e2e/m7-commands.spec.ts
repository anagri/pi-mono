import { expect, test } from "./fixtures";

test.describe("M7 project slash commands", () => {
	test.use({ scenario: ["commands-echo", "commands-say-tuesday"] });

	test("/<known> arg expands $1 and reaches the model", async ({ app }) => {
		test.skip(!process.env.OPENAI_API_KEY, "needs OPENAI_API_KEY");

		await app.goto();
		await app.setSettings({ email: "alice@example.com", id: 1, sendToken: true });
		await app.clickConnect();
		await app.expectStatus("connected");

		// Need a session for available_commands_update to fire.
		await app.send("/new");
		await expect(app.page.getByTestId("system-message").last()).toContainText("new session");

		await app.send("/help");
		const help = app.page.getByTestId("system-message").last();
		await expect(help).toContainText("echo");
		await expect(help).toContainText("say-tuesday");

		await app.send("/echo banana");
		await app.expectChatStatus("idle");
		const out1 = (await app.lastMessageText("assistant")).toLowerCase();
		expect(out1).toContain("banana");

		await app.send("/say-tuesday");
		await app.expectChatStatus("idle");
		const out2 = (await app.lastMessageText("assistant")).toLowerCase();
		expect(out2).toContain("tuesday");
	});
});

test.describe("M7 unknown slash command falls through", () => {
	// No fixtures — empty workspace. Ensures unknown / commands forward to LLM as text.
	test("/<unknown> passes through verbatim", async ({ app }) => {
		test.skip(!process.env.OPENAI_API_KEY, "needs OPENAI_API_KEY");

		await app.goto();
		await app.setSettings({ email: "alice@example.com", id: 1, sendToken: true });
		await app.clickConnect();
		await app.expectStatus("connected");

		await app.send("/totally-not-a-command Reply with the single word: gravy");
		await app.expectChatStatus("idle");
		expect((await app.lastMessageText("assistant")).toLowerCase()).toContain("gravy");
	});
});
