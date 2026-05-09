import { expect, test } from "./fixtures";

test("create, switch, and delete sessions", async ({ app }) => {
	test.skip(!process.env.OPENAI_API_KEY, "needs OPENAI_API_KEY");

	await app.goto();
	// Unique userId so this test's session list is isolated from M1/M2/M4 which use id=1.
	await app.setSettings({ email: "m5@example.com", id: 5, sendToken: true });
	await app.clickConnect();
	await app.expectStatus("connected");

	// Send first prompt — creates session A.
	await app.send("Reply with the single word: alpha");
	await app.expectChatStatus("idle");
	const alphaText = await app.lastMessageText("assistant");
	expect(alphaText.toLowerCase()).toContain("alpha");

	// Start a new session, send second prompt — creates session B.
	await app.clickNewSession();
	await app.send("Reply with the single word: bravo");
	await app.expectChatStatus("idle");
	const bravoText = await app.lastMessageText("assistant");
	expect(bravoText.toLowerCase()).toContain("bravo");

	// Two sessions visible in the list.
	await expect(app.sessionRows()).toHaveCount(2);
});
