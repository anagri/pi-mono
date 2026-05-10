import { expect, test } from "./fixtures.js";

/**
 * HTTP-specific proof: a session can be /closed (server-side runtime state
 * dropped) and /resumed in a later prompt round-trip — and the conversation
 * continues across those independent HTTP requests. Each turn is a fresh
 * agent rebuilt from SQLite per the deployment thesis.
 *
 * Mirrors `sessions.spec.ts`'s broader test but isolated as a focused parity
 * proof matching the HTTP host's "stateless between turns" architecture.
 */
test.describe("close + resume continues across HTTP requests (real LLM)", () => {
	test("/close → /resume <id> recalls the prior turn's context via SQLite hydration", async ({ app }) => {
		await app.goto();
		await app.setSettings();
		await app.clickConnect();
		await app.expectStatus("connected");
		await expect(app.status).not.toHaveAttribute("data-session-id", "");

		// Turn 1 — establish memory.
		await app.send("Remember the codeword: meridian-7. Reply with only ok.");
		await app.expectChatStatus("idle");
		const sessionId = (await app.status.getAttribute("data-session-id")) ?? "";
		expect(sessionId).not.toBe("");

		// Close: server-side runtime state dropped; persisted record stays.
		await app.send("/close");
		await expect(app.systemMessages().last()).toContainText("closed session");

		// Resume: separate HTTP request rebuilds the agent fresh and re-hydrates
		// from SQLite. The next prompt depends on memory persisted in turn 1.
		await app.send(`/resume ${sessionId}`);
		await expect(app.systemMessages().filter({ hasText: "resumed session" }).last()).toBeVisible();

		await app.send("What was the codeword? Reply with only the codeword.");
		await app.expectChatStatus("streaming");
		await app.expectChatStatus("idle");
		await expect(app.page.locator('[data-testid="message"][data-role="assistant"]').last()).toContainText(
			/meridian-7/i,
		);
	});
});
