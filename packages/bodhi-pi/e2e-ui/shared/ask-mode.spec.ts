import { expect, test } from "../fixtures.ts";

// Phase 2: ask mode drives the approval round-trip through the chat composer across the bidirectional
// transports (browser, chrome-ext, ws). The agent suspends a write tool call; the composer flips to
// "awaiting approval"; a composer-typed `/approve once` releases it and the tool runs. No UI modal —
// per `test-apps/CLAUDE.md`.
//
// Skipped on `http`: the HTTP+SSE transport can't carry a server→client `requestPermission`, so the
// composer never receives the prompt. WS covers the HTTP runtime for approvals.
//
// Counts are asserted ">= 1" rather than "== 1": the test-app's http/ws server forwards lifecycle
// events on two rails (createForwardingEventHandlers + the core event-wiring), so dual-listed events
// surface twice over WS — expected test-app behavior, mirrored by the e2e ">= 1" assertions.

test("ask mode: a write attempt suspends for approval, then /approve once runs it", async ({
	startApp,
	chat,
	events,
}, testInfo) => {
	test.skip(
		testInfo.project.name === "http",
		"http+SSE cannot carry the server→client requestPermission; WS covers the HTTP runtime",
	);
	await startApp();

	// Default mode is ask.
	await chat.send("/modes");
	await expect.poll(() => chat.currentMode()).toBe("ask");

	const composer = chat.root.locator('[data-testid="composer"]');

	// Relative path so it resolves inside the session cwd on every runtime (the http/ws server jails
	// writes to a per-user workspace; a root path like /approved.txt is rejected there).
	await chat.send("Use the write tool to create the file approved.txt with content: hello world.");

	// The turn suspends on requestPermission — the composer advertises the pending approval.
	await expect(composer).toHaveAttribute("data-awaiting-approval", "true", { timeout: 60_000 });
	await expect
		.poll(() => events.rows({ type: "tool_approval_request" }).count(), { message: "approval requested" })
		.toBeGreaterThanOrEqual(1);

	await chat.send("/approve once");
	await chat.waitForIdle();

	// The verdict resolved on the wire and the write ran to completion.
	await expect
		.poll(() => events.rows({ type: "tool_approval_response" }).count(), { message: "approval responded" })
		.toBeGreaterThanOrEqual(1);
	const completed = chat.toolCalls({ status: "completed" });
	await expect(completed).not.toHaveCount(0);
	await expect(completed.first()).toContainText(/write/i);
});
