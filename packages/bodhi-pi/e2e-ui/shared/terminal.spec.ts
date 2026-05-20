import { expect, test } from "../fixtures.ts";

test("terminal: agent invokes bash tool", async ({ startApp, chat }) => {
	await startApp();

	// allow-all so the execute-category bash call runs without an ask-mode approval prompt (this spec
	// exercises tool behavior, not the approval flow — that's e2e-ui/shared/ask-mode.spec.ts).
	await chat.send("/mode allow-all");
	await expect.poll(() => chat.currentMode()).toBe("allow-all");

	await chat.send("Use the bash tool to run `echo hello-from-bash` and tell me the output.");
	await chat.waitForIdle();

	await expect(chat.toolCalls({ name: "bash", status: "completed" }).first()).toBeVisible();
	await expect(chat.lastMessage("assistant")).toContainText(/hello-from-bash/i);
});
