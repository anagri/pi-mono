import { afterEach, expect, test } from "vitest";
import { type HeadlessSlashSession, startHeadlessSlashSession } from "./headless-session.js";

let activeSession: HeadlessSlashSession | undefined;

afterEach(async () => {
	if (activeSession) {
		await activeSession.cleanup();
		activeSession = undefined;
	}
});

function oauthFixture(): { mcpUrl: string; registrationEndpoint: string; authorizeUrl: string } {
	const mcpUrl = process.env.BODHI_PI_E2E_OAUTH_MCP_URL;
	if (!mcpUrl) throw new Error("BODHI_PI_E2E_OAUTH_MCP_URL not set");
	const authorizeUrl = process.env.BODHI_PI_E2E_OAUTH_AUTHORIZE_URL;
	if (!authorizeUrl) throw new Error("BODHI_PI_E2E_OAUTH_AUTHORIZE_URL not set");
	// The fixture exposes /register on the same base URL as /mcp.
	const base = new URL(authorizeUrl);
	base.pathname = "/register";
	base.search = "";
	return { mcpUrl, registrationEndpoint: base.toString(), authorizeUrl };
}

// Port pool for the per-flow ephemeral redirect server. Tests run sequentially in this file
// but get distinct ports to avoid lingering TIME_WAIT collisions.
const PORT_POOL = [37790, 37791, 37792, 37793];
const pickPort = (i: number): number => PORT_POOL[i % PORT_POOL.length]!;

test("cli e2e-ui: /mcp oauth discover surfaces fixture RFC 9728+8414 metadata", async () => {
	const session = await startHeadlessSlashSession({
		model: "gpt-4o-mini",
		provider: "openai",
		tmpDirPrefix: "bodhi-pi-e2e-ui-cli-mcp-oauth-dcr-",
	});
	activeSession = session;
	const fix = oauthFixture();

	const out = await session.sendSlash(`/mcp oauth discover ${fix.mcpUrl}`);
	expect.soft(out).toContain("authorizationServer=");
	expect.soft(out).toContain("authorize:");
	expect.soft(out).toContain("token:");
	expect.soft(out).toContain("register:");
}, 15_000);

test("cli e2e-ui: /mcp oauth register mints a fresh client via RFC 7591", async () => {
	const session = await startHeadlessSlashSession({
		model: "gpt-4o-mini",
		provider: "openai",
		tmpDirPrefix: "bodhi-pi-e2e-ui-cli-mcp-oauth-dcr-",
	});
	activeSession = session;
	const fix = oauthFixture();

	const out = await session.sendSlash(
		`/mcp oauth register ${fix.registrationEndpoint} http://localhost:7777/callback --scopes=read`,
	);
	expect.soft(out).toMatch(/clientId=dcr-/);
	expect.soft(out).toContain("clientSecret: <set");
}, 15_000);

test("cli e2e-ui: /mcp add with auth: oauth-dcr chains discovery+DCR; oauth start --auto completes; connect uses tokens", async () => {
	const session = await startHeadlessSlashSession({
		model: "gpt-4o-mini",
		provider: "openai",
		tmpDirPrefix: "bodhi-pi-e2e-ui-cli-mcp-oauth-dcr-",
	});
	activeSession = session;
	const fix = oauthFixture();
	const port = pickPort(2);

	const addPayload = JSON.stringify({
		url: fix.mcpUrl,
		auth: "oauth-dcr",
		redirectUri: `http://127.0.0.1:${port}/callback`,
		scopes: ["read"],
		label: "dcrfix",
	});
	const added = await session.sendSlash(`/mcp add ${addPayload}`);
	expect.soft(added).toMatch(/^added: /);
	const slug = added.replace(/^added: /, "").trim();

	const oauth = await session.sendSlash(`/mcp oauth start ${slug} --auto --port=${port}`);
	expect.soft(oauth).toContain("oauth: completed");

	const connected = await session.sendSlash(`/mcp connect ${slug}`);
	expect.soft(connected).toContain(`${slug}__whoami`);

	const listed = await session.sendSlash(`/mcps`);
	expect.soft(listed).toContain(slug);
	expect.soft(listed).toContain("connected");
}, 30_000);
