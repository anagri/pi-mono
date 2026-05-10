import { expect, test } from "./fixtures.js";

const HAS_KEY = Boolean(process.env.OPENAI_API_KEY);

test.describe("project extensions (redact-secrets)", () => {
	test.skip(!HAS_KEY, "requires OPENAI_API_KEY");
	test.use({ scenario: "extensions-redact-secrets" });

	test("extension hooks tool_result; assistant cannot leak the original secret", async ({ app }) => {
		await app.goto();
		await app.setSettings();
		await app.clickConnect();
		await app.expectStatus("connected");

		await app.send("Read the file leak.txt and tell me what's there verbatim.");
		await app.expectChatStatus("idle");

		const completed = app.toolCalls({ status: "completed" });
		await expect(completed.first()).toBeVisible();

		const preview = completed.first().getByTestId("tool-call-preview");
		await expect(preview).toContainText("[REDACTED]");
		await expect(preview).not.toContainText("sk-PLAINTEXTSECRETXYZ123");

		const last = app.page.locator('[data-testid="message"][data-role="assistant"]').last();
		await expect(last).toContainText(/\[REDACTED\]/);
		await expect(last).not.toContainText(/sk-PLAINTEXTSECRETXYZ123/);
	});
});
