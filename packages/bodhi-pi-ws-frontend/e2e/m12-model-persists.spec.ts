import { expect, test } from "./fixtures";

test.describe("M12 model selection persists across /new + /resume (parity with bodhi-pi-web)", () => {
	test("status bar reflects the prior model after /new + /resume <id>", async ({ app }) => {
		await app.goto();
		await app.setSettings({ email: "model-persists@example.com", id: 360, sendToken: true });
		await app.clickConnect();
		await app.expectStatus("connected");

		await test.step("first prompt establishes the session and locks default model attribute", async () => {
			await app.send("Reply with the single word: alpha");
			await app.expectChatStatus("idle");
			await expect(app.status).toHaveAttribute("data-current-model", "gpt-4o-mini");
		});

		await test.step("/model switches to claude-haiku-4-5; one prompt persists model_change", async () => {
			await app.send("/model claude-haiku-4-5");
			await expect(app.status).toHaveAttribute("data-current-model", "claude-haiku-4-5");
			await app.send("Reply with the single word: beta");
			await app.expectChatStatus("idle");
		});

		let sessionA = "";
		await test.step("capture sessionId via /sessions", async () => {
			await app.send("/sessions");
			const sysLocator = app.page.getByTestId("system-message").last();
			await expect(sysLocator).toContainText(/sessions:/);
			const sys = (await sysLocator.textContent()) ?? "";
			const match = sys.match(/\*\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
			expect(match, `failed to parse active session id from /sessions output: ${sys}`).not.toBeNull();
			sessionA = match![1];
		});

		await test.step("/new resets to default model", async () => {
			await app.send("/new");
			await expect(app.page.getByTestId("system-message").filter({ hasText: "new session" }).last()).toBeVisible();
			await expect(app.status).toHaveAttribute("data-current-model", "gpt-4o-mini");
		});

		await test.step("/resume <sessionA> restores claude-haiku-4-5", async () => {
			await app.send(`/resume ${sessionA}`);
			await expect(
				app.page.getByTestId("system-message").filter({ hasText: "resumed session" }).last(),
			).toBeVisible();
			await expect(app.status).toHaveAttribute("data-current-model", "claude-haiku-4-5");
		});
	});
});
