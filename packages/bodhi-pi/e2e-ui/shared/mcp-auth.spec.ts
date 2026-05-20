import { expect, test } from "../fixtures.ts";

function authMcpUrl(): string {
	const url = process.env.BODHI_PI_E2E_UI_MCP_AUTH_HTTP_URL;
	if (!url)
		throw new Error("BODHI_PI_E2E_UI_MCP_AUTH_HTTP_URL not set (e2e-ui global-setup must spawn auth-mcp-server)");
	return url;
}

function authMcpToken(): string {
	const tok = process.env.BODHI_PI_E2E_UI_MCP_AUTH_TOKEN;
	if (!tok) throw new Error("BODHI_PI_E2E_UI_MCP_AUTH_TOKEN not set");
	return tok;
}

async function lastSystemEvent(page: import("@playwright/test").Page, event: string) {
	return page.locator(`[data-testid="chat-message"][data-message-role="system"][data-mcp-event="${event}"]`).last();
}

test("mcp http-param header via /mcp* slash: add → connect → include → tools → /mcps shows connected", async ({
	startApp,
	chat,
	page,
}) => {
	await startApp();

	const payload = JSON.stringify({
		url: authMcpUrl(),
		auth: "http-param",
		headers: { Authorization: `Bearer ${authMcpToken()}` },
	});
	await chat.send(`/mcp add ${payload}`);
	const added = await lastSystemEvent(page, "added");
	await expect(added).toBeVisible();
	const slug = (await added.getAttribute("data-mcp-slug")) ?? "";
	expect(slug.length).toBeGreaterThan(0);

	await chat.send(`/mcp connect ${slug}`);
	const connected = await lastSystemEvent(page, "connected");
	await expect(connected).toContainText(`${slug}__whoami`);

	await chat.send(`/mcp include ${slug}`);
	await expect(await lastSystemEvent(page, "included")).toBeVisible();

	await chat.send(`/mcp tools ${slug}`);
	await expect(await lastSystemEvent(page, "tools")).toContainText(`${slug}__whoami`);

	await chat.send("/mcps");
	await expect(await lastSystemEvent(page, "list")).toContainText("connected");
});

test("mcp http-param query LLM prompt: agent invokes whoami and assistant relays 'authenticated via query'", async ({
	startApp,
	chat,
	page,
}) => {
	await startApp();

	// allow-all so the mcp tool call runs without an ask-mode approval prompt (this spec exercises mcp
	// tool behavior, not the approval flow — that's e2e-ui/shared/ask-mode.spec.ts).
	await chat.send("/mode allow-all");
	await expect.poll(() => chat.currentMode()).toBe("allow-all");

	const payload = JSON.stringify({
		url: authMcpUrl(),
		auth: "http-param",
		queries: { api_key: authMcpToken() },
	});
	await chat.send(`/mcp add ${payload}`);
	const added = await lastSystemEvent(page, "added");
	const slug = (await added.getAttribute("data-mcp-slug")) ?? "";

	await chat.send(`/mcp connect ${slug}`);
	await expect(await lastSystemEvent(page, "connected")).toBeVisible();
	await chat.send(`/mcp include ${slug}`);
	await expect(await lastSystemEvent(page, "included")).toBeVisible();

	await chat.send(`Call the tool "${slug}__whoami" with no arguments and reply with exactly the tool's text result.`);
	await chat.waitForIdle();

	await expect(chat.lastDoneMessage("assistant")).toContainText("authenticated via query");
	await expect(chat.toolCalls({ name: `${slug}__whoami` })).toHaveCount(1);
});
