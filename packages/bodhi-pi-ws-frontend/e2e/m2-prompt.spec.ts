import { expect, test } from "./fixtures";

test("real-LLM prompt round-trip with gpt-4o-mini", async ({ app }) => {
	await app.goto();
	await app.setSettings({ email: "alice@example.com", id: 1, sendToken: true });
	await app.clickConnect();
	await app.expectStatus("connected");

	await app.send("Reply with the single word: ping");
	await app.expectChatStatus("streaming");
	await app.expectChatStatus("idle");

	const userText = await app.lastMessageText("user");
	expect(userText).toContain("ping");

	const assistantText = await app.lastMessageText("assistant");
	expect(assistantText.toLowerCase()).toContain("ping");
});
