import { expect, test } from "./fixtures.js";

test.describe("tool-call cards (real LLM)", () => {
	test("real prompt triggers a tool-call card that reaches completed", async ({ app }) => {
		await app.setup("gpt-4o-mini");

		await app.send("Create a file named greeting.txt in the current directory with the text 'hello'.");
		await app.expectChatStatus("streaming");
		await app.expectChatStatus("idle");

		const completed = app.toolCalls({ status: "completed" });
		await expect(completed.first()).toBeVisible();
	});
});
