import { expect, test } from "../fixtures.ts";

function oauthFixture(): {
	mcpUrl: string;
	authorizeUrl: string;
	tokenUrl: string;
	registrationEndpoint: string;
	clientId: string;
	clientSecret: string;
} {
	const need = (name: string): string => {
		const v = process.env[name];
		if (!v) throw new Error(`${name} not set — e2e-ui global-setup must spawn oauth-mcp-server`);
		return v;
	};
	return {
		mcpUrl: need("BODHI_PI_E2E_UI_OAUTH_MCP_URL"),
		authorizeUrl: need("BODHI_PI_E2E_UI_OAUTH_AUTHORIZE_URL"),
		tokenUrl: need("BODHI_PI_E2E_UI_OAUTH_TOKEN_URL"),
		registrationEndpoint: need("BODHI_PI_E2E_UI_OAUTH_REGISTRATION_URL"),
		clientId: need("BODHI_PI_E2E_UI_OAUTH_CLIENT_ID"),
		clientSecret: need("BODHI_PI_E2E_UI_OAUTH_CLIENT_SECRET"),
	};
}

async function lastSystemEvent(page: import("@playwright/test").Page, event: string) {
	return page.locator(`[data-testid="chat-message"][data-message-role="system"][data-mcp-event="${event}"]`).last();
}

/**
 * Stub chrome.identity.launchWebAuthFlow on chrome-ext so Playwright can drive the OAuth flow
 * without a real Chrome-managed auth window. The stub fetches the authorize URL (which has
 * `&auto=1` appended by the slash) and returns the resulting redirect URL synchronously — the
 * same shape the real chrome.identity would return after a successful flow.
 *
 * Extension pages define `window.chrome` as a non-writable property, so we use
 * `Object.defineProperty` to override `chrome.identity` (which is also locked down). Without
 * the configurable: true reassignment, simple `chrome.identity.launchWebAuthFlow = …`
 * silently no-ops in strict mode.
 */
async function stubChromeIdentity(page: import("@playwright/test").Page): Promise<void> {
	await page.addInitScript(() => {
		const stubIdentity = {
			getRedirectURL: (_path?: string): string => "https://test-ext-id.chromiumapp.org/",
			launchWebAuthFlow: (opts: { url: string; interactive: boolean }, cb: (responseUrl?: string) => void): void => {
				// `redirect: "manual"` cross-origin returns an opaqueredirect response with no
				// readable headers, so the fixture's `&respond=json` mode returns the redirect URL
				// in a CORS-readable JSON body instead. We construct the final responseUrl from it.
				const url = new URL(opts.url);
				url.searchParams.set("respond", "json");
				fetch(url.toString())
					.then((r) => r.json())
					.then((body: { redirectUri?: string }) => cb(body.redirectUri))
					.catch(() => cb(undefined));
			},
		};
		const win = window as unknown as { chrome?: Record<string, unknown> };
		if (!win.chrome) {
			Object.defineProperty(window, "chrome", { value: {}, configurable: true, writable: true });
		}
		// Force-override chrome.identity even if it's defined as a non-writable property by
		// Chrome's extension runtime — defineProperty with configurable:true wins.
		Object.defineProperty(win.chrome as object, "identity", {
			value: stubIdentity,
			configurable: true,
			writable: true,
		});
	});
}

test.beforeEach(async ({ page }, testInfo) => {
	if (testInfo.project.metadata?.chromeExt === true) {
		await stubChromeIdentity(page);
	}
});

test("oauth-preregistered (auth: 'oauth-preregistered'): full flow via /mcp add → /mcp oauth start --auto → /mcp connect", async ({
	startApp,
	chat,
	page,
}) => {
	await startApp();
	const fix = oauthFixture();

	const addPayload = JSON.stringify({
		url: fix.mcpUrl,
		auth: "oauth-preregistered",
		authorizeUrl: fix.authorizeUrl,
		tokenUrl: fix.tokenUrl,
		clientId: fix.clientId,
		clientSecret: fix.clientSecret,
		label: "oauthfix",
	});
	await chat.send(`/mcp add ${addPayload}`);
	const added = await lastSystemEvent(page, "added");
	await expect(added).toBeVisible();
	const slug = (await added.getAttribute("data-mcp-slug")) ?? "";
	expect(slug.length).toBeGreaterThan(0);

	await chat.send(`/mcp oauth start ${slug} --auto`);
	const completed = await lastSystemEvent(page, "oauth-completed");
	await expect(completed).toBeVisible({ timeout: 20_000 });
	await expect(completed).toHaveAttribute("data-mcp-slug", slug);

	await chat.send(`/mcp connect ${slug}`);
	const connected = await lastSystemEvent(page, "connected");
	await expect(connected).toContainText(`${slug}__whoami`);

	await chat.send("/mcps");
	await expect(await lastSystemEvent(page, "list")).toContainText("connected");
});

test("oauth-dcr (auth: 'oauth-dcr'): server runs discovery + DCR then full flow", async ({ startApp, chat, page }) => {
	await startApp();
	const fix = oauthFixture();

	// `redirectUri` here is registered with the DCR endpoint AND becomes the persisted
	// `auth.redirectUri` default. Use the runtime's actual page origin so the same URL flows
	// through to oauth/start when the slash composes its redirect_uri from window.location.origin.
	const runtimeRedirectUri = await page.evaluate(() => `${window.location.origin}/oauth/callback`);
	const addPayload = JSON.stringify({
		url: fix.mcpUrl,
		auth: "oauth-dcr",
		redirectUri: runtimeRedirectUri,
		scopes: ["read"],
		label: "dcrfix",
	});
	await chat.send(`/mcp add ${addPayload}`);
	const added = await lastSystemEvent(page, "added");
	await expect(added).toBeVisible();
	const slug = (await added.getAttribute("data-mcp-slug")) ?? "";
	expect(slug.length).toBeGreaterThan(0);

	await chat.send(`/mcp oauth start ${slug} --auto`);
	const completed = await lastSystemEvent(page, "oauth-completed");
	await expect(completed).toBeVisible({ timeout: 20_000 });

	await chat.send(`/mcp connect ${slug}`);
	const connected = await lastSystemEvent(page, "connected");
	await expect(connected).toContainText(`${slug}__whoami`);
});
