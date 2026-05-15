import { expect, test } from "../fixtures.ts";

// User-driven MCP control plane via the chat composer. The shared
// test-app UI's slash dispatcher (`test-apps/browser/src/ui-lib/ui/commands.ts`)
// handles `/mcp*` locally — each command translates to a `_bodhi-pi/mcp/*`
// extension call, with results rendered as `data-message-role="system"` chat
// messages tagged with `data-mcp-event` and `data-mcp-slug`.
//
// mcp-everything is spawned by `e2e-ui/global-setup.ts` on port 33346 and
// exposed via `BODHI_PI_E2E_UI_MCP_EVERYTHING_HTTP_URL`.

function mcpEverythingUrl(): string {
	const url = process.env.BODHI_PI_E2E_UI_MCP_EVERYTHING_HTTP_URL;
	if (!url)
		throw new Error(
			"BODHI_PI_E2E_UI_MCP_EVERYTHING_HTTP_URL not set (e2e-ui global-setup must spawn mcp-everything)",
		);
	return url;
}

async function lastSystemEvent(page: import("@playwright/test").Page, event: string) {
	return page.locator(`[data-testid="chat-message"][data-message-role="system"][data-mcp-event="${event}"]`).last();
}

test("mcp public+http via /mcp* slash commands: add → list → connect → tools → disconnect → reconnect → remove", async ({
	startApp,
	chat,
	page,
}) => {
	await startApp();

	// Step 1: add via slash command. Slug derived from URL host.
	await chat.send(`/mcp add url=${mcpEverythingUrl()}`);
	const added = await lastSystemEvent(page, "added");
	await expect(added).toBeVisible();
	const slug = (await added.getAttribute("data-mcp-slug")) ?? "";
	expect(slug.length).toBeGreaterThan(0);

	// Step 2: /mcps shows the entry as disconnected.
	await chat.send("/mcps");
	const list = await lastSystemEvent(page, "list");
	await expect(list).toBeVisible();
	await expect(list).toContainText(slug);
	await expect(list).toContainText("disconnected");

	// Step 3: /mcp connect — tools should include `<slug>__echo`.
	await chat.send(`/mcp connect ${slug}`);
	const connected = await lastSystemEvent(page, "connected");
	await expect(connected).toBeVisible();
	await expect(connected).toContainText(`${slug}__echo`);

	// Step 4: /mcp tools — same set of names.
	await chat.send(`/mcp tools ${slug}`);
	const tools = await lastSystemEvent(page, "tools");
	await expect(tools).toBeVisible();
	await expect(tools).toContainText(`${slug}__echo`);

	// Step 5: /mcp disconnect — tools query then returns empty.
	await chat.send(`/mcp disconnect ${slug}`);
	const disconnected = await lastSystemEvent(page, "disconnected");
	await expect(disconnected).toBeVisible();
	await chat.send(`/mcp tools ${slug}`);
	const toolsEmpty = await lastSystemEvent(page, "tools-empty");
	await expect(toolsEmpty).toBeVisible();

	// Step 6: /mcp reconnect — tools back.
	await chat.send(`/mcp reconnect ${slug}`);
	const reconnected = await lastSystemEvent(page, "reconnected");
	await expect(reconnected).toBeVisible();
	await expect(reconnected).toContainText(`${slug}__echo`);

	// Step 7: /mcp remove — subsequent /mcps omits it.
	await chat.send(`/mcp remove ${slug}`);
	const removed = await lastSystemEvent(page, "removed");
	await expect(removed).toBeVisible();
});
