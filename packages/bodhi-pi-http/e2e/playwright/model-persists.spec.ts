import { expect, test } from "./fixtures.js";

const HAS_OPENAI = Boolean(process.env.OPENAI_API_KEY);
const HAS_ANTHROPIC = Boolean(process.env.ANTHROPIC_API_KEY);

test.describe("model selection persists across /new + /resume", () => {
	test.skip(!(HAS_OPENAI && HAS_ANTHROPIC), "requires OPENAI_API_KEY + ANTHROPIC_API_KEY");

	test("status bar reflects the prior model after /new + /resume <id>", async ({ app }) => {
		await app.goto();
		await app.setSettings();
		await app.clickConnect();
		await app.expectStatus("connected");
		await expect(app.status).toHaveAttribute("data-current-model", "gpt-4o-mini");

		await app.send("Reply with the single word: alpha");
		await app.expectChatStatus("idle");

		await app.send("/model claude-haiku-4-5");
		await expect(app.status).toHaveAttribute("data-current-model", "claude-haiku-4-5");
		// Run a prompt so the model_change is persisted in the session log.
		await app.send("Reply with the single word: beta");
		await app.expectChatStatus("idle");

		// Capture sessionId from /sessions output.
		await app.send("/sessions");
		const sysLocator = app.systemMessages().last();
		await expect(sysLocator).toContainText(/sessions:/);
		const sys = (await sysLocator.textContent()) ?? "";
		const match = sys.match(/\*\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
		expect(match, `failed to parse active session id: ${sys}`).not.toBeNull();
		const sessionA = match![1];

		await app.send("/new");
		await expect(app.systemMessages().filter({ hasText: "new session" }).last()).toBeVisible();
		await expect(app.status).toHaveAttribute("data-current-model", "gpt-4o-mini");

		await app.send(`/resume ${sessionA}`);
		await expect(app.systemMessages().filter({ hasText: "resumed session" }).last()).toBeVisible();
		await expect(app.status).toHaveAttribute("data-current-model", "claude-haiku-4-5");
	});
});
