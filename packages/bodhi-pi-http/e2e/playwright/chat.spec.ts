import { expect, test } from "./fixtures.js";

test.describe("chat round-trip (real LLM)", () => {
	test("send a prompt and receive a streamed assistant reply", async ({ app }) => {
		await app.setup("gpt-4o-mini");

		await app.send("Reply with the single word: pong. Nothing else.");
		await app.expectChatStatus("streaming");
		await app.expectChatStatus("idle");
		const reply = await app.lastMessageText("assistant");
		expect(reply.toLowerCase()).toContain("pong");
	});
});
