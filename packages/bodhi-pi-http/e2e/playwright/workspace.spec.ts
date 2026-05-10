import { expect, test } from "./fixtures.js";

const HAS_KEY = Boolean(process.env.OPENAI_API_KEY);

test.describe("seeded workspace via --workspace (real LLM)", () => {
	test.skip(!HAS_KEY, "requires OPENAI_API_KEY");
	test.use({ scenario: "workspace-readme" });

	test("agent reads a file seeded into the spawned server's workspace", async ({ app }) => {
		await app.goto();
		await app.setSettings();
		await app.clickConnect();
		await app.expectStatus("connected");

		await app.send("Use the read tool to read readme.txt. Reply with the file's content verbatim and nothing else.");
		await app.expectChatStatus("idle");

		await expect(app.toolCalls({ name: "read" }).first()).toHaveAttribute("data-tool-status", "completed");
		await expect(app.page.locator('[data-testid="message"][data-role="assistant"]').last()).toContainText(
			/hello world/i,
		);
	});
});
