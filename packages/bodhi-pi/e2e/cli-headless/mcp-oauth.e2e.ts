import { afterEach, expect, test } from "vitest";
import { type HeadlessSlashSession, startHeadlessSlashSession } from "./headless-session.js";

let activeSession: HeadlessSlashSession | undefined;

afterEach(async () => {
	if (activeSession) {
		await activeSession.cleanup();
		activeSession = undefined;
	}
});

function oauthFixture(): {
	mcpUrl: string;
	authorizeUrl: string;
	tokenUrl: string;
	clientId: string;
	clientSecret: string;
} {
	const need = (name: string): string => {
		const value = process.env[name];
		if (!value) throw new Error(`${name} not set — global-setup must spawn oauth-mcp-server`);
		return value;
	};
	return {
		mcpUrl: need("BODHI_PI_E2E_OAUTH_MCP_URL"),
		authorizeUrl: need("BODHI_PI_E2E_OAUTH_AUTHORIZE_URL"),
		tokenUrl: need("BODHI_PI_E2E_OAUTH_TOKEN_URL"),
		clientId: need("BODHI_PI_E2E_OAUTH_CLIENT_ID"),
		clientSecret: need("BODHI_PI_E2E_OAUTH_CLIENT_SECRET"),
	};
}

// Each test reserves its own ephemeral port from this pool so concurrent vitest workers don't
// collide on :7777. Tests fast — no need to recycle.
const PORT_POOL = [37771, 37772, 37773, 37774, 37775];
function pickPort(idx: number): number {
	return PORT_POOL[idx % PORT_POOL.length]!;
}

test("cli e2e-ui: /mcp oauth start completes against fixture; /mcp connect uses persisted Bearer", async () => {
	const session = await startHeadlessSlashSession({
		model: "gpt-4o-mini",
		provider: "openai",
		tmpDirPrefix: "bodhi-pi-e2e-ui-cli-mcp-oauth-",
	});
	activeSession = session;
	const fix = oauthFixture();
	const port = pickPort(0);

	const addPayload = JSON.stringify({
		url: fix.mcpUrl,
		auth: "oauth-preregistered",
		authorizeUrl: fix.authorizeUrl,
		tokenUrl: fix.tokenUrl,
		clientId: fix.clientId,
		clientSecret: fix.clientSecret,
		label: "oauthfix",
	});
	const added = await session.sendSlash(`/mcp add ${addPayload}`);
	expect.soft(added).toMatch(/^added: /);
	const slug = added.replace(/^added: /, "").trim();

	// `--auto` tells the slash to fetch the authorize URL itself (the fixture's `?auto=1` query
	// bypasses the approve page) — completes the flow end-to-end inside the cli process.
	const oauth = await session.sendSlash(`/mcp oauth start ${slug} --auto --port=${port}`);
	expect.soft(oauth).toContain("oauth: completed");

	const connected = await session.sendSlash(`/mcp connect ${slug}`);
	expect.soft(connected).toContain(`${slug}__whoami`);

	await session.sendSlash(`/mcp include ${slug}`);
	const tools = await session.sendSlash(`/mcp tools ${slug}`);
	expect.soft(tools).toContain(`${slug}__whoami`);

	// /mcps shows the slug stays connected after auth attaches.
	const listed = await session.sendSlash(`/mcps`);
	expect.soft(listed).toContain(slug);
	expect.soft(listed).toContain("connected");
}, 30_000);

test("cli e2e-ui: /mcp oauth start emits 'failed' when token endpoint rejects (wrong client_secret)", async () => {
	const session = await startHeadlessSlashSession({
		model: "gpt-4o-mini",
		provider: "openai",
		tmpDirPrefix: "bodhi-pi-e2e-ui-cli-mcp-oauth-",
	});
	activeSession = session;
	const fix = oauthFixture();
	const port = pickPort(1);

	const addPayload = JSON.stringify({
		url: fix.mcpUrl,
		auth: "oauth-preregistered",
		authorizeUrl: fix.authorizeUrl,
		tokenUrl: fix.tokenUrl,
		clientId: fix.clientId,
		clientSecret: "wrong-secret-xyz",
		label: "oauthfix-bad",
	});
	const added = await session.sendSlash(`/mcp add ${addPayload}`);
	const slug = added.replace(/^added: /, "").trim();

	const oauth = await session.sendSlash(`/mcp oauth start ${slug} --auto --port=${port}`);
	expect.soft(oauth.toLowerCase()).toMatch(/failed|invalid_client|unauthorized/);
}, 30_000);
