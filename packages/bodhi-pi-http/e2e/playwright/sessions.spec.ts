import { expect, test } from "./fixtures.js";

test.describe("session lifecycle slash commands", () => {
	test("/new creates a session; /sessions lists it; /close + /resume continues across requests", async ({ app }) => {
		await app.goto();
		await app.setSettings();
		await app.clickConnect();
		await app.expectStatus("connected");
		await expect(app.status).not.toHaveAttribute("data-session-id", "");

		// Auto-created session is in place. Issue a real prompt so the session has
		// state we can later resume.
		await app.send("Remember the magic word: zephyr-9921. Reply with only ok.");
		await app.expectChatStatus("idle");

		// Capture sessionId from status bar before we close.
		const sessionId = (await app.status.getAttribute("data-session-id")) ?? "";
		expect(sessionId).not.toBe("");

		// /sessions should list the active session.
		await app.send("/sessions");
		const list = await app.lastSystemMessage();
		expect(list).toContain(sessionId);

		// /close drops in-memory state (server-side) but the persisted session
		// remains. We surface a system message; sessionId stays set so the
		// auto-resume effect doesn't immediately recreate.
		await app.send("/close");
		await expect(app.systemMessages().last()).toContainText("closed session");

		// /resume <id> hydrates the session in memory; subsequent prompt must
		// see prior context.
		await app.send(`/resume ${sessionId}`);
		await expect(app.status).toHaveAttribute("data-session-id", sessionId);

		await app.send("What was the magic word? Reply with only the word.");
		// Wait for the streaming round-trip to complete before reading the last
		// assistant message — otherwise we'd see the replayed "ok" from turn 1.
		await app.expectChatStatus("streaming");
		await app.expectChatStatus("idle");
		await expect(app.page.locator('[data-testid="message"][data-role="assistant"]').last()).toContainText(
			/zephyr-9921/i,
		);
	});

	test("/new starts a fresh session distinct from any auto-resumed one", async ({ app }) => {
		await app.goto();
		await app.setSettings();
		await app.clickConnect();
		await expect(app.status).not.toHaveAttribute("data-session-id", "");
		const initial = (await app.status.getAttribute("data-session-id")) ?? "";

		await app.send("/new");
		await expect(app.status).not.toHaveAttribute("data-session-id", initial);
		await expect(app.status).not.toHaveAttribute("data-session-id", "");
	});
});
