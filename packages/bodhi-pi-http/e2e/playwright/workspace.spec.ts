import { expect, test } from "./fixtures.js";

test.describe("seeded workspace via --workspace (real LLM)", () => {
	test.use({ scenario: "workspace-readme" });

	test("agent reads a file seeded into the spawned server's workspace", async ({ app }) => {
		await app.setup("gpt-4o-mini");

		await app.send("Use the read tool to read readme.txt. Reply with the file's content verbatim and nothing else.");
		await app.expectChatStatus("idle");

		await expect(app.toolCalls({ name: "read" }).first()).toHaveAttribute("data-tool-status", "completed");
		await expect(app.page.locator('[data-testid="message"][data-role="assistant"]').last()).toContainText(
			/hello world/i,
		);
	});
});
