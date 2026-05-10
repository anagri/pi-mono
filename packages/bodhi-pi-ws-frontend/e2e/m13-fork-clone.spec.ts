import { expect, test } from "./fixtures";

test.describe("M13 /fork + /clone — ws split host", () => {
	test("/fork at a user message creates a new session that excludes that turn", async ({ app }) => {
		await app.goto();
		await app.setSettings({ email: "alice@example.com", id: 1, sendToken: true });
		await app.clickConnect();
		await app.expectStatus("connected");

		await app.send("/new");
		await expect(app.page.getByTestId("system-message").last()).toContainText("new session");

		await app.send("Reply with one word: morning. Just 'morning'.");
		await app.expectChatStatus("idle");
		await app.send("Reply with one word: evening. Just 'evening'.");
		await app.expectChatStatus("idle");

		await app.send("/entries");
		const entriesSys = app.page.getByTestId("system-message").last();
		await expect(entriesSys).toContainText(/entries:/);
		const text = (await entriesSys.textContent()) ?? "";
		const matches = [...text.matchAll(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s+user/g)];
		expect(matches.length).toBe(2);
		const forkAtId = matches[1][1];

		await app.send(`/fork ${forkAtId}`);
		const forkSys = app.page.getByTestId("system-message").last();
		await expect(forkSys).toContainText(/forked:/);
		await expect(forkSys).toContainText(/evening/);
	});

	test("/clone produces a new session id", async ({ app }) => {
		await app.goto();
		await app.setSettings({ email: "alice@example.com", id: 1, sendToken: true });
		await app.clickConnect();
		await app.expectStatus("connected");

		await app.send("/new");
		await expect(app.page.getByTestId("system-message").last()).toContainText("new session");

		await app.send("Reply only with: noted");
		await app.expectChatStatus("idle");

		await app.send("/clone");
		const sys = app.page.getByTestId("system-message").last();
		await expect(sys).toContainText(/cloned:/);
	});
});
