import { expect, test } from "../fixtures.ts";

// Phase 0 mode foundation — verifies that `/mode <id>` flips the mode
// surface across runtimes via the StatusBar/ChatPanel attribute, no
// policy enforcement asserted (Phase 1 layers that in).

test("mode: default 'ask', /mode edit flips data-current-mode, persists in StatusBar", async ({ startApp, chat }) => {
	await startApp();

	// Lazy-init: send a no-LLM slash so a session is bound. /modes is local,
	// reads availableModes from the last config_option_update which is set by
	// session bootstrap.
	await chat.send("/modes");
	await expect.poll(() => chat.currentMode()).toBe("ask");

	await chat.send("/mode edit");
	await expect.poll(() => chat.currentMode()).toBe("edit");
	await expect(chat.lastMessage("system")).toContainText("mode switched to:");

	// Rejected: a bogus value should produce an error system message, mode stays edit.
	await chat.send("/mode bogus");
	await expect(chat.lastMessage("system")).toContainText(/error/i);
	await expect.poll(() => chat.currentMode()).toBe("edit");
});
