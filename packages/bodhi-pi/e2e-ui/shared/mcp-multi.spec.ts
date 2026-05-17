import { expect, test } from "../fixtures.ts";

// Hosted public OAuth-free MCP used as the second MCP in multi-MCP tests.
// Hardcoded rather than env-var-driven: Playwright globalSetup mutations to
// process.env don't always reach worker processes cleanly, and the URL is
// stable.
const DEEPWIKI_URL = "https://mcp.deepwiki.com/mcp";

function mcpEverythingUrl(): string {
	const url = process.env.BODHI_PI_E2E_UI_MCP_EVERYTHING_HTTP_URL;
	if (!url) throw new Error("BODHI_PI_E2E_UI_MCP_EVERYTHING_HTTP_URL not set");
	return url;
}

function systemEventsLocator(page: import("@playwright/test").Page, event: string) {
	return page.locator(`[data-testid="chat-message"][data-message-role="system"][data-mcp-event="${event}"]`);
}

function systemEventForSlug(page: import("@playwright/test").Page, event: string, slug: string) {
	return page.locator(
		`[data-testid="chat-message"][data-message-role="system"][data-mcp-event="${event}"][data-mcp-slug="${slug}"]`,
	);
}

async function lastSystemEvent(page: import("@playwright/test").Page, event: string) {
	return systemEventsLocator(page, event).last();
}

test("mcp-multi: two MCPs connected, only one included, /mcp include surfaces the second", async ({
	startApp,
	chat,
	page,
}) => {
	await startApp();

	const addedEvents = systemEventsLocator(page, "added");
	await chat.send(`/mcp add {"url":"${mcpEverythingUrl()}","auth":"public","label":"everything"}`);
	await expect(addedEvents).toHaveCount(1);
	const slugA = (await addedEvents.nth(0).getAttribute("data-mcp-slug")) ?? "";

	await chat.send(`/mcp add {"url":"${DEEPWIKI_URL}","auth":"public","label":"deepwiki"}`);
	await expect(addedEvents).toHaveCount(2);
	const slugB = (await addedEvents.nth(1).getAttribute("data-mcp-slug")) ?? "";
	expect(slugB).not.toEqual(slugA);

	await chat.send(`/mcp connect ${slugA}`);
	await expect(systemEventForSlug(page, "connected", slugA)).toBeVisible();
	await chat.send(`/mcp connect ${slugB}`);
	await expect(systemEventForSlug(page, "connected", slugB)).toBeVisible();

	// Include only A first.
	await chat.send(`/mcp include ${slugA}`);
	await expect(systemEventForSlug(page, "included", slugA)).toBeVisible();

	// A's tools visible.
	await chat.send(`/mcp tools ${slugA}`);
	await expect(systemEventForSlug(page, "tools", slugA)).toContainText(`${slugA}__`);

	// B not included yet — tools-empty.
	await chat.send(`/mcp tools ${slugB}`);
	await expect(systemEventForSlug(page, "tools-empty", slugB)).toBeVisible();

	// Now include B.
	await chat.send(`/mcp include ${slugB}`);
	await expect(systemEventForSlug(page, "included", slugB)).toBeVisible();

	await chat.send(`/mcp tools ${slugB}`);
	await expect(systemEventForSlug(page, "tools", slugB)).toContainText(`${slugB}__`);
});

test("mcp-multi: page reload auto-restores connected MCPs (browser/chrome-ext only)", async ({
	startApp,
	chat,
	page,
}, testInfo) => {
	// In-worker MCP connections die when page refresh kills the worker; the
	// host (browser/chrome-ext bootstrap-worker) restores them from kv on boot
	// for entries whose `lastKnownStatus === "connected"`. http and ws keep
	// connections at the server level, so the host-restore path isn't relevant
	// there.
	const inProcess = testInfo.project.metadata?.inProcessAgent === true;
	test.skip(!inProcess, "page-reload restore only applies to in-process worker hosts");

	await startApp();
	await chat.send(`/mcp add {"url":"${mcpEverythingUrl()}","auth":"public"}`);
	const added = await lastSystemEvent(page, "added");
	await expect(added).toBeVisible();
	const slug = (await added.getAttribute("data-mcp-slug")) ?? "";

	await chat.send(`/mcp connect ${slug}`);
	await expect(systemEventForSlug(page, "connected", slug)).toBeVisible();

	// /mcps confirms status=connected before reload.
	await chat.send("/mcps");
	const listBeforeReload = await lastSystemEvent(page, "list");
	await expect(listBeforeReload).toContainText(`${slug}  connected`);

	// Worker dies on reload; kv (Dexie) survives. Worker boot reads kv and
	// reconnects every entry with lastKnownStatus=connected.
	await page.reload();
	await startApp();

	await chat.send("/mcps");
	const listAfterReload = await lastSystemEvent(page, "list");
	await expect(listAfterReload).toContainText(`${slug}  connected`);
});

test("mcp-multi: /mcp exclude hides tools from this session without disconnecting globally", async ({
	startApp,
	chat,
	page,
}) => {
	await startApp();

	await chat.send(`/mcp add {"url":"${mcpEverythingUrl()}","auth":"public"}`);
	const added = await lastSystemEvent(page, "added");
	const slug = (await added.getAttribute("data-mcp-slug")) ?? "";

	await chat.send(`/mcp connect ${slug}`);
	await expect(await lastSystemEvent(page, "connected")).toBeVisible();
	await chat.send(`/mcp include ${slug}`);
	await expect(await lastSystemEvent(page, "included")).toBeVisible();

	await chat.send(`/mcp exclude ${slug}`);
	await expect(await lastSystemEvent(page, "excluded")).toBeVisible();

	await chat.send(`/mcp tools ${slug}`);
	await expect(await lastSystemEvent(page, "tools-empty")).toBeVisible();

	// /mcps still shows it as connected globally.
	await chat.send("/mcps");
	await expect(await lastSystemEvent(page, "list")).toContainText("connected");
});
