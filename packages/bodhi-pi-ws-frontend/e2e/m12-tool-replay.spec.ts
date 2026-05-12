import { expect, test } from "./fixtures";

test("M12 tool-call cards from a prior session re-render as completed on /resume", async ({ app }) => {
	await app.setup("gpt-4o-mini", { email: "replay@example.com", id: 330, sendToken: true });

	await app.send("Use the write tool to create a file note.txt with the contents 'replay-marker'.");
	await app.expectChatStatus("idle");
	await expect(app.toolCalls({ name: "write" }).first()).toHaveAttribute("data-tool-status", "completed");

	const sessionId = await app.status.getAttribute("data-session-id");
	expect(sessionId).toBeTruthy();

	// Force a fresh client-side session, then explicitly /resume the prior id.
	await app.send("/new");
	await expect(app.page.getByTestId("system-message").last()).toContainText("new session");

	await app.send(`/resume ${sessionId}`);
	await expect(app.page.getByTestId("system-message").filter({ hasText: "resumed session" }).last()).toBeVisible();

	// Replayed tool-call card from session history is rendered with completed status.
	await expect(app.toolCalls({ name: "write" }).first()).toHaveAttribute("data-tool-status", "completed");
});
