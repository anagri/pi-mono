import { expect, test } from "./fixtures.js";

test.describe("cancel mid-stream", () => {
	test("clicking Stop returns chat status to idle", async ({ app }) => {
		await app.goto();
		await app.setSettings();
		await app.clickConnect();
		await app.expectStatus("connected");
		await expect(app.status).not.toHaveAttribute("data-session-id", "");

		// Long-running prompt so we can interrupt mid-stream.
		await app.send("Write a 1000-word essay on the history of the wheel.");
		await app.expectChatStatus("streaming");

		await expect(app.stopButton).toBeVisible();
		await app.stopButton.click();

		await app.expectChatStatus("idle");
	});
});
