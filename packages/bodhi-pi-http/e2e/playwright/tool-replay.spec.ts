import { expect, test } from "./fixtures.js";

const HAS_KEY = Boolean(process.env.OPENAI_API_KEY);

test.describe("tool-call replay on /resume (real LLM)", () => {
	test.skip(!HAS_KEY, "requires OPENAI_API_KEY");

	test("tool-call cards from a prior session re-render as completed on /resume", async ({ app }) => {
		await app.goto();
		await app.setSettings();
		await app.clickConnect();
		await app.expectStatus("connected");

		await app.send("Use the write tool to create a file note.txt with the contents 'replay-marker'.");
		await app.expectChatStatus("idle");
		await expect(app.toolCalls({ status: "completed" }).first()).toBeVisible();

		const sessionId = await app.status.getAttribute("data-session-id");
		expect(sessionId).toBeTruthy();

		await app.send("/new");
		await expect(app.systemMessages().filter({ hasText: "new session" }).last()).toBeVisible();

		await app.send(`/resume ${sessionId}`);
		await expect(app.systemMessages().filter({ hasText: "resumed session" }).last()).toBeVisible();

		// Replayed tool-call from session history is rendered with completed status.
		await expect(app.toolCalls({ status: "completed" }).first()).toBeVisible();
	});
});
