import { expect, test } from "../fixtures.ts";

test("terminal: agent invokes bash tool", async ({ startApp, chat }) => {
	await startApp();

	await chat.send("Use the bash tool to run `echo hello-from-bash` and tell me the output.");
	await chat.waitForIdle();

	await expect(chat.toolCalls({ name: "bash", status: "completed" }).first()).toBeVisible();
	await expect(chat.lastMessage("assistant")).toContainText(/hello-from-bash/i);
});
