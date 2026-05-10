import { expect, test } from "./fixtures";

test.describe("M11 auto-resume last session", () => {
	test("resumes prior session on reload + reconnect", async ({ app }) => {
		await app.goto();
		await app.setSettings({ email: "resume@example.com", id: 211, sendToken: true });
		await app.clickConnect();
		await app.expectStatus("connected");

		await app.send("Reply with the single word: alpha");
		await app.expectChatStatus("idle");
		const sessionId = await app.status.getAttribute("data-current-session-id");
		expect(sessionId).toBeTruthy();
		expect(sessionId?.length ?? 0).toBeGreaterThan(0);

		// Reload — settings are persisted in localStorage; last-session pointer too.
		await app.page.reload();
		// Re-fill the spawned URL (it's injected on goto, lost on bare reload because
		// the dev server doesn't keep it in localStorage).
		await app.page.getByTestId("settings-serverUrl").fill(app.serverUrl);
		await app.clickConnect();
		await app.expectStatus("connected");

		// The auto-resume effect should restore the same sessionId.
		await expect(app.status).toHaveAttribute("data-current-session-id", sessionId ?? "");

		// And surface a "resumed session" system message.
		await expect(app.page.getByTestId("system-message").filter({ hasText: "resumed session" }).last()).toBeVisible();
	});

	test("scopes resume key by user id (different user → empty session)", async ({ app }) => {
		await app.goto();
		await app.setSettings({ email: "userA@example.com", id: 220, sendToken: true });
		await app.clickConnect();
		await app.expectStatus("connected");
		await app.send("Reply with the single word: charlie");
		await app.expectChatStatus("idle");

		await app.page.getByTestId("disconnect").click();
		await app.expectStatus("disconnected");

		// Switch user; the (serverUrl, userId) key changes so no resume should fire.
		await app.setSettings({ email: "userB@example.com", id: 221, sendToken: true });
		await app.clickConnect();
		await app.expectStatus("connected");

		// No "resumed session" system message for the new user.
		await expect(app.page.getByTestId("system-message").filter({ hasText: "resumed session" })).toHaveCount(0);
	});

	test("falls back to fresh session when stored sessionId is unknown to the server", async ({ app }) => {
		await app.goto();
		await app.setSettings({ email: "stale@example.com", id: 230, sendToken: true });

		// Pre-seed last-session with a bogus id for this (serverUrl, userId) pair.
		await app.page.evaluate(
			([url, userId]) => {
				window.localStorage.setItem(`bodhi-pi-ws:lastSession:${url}:${userId}`, "session-does-not-exist-xyz");
			},
			[app.serverUrl, "230"],
		);

		await app.clickConnect();
		await app.expectStatus("connected");

		// Resume effect tries loadSession, server errors, frontend logs system message
		// and clears the stale pointer.
		await expect(app.page.getByTestId("system-message").filter({ hasText: "starting fresh" }).last()).toBeVisible();

		const stored = await app.page.evaluate(
			([url, userId]) => window.localStorage.getItem(`bodhi-pi-ws:lastSession:${url}:${userId}`),
			[app.serverUrl, "230"],
		);
		expect(stored).toBeNull();
	});
});
