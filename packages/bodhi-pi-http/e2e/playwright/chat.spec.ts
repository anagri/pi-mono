import { expect, test } from "./fixtures.js";

const HAS_KEY = Boolean(process.env.OPENAI_API_KEY);

test.describe("chat round-trip (real LLM)", () => {
	test.skip(!HAS_KEY, "requires OPENAI_API_KEY");

	test("send a prompt and receive a streamed assistant reply", async ({ app }) => {
		await app.goto();
		await app.setSettings();
		await app.clickConnect();
		await app.expectStatus("connected");
		// Wait until the auto-created session is in place (data-session-id non-empty).
		await expect(app.status).not.toHaveAttribute("data-session-id", "");

		await app.send("Reply with the single word: pong. Nothing else.");
		await app.expectChatStatus("streaming");
		await app.expectChatStatus("idle");
		const reply = await app.lastMessageText("assistant");
		expect(reply.toLowerCase()).toContain("pong");
	});
});
