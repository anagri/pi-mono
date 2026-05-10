import { expect, test } from "./fixtures";

test.describe("M10 seeded workspace", () => {
	test.use({ scenario: "workspace-readme" });

	test("agent reads readme.txt seeded into the workspace", async ({ app }) => {
		await app.goto();
		await app.setSettings({ email: "alice@example.com", id: 1, sendToken: true });
		await app.clickConnect();
		await app.expectStatus("connected");

		await app.send("Use the read tool to read readme.txt. Reply with the file's content verbatim and nothing else.");
		await app.expectChatStatus("streaming");
		await app.expectChatStatus("idle");

		await expect(app.toolCalls({ name: "read" }).first()).toHaveAttribute("data-tool-status", "completed");
		expect((await app.lastMessageText("assistant")).toLowerCase()).toContain("hello world");
	});
});
