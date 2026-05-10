import { expect, test } from "./fixtures";

test("Stop button cancels an in-flight prompt", async ({ app }) => {
	await app.goto();
	await app.setSettings({ email: "cancel@example.com", id: 312, sendToken: true });
	await app.clickConnect();
	await app.expectStatus("connected");

	// A long-running prompt; we'll abort while it streams.
	await app.send("Write a 200-word descriptive story about a robot exploring a forest. Be detailed.");
	await app.expectChatStatus("streaming");

	const stop = app.page.getByTestId("composer-stop");
	await expect(stop).toBeVisible();
	await stop.click();

	// Server should stop streaming and the finally block in send() flips status to idle.
	await app.expectChatStatus("idle");

	// Composer re-enables and Send button comes back.
	await expect(app.composer).toBeEnabled();
	await expect(app.page.getByTestId("send")).toBeVisible();
});
