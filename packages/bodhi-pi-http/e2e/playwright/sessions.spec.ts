import { expect, test } from "./fixtures.js";

test.describe("session lifecycle slash commands", () => {
	test("/new creates a session; /sessions lists it; /close + /resume continues across requests", async ({ app }) => {
		await app.setup("gpt-4o-mini");

		await app.send("Remember the magic word: zephyr-9921. Reply with only ok.");
		await app.expectChatStatus("idle");

		const sessionId = (await app.status.getAttribute("data-session-id")) ?? "";
		expect(sessionId).not.toBe("");

		await app.send("/sessions");
		const sysLocator = app.systemMessages().last();
		await expect(sysLocator).toContainText(/sessions:/);
		const list = (await sysLocator.textContent()) ?? "";
		expect(list).toContain(sessionId);

		await app.send("/close");
		await expect(app.systemMessages().last()).toContainText("closed session");

		await app.send(`/resume ${sessionId}`);
		await expect(app.status).toHaveAttribute("data-session-id", sessionId);

		await app.send("What was the magic word? Reply with only the word.");
		await app.expectChatStatus("streaming");
		await app.expectChatStatus("idle");
		await expect(app.page.locator('[data-testid="message"][data-role="assistant"]').last()).toContainText(
			/zephyr-9921/i,
		);
	});

	test("/new starts a fresh session distinct from any auto-resumed one", async ({ app }) => {
		await app.connect();
		const initial = (await app.status.getAttribute("data-session-id")) ?? "";

		await app.send("/new");
		await expect(app.status).not.toHaveAttribute("data-session-id", initial);
		await expect(app.status).not.toHaveAttribute("data-session-id", "");
	});
});
