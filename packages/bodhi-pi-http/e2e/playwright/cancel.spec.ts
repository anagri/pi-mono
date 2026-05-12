import { expect, test } from "./fixtures.js";

test.describe("cancel mid-stream", () => {
	test("clicking Stop returns chat status to idle", async ({ app }) => {
		await app.setup("gpt-4o-mini");

		await app.send("Write a 1000-word essay on the history of the wheel.");
		await app.expectChatStatus("streaming");

		await expect(app.stopButton).toBeVisible();
		await app.stopButton.click();

		await app.expectChatStatus("idle");
	});
});
