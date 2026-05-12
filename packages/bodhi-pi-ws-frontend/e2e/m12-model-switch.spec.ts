import { expect, test } from "./fixtures";

test("/model switches between providers and updates the status bar", async ({ app }) => {
	await app.setup("gpt-4o-mini", { email: "model-switch@example.com", id: 340, sendToken: true });

	await app.send("Reply with the single word: hello");
	await app.expectChatStatus("idle");

	await app.model("claude-haiku-4-5");

	await app.send("Reply with the single word: switched");
	await app.expectChatStatus("idle");
	expect((await app.lastMessageText("assistant")).toLowerCase()).toContain("switched");
});
