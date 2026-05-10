import { expect, test } from "./fixtures.js";

const HAS_KEY = Boolean(process.env.OPENAI_API_KEY);

test.describe("tool-call failure (real LLM)", () => {
	test.skip(!HAS_KEY, "requires OPENAI_API_KEY");

	test("read tool against a missing file surfaces failed status", async ({ app }) => {
		await app.goto();
		await app.setSettings();
		await app.clickConnect();
		await app.expectStatus("connected");

		await app.send(
			"Use the read tool to read the file 'definitely-does-not-exist-xyz.txt'. " +
				"Do not write the file first. Just attempt the read once.",
		);
		await app.expectChatStatus("streaming");
		await app.expectChatStatus("idle");

		const failed = app.toolCalls({ status: "failed" });
		await expect(failed.first()).toBeVisible();
	});
});
