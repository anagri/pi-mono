import { expect, test } from "./fixtures";

test("real-LLM prompt round-trip with gpt-4o-mini", async ({ app }) => {
	await app.setup("gpt-4o-mini", { email: "alice@example.com", id: 1, sendToken: true });

	await app.send("Reply with the single word: ping");
	await app.expectChatStatus("streaming");
	await app.expectChatStatus("idle");

	const userText = await app.lastMessageText("user");
	expect(userText).toContain("ping");

	const assistantText = await app.lastMessageText("assistant");
	expect(assistantText.toLowerCase()).toContain("ping");
});
