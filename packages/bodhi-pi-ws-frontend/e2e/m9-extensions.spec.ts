import { expect, test } from "./fixtures";

test.describe("M9 project extensions (redact-secrets)", () => {
	test.use({ scenario: "extensions-redact-secrets" });

	test("extension hooks tool_result; assistant cannot leak the original secret", async ({ app }) => {
		test.skip(!process.env.OPENAI_API_KEY, "needs OPENAI_API_KEY");

		await app.goto();
		await app.setSettings({ email: "alice@example.com", id: 1, sendToken: true });
		await app.clickConnect();
		await app.expectStatus("connected");

		await app.send("Read the file leak.txt and tell me what's there verbatim.");
		await app.expectChatStatus("streaming");
		await app.expectChatStatus("idle");

		// The read tool fires...
		const completed = app.toolCalls({ status: "completed" });
		await expect(completed.first()).toBeVisible();

		// ...and the assistant's final answer reflects the REDACTED token,
		// proving the extension's tool_result hook ran on the Node side.
		const text = await app.lastMessageText("assistant");
		expect(text).toContain("[REDACTED]");
		expect(text).not.toContain("sk-PLAINTEXTSECRETXYZ123");
	});
});
