import { expect, test } from "../fixtures.ts";

test("terminal: agent invokes bash tool", async ({ gotoStart, setup, chat, uniqueUserId, configJson }) => {
	await gotoStart();
	await setup.fillAndSubmit({
		userId: uniqueUserId,
		email: `${uniqueUserId}@e2e-ui.test`,
		configJson,
	});

	await chat.send("Use the bash tool to run `echo hello-from-bash` and tell me the output.");
	await chat.waitForIdle();

	await expect(chat.toolCalls({ name: "bash", status: "completed" }).first()).toBeVisible();
	await expect(chat.lastMessage("assistant")).toContainText(/hello-from-bash/i);
});
