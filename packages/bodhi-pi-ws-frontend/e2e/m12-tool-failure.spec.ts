import { expect, test } from "./fixtures";

test("M12 tool-call card surfaces failed status when read targets a nonexistent file", async ({ app }) => {
	await app.setup("gpt-4o-mini", { email: "tool-failure@example.com", id: 320, sendToken: true });

	await app.send(
		"Use the read tool to read the file 'definitely-does-not-exist-xyz.txt'. " +
			"Do not write the file first. Just attempt the read once.",
	);
	await app.expectChatStatus("streaming");
	await app.expectChatStatus("idle");

	const failed = app.toolCalls({ name: "read", status: "failed" });
	await expect(failed.first()).toBeVisible();
});
