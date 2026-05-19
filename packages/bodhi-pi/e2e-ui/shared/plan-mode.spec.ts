import { expect, test } from "../fixtures.ts";

// Phase 1: plan mode actually rejects mutating tool calls and the rejection
// surfaces as a [data-testid="custom-message"][data-test-state="tool-blocked"]
// chat entry across all browser-runtime Hosts (browser, chrome-ext, http, ws).

test("plan mode: /mode plan + LLM write attempt produces a tool-blocked custom_message", async ({ startApp, chat }) => {
	await startApp();

	// Bind a session via a no-LLM slash so currentMode is observable.
	await chat.send("/modes");
	await expect.poll(() => chat.currentMode()).toBe("ask");

	await chat.send("/mode plan");
	await expect.poll(() => chat.currentMode()).toBe("plan");

	await chat.send("Use the write tool to create the file /forbidden.txt with content: hello world.");
	await chat.waitForIdle();

	const blocked = chat.root.locator('[data-testid="custom-message"][data-test-state="tool-blocked"]');
	await expect(blocked).toHaveCount(1);
	await expect(blocked).toHaveAttribute("data-tool-name", "write");
	await expect(blocked).toHaveAttribute("data-mode", "plan");
	await expect(blocked).toContainText(/plan mode/i);
});
