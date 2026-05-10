import { expect, test } from "./fixtures";

test("M12 tool-call card surfaces failed status when read targets a nonexistent file", async ({ app }) => {
	test.skip(!process.env.OPENAI_API_KEY, "needs OPENAI_API_KEY");

	await app.goto();
	await app.setSettings({ email: "tool-failure@example.com", id: 320, sendToken: true });
	await app.clickConnect();
	await app.expectStatus("connected");

	await app.send(
		"Use the read tool to read the file 'definitely-does-not-exist-xyz.txt'. " +
			"Do not write the file first. Just attempt the read once.",
	);
	await app.expectChatStatus("streaming");
	await app.expectChatStatus("idle", 60_000);

	const failed = app.toolCalls({ name: "read", status: "failed" });
	await expect(failed.first()).toBeVisible();
});
