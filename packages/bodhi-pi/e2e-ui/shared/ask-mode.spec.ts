import { expect, test } from "../fixtures.ts";

// Phase 2: ask mode drives the approval round-trip through the chat composer across browser-runtime
// Hosts (browser, chrome-ext, http-WS). The agent suspends a write tool call; the composer flips to
// "awaiting approval"; a composer-typed `/approve once` releases it and the tool runs. No UI modal —
// per `test-apps/CLAUDE.md`. (http+SSE cannot carry requestPermission; that project is WS-backed.)

test("ask mode: a write attempt suspends for approval, then /approve once runs it", async ({
	startApp,
	chat,
	events,
}) => {
	await startApp();

	// Default mode is ask.
	await chat.send("/modes");
	await expect.poll(() => chat.currentMode()).toBe("ask");

	const composer = chat.root.locator('[data-testid="composer"]');

	await chat.send("Use the write tool to create the file /approved.txt with content: hello world.");

	// The turn suspends on requestPermission — the composer advertises the pending approval.
	await expect(composer).toHaveAttribute("data-awaiting-approval", "true", { timeout: 60_000 });
	await expect(events.rows({ type: "tool_approval_request" })).toHaveCount(1);

	await chat.send("/approve once");
	await chat.waitForIdle();

	// The verdict resolved on the wire and the write ran to completion.
	await expect(events.rows({ type: "tool_approval_response" })).toHaveCount(1);
	const completed = chat.toolCalls({ status: "completed" });
	await expect(completed).not.toHaveCount(0);
	await expect(completed.first()).toContainText(/write/i);
});
