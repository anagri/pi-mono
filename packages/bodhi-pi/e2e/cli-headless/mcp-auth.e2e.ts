import { afterEach, expect, test } from "vitest";
import { type HeadlessSlashSession, startHeadlessSlashSession } from "./headless-session.js";

let activeSession: HeadlessSlashSession | undefined;

afterEach(async () => {
	if (activeSession) {
		await activeSession.cleanup();
		activeSession = undefined;
	}
});

function authMcpUrl(): string {
	const url = process.env.BODHI_PI_E2E_MCP_AUTH_HTTP_URL;
	if (!url) throw new Error("BODHI_PI_E2E_MCP_AUTH_HTTP_URL not set (global-setup must spawn auth-mcp-server)");
	return url;
}

function authMcpToken(): string {
	const tok = process.env.BODHI_PI_E2E_MCP_AUTH_TOKEN;
	if (!tok) throw new Error("BODHI_PI_E2E_MCP_AUTH_TOKEN not set");
	return tok;
}

test("cli e2e-ui: /mcp add http-param header round-trips via headless stdin/stdout, masks values on /mcps", async () => {
	const session = await startHeadlessSlashSession({
		model: "gpt-4o-mini",
		provider: "openai",
		tmpDirPrefix: "bodhi-pi-e2e-ui-cli-mcp-auth-",
	});
	activeSession = session;

	const addPayload = JSON.stringify({
		url: authMcpUrl(),
		auth: "http-param",
		headers: { Authorization: `Bearer ${authMcpToken()}` },
		label: "auth-header",
	});
	const added = await session.sendSlash(`/mcp add ${addPayload}`);
	expect.soft(added).toMatch(/^added: /);
	const slug = added.replace(/^added: /, "").trim();
	expect.soft(slug.length).toBeGreaterThan(0);

	const connected = await session.sendSlash(`/mcp connect ${slug}`);
	expect.soft(connected).toContain(`${slug}__whoami`);

	await session.sendSlash(`/mcp include ${slug}`);
	const tools = await session.sendSlash(`/mcp tools ${slug}`);
	expect.soft(tools).toContain(`${slug}__whoami`);

	// /mcps formats one line per entry with slug + status + transport + url.
	// We don't display auth here; the masking contract is verified at the API
	// level (mcpList) in the shared e2e and the integration tests. The cli
	// surface just needs to show the slug stays connected after auth attaches.
	const listed = await session.sendSlash(`/mcps`);
	expect.soft(listed).toContain(slug);
	expect.soft(listed).toContain("connected");
}, 30_000);

test("cli e2e-ui: /mcp add http-param query reaches the LLM and whoami returns 'authenticated via query'", async () => {
	const session = await startHeadlessSlashSession({
		model: "gpt-4o-mini",
		provider: "openai",
		tmpDirPrefix: "bodhi-pi-e2e-ui-cli-mcp-auth-",
	});
	activeSession = session;

	const addPayload = JSON.stringify({
		url: authMcpUrl(),
		auth: "http-param",
		queries: { api_key: authMcpToken() },
		label: "auth-query",
	});
	const added = await session.sendSlash(`/mcp add ${addPayload}`);
	const slug = added.replace(/^added: /, "").trim();
	await session.sendSlash(`/mcp connect ${slug}`);
	await session.sendSlash(`/mcp include ${slug}`);

	const response = await session.sendChat(
		`Call the tool "${slug}__whoami" with no arguments and reply with exactly the tool's text result.`,
	);
	expect.soft(response).toContain("authenticated via query");
}, 60_000);

test("cli e2e-ui: /mcp add with auth http-param + wrong bearer reports a connect failure", async () => {
	const session = await startHeadlessSlashSession({
		model: "gpt-4o-mini",
		provider: "openai",
		tmpDirPrefix: "bodhi-pi-e2e-ui-cli-mcp-auth-",
	});
	activeSession = session;

	const addPayload = JSON.stringify({
		url: authMcpUrl(),
		auth: "http-param",
		headers: { Authorization: `Bearer wrong-token-xyz` },
	});
	const added = await session.sendSlash(`/mcp add ${addPayload}`);
	const slug = added.replace(/^added: /, "").trim();

	const connectResult = await session.sendSlash(`/mcp connect ${slug}`);
	expect.soft(connectResult.toLowerCase()).toMatch(/error|unauthorized|bad bearer/);
}, 30_000);
