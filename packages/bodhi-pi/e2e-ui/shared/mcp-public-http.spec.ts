import { expect, test } from "../fixtures.ts";

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

test("mcp public+http LLM prompt: agent uses get-sum(20, 22) and replies with 42", async ({ startApp, chat, page }) => {
	await startApp();

	// allow-all so the mcp tool call runs without an ask-mode approval prompt (tool behavior, not the
	// approval flow — that's e2e-ui/shared/ask-mode.spec.ts).
	await chat.send("/mode allow-all");
	await expect.poll(() => chat.currentMode()).toBe("allow-all");

	await chat.send(`/mcp add {"url":"${mcpEverythingUrl()}","auth":"public"}`);
	const added = await lastSystemEvent(page, "added");
	await expect(added).toBeVisible();
	const slug = (await added.getAttribute("data-mcp-slug")) ?? "";
	expect(slug.length).toBeGreaterThan(0);

	await chat.send(`/mcp connect ${slug}`);
	await expect(await lastSystemEvent(page, "connected")).toBeVisible();

	// connect is global; this UI session must explicitly include the slug to see its tools.
	await chat.send(`/mcp include ${slug}`);
	await expect(await lastSystemEvent(page, "included")).toBeVisible();

	await chat.send(
		`Using the everything-mcp tool "${slug}__get-sum", find the sum of 20 and 22. Reply with just the number.`,
	);
	await chat.waitForIdle();

	await expect(chat.lastDoneMessage("assistant")).toContainText("42");
	await expect(chat.toolCalls({ name: `${slug}__get-sum` })).toHaveCount(1);
});

test("mcp public+http via /mcp* slash commands: add → list → connect → tools → disconnect → reconnect → remove", async ({
	startApp,
	chat,
	page,
}) => {
	await startApp();

	await chat.send(`/mcp add {"url":"${mcpEverythingUrl()}","auth":"public"}`);
	const added = await lastSystemEvent(page, "added");
	await expect(added).toBeVisible();
	const slug = (await added.getAttribute("data-mcp-slug")) ?? "";
	expect(slug.length).toBeGreaterThan(0);

	await chat.send("/mcps");
	const list = await lastSystemEvent(page, "list");
	await expect(list).toContainText(slug);
	await expect(list).toContainText("disconnected");

	await chat.send(`/mcp connect ${slug}`);
	const connected = await lastSystemEvent(page, "connected");
	await expect(connected).toContainText(`${slug}__get-sum`);

	// Before include: tools-empty (connect-only doesn't make a session see them).
	await chat.send(`/mcp tools ${slug}`);
	await expect(await lastSystemEvent(page, "tools-empty")).toBeVisible();

	await chat.send(`/mcp include ${slug}`);
	const included = await lastSystemEvent(page, "included");
	await expect(included).toContainText(`${slug}__get-sum`);

	await chat.send(`/mcp tools ${slug}`);
	const tools = await lastSystemEvent(page, "tools");
	await expect(tools).toContainText(`${slug}__get-sum`);

	await chat.send(`/mcp disconnect ${slug}`);
	await expect(await lastSystemEvent(page, "disconnected")).toBeVisible();
	await chat.send(`/mcp tools ${slug}`);
	await expect(await lastSystemEvent(page, "tools-empty")).toBeVisible();

	await chat.send(`/mcp reconnect ${slug}`);
	const reconnected = await lastSystemEvent(page, "reconnected");
	await expect(reconnected).toContainText(`${slug}__get-sum`);
	// inclusion was untouched across disconnect/reconnect; tools come back automatically.
	await chat.send(`/mcp tools ${slug}`);
	const toolsAfterReconnect = await lastSystemEvent(page, "tools");
	await expect(toolsAfterReconnect).toContainText(`${slug}__get-sum`);

	await chat.send(`/mcp remove ${slug}`);
	await expect(await lastSystemEvent(page, "removed")).toBeVisible();
});
