import { expect, test } from "./fixtures";

test("create and list sessions via slash commands", async ({ app }) => {
	await app.setup("gpt-4o-mini", { email: "m5@example.com", id: 5, sendToken: true });

	await app.send("Reply with the single word: alpha");
	await app.expectChatStatus("idle");
	expect((await app.lastMessageText("assistant")).toLowerCase()).toContain("alpha");

	// Second session via /new.
	await app.newSession();
	await app.model("gpt-4o-mini");

	await app.send("Reply with the single word: bravo");
	await app.expectChatStatus("idle");
	expect((await app.lastMessageText("assistant")).toLowerCase()).toContain("bravo");

	// Two sessions visible in the passive sidebar list.
	await expect(app.sessionRows()).toHaveCount(2);

	// /sessions also surfaces them in a system message.
	await app.send("/sessions");
	const sys = app.page.getByTestId("system-message").last();
	await expect(sys).toContainText("sessions:");
});
