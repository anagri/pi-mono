import { expect, test } from "./fixtures.js";

test.describe("tool-call replay on /resume (real LLM)", () => {
	test("tool-call cards from a prior session re-render as completed on /resume", async ({ app }) => {
		await app.setup("gpt-4o-mini");

		await app.send("Use the write tool to create a file note.txt with the contents 'replay-marker'.");
		await app.expectChatStatus("idle");
		await expect(app.toolCalls({ status: "completed" }).first()).toBeVisible();

		const sessionId = await app.status.getAttribute("data-session-id");
		expect(sessionId).toBeTruthy();

		await app.send("/new");
		await expect(app.systemMessages().filter({ hasText: "new session" }).last()).toBeVisible();

		await app.send(`/resume ${sessionId}`);
		await expect(app.systemMessages().filter({ hasText: "resumed session" }).last()).toBeVisible();

		await expect(app.toolCalls({ status: "completed" }).first()).toBeVisible();
	});
});
