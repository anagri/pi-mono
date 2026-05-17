import { afterEach, expect, test } from "vitest";
import { type HeadlessSlashSession, startHeadlessSlashSession } from "./headless-session.js";

let activeSession: HeadlessSlashSession | undefined;

afterEach(async () => {
	if (activeSession) {
		await activeSession.cleanup();
		activeSession = undefined;
	}
});

function mcpEverythingUrl(): string {
	const url = process.env.BODHI_PI_E2E_MCP_EVERYTHING_HTTP_URL;
	if (!url) throw new Error("BODHI_PI_E2E_MCP_EVERYTHING_HTTP_URL not set (global-setup must spawn mcp-everything)");
	return url;
}

test("cli e2e-ui: /mcp* slash commands round-trip via headless stdin/stdout", async () => {
	const session = await startHeadlessSlashSession({
		model: "gpt-4o-mini",
		provider: "openai",
		tmpDirPrefix: "bodhi-pi-e2e-ui-cli-mcp-",
	});
	activeSession = session;

	const added = await session.sendSlash(`/mcp add {"url":"${mcpEverythingUrl()}","auth":"public"}`);
	expect.soft(added).toMatch(/^added: /);
	const slug = added.replace(/^added: /, "").trim();
	expect.soft(slug.length).toBeGreaterThan(0);

	const listed = await session.sendSlash("/mcps");
	expect.soft(listed).toContain(slug);
	expect.soft(listed).toContain("disconnected");

	const connected = await session.sendSlash(`/mcp connect ${slug}`);
	expect.soft(connected).toContain(`${slug}__get-sum`);

	// connect is global-only now; inclusion is required to see tools in this session.
	const toolsBeforeInclude = await session.sendSlash(`/mcp tools ${slug}`);
	expect.soft(toolsBeforeInclude).toContain("(no tools");

	const included = await session.sendSlash(`/mcp include ${slug}`);
	expect.soft(included).toContain(`${slug}__get-sum`);

	const tools = await session.sendSlash(`/mcp tools ${slug}`);
	expect.soft(tools).toContain(`${slug}__get-sum`);

	const disconnected = await session.sendSlash(`/mcp disconnect ${slug}`);
	expect.soft(disconnected).toContain(`disconnected ${slug}`);
	const toolsEmpty = await session.sendSlash(`/mcp tools ${slug}`);
	expect.soft(toolsEmpty).toContain("(no tools");

	const reconnected = await session.sendSlash(`/mcp reconnect ${slug}`);
	expect.soft(reconnected).toContain(`${slug}__get-sum`);
	// inclusion was untouched across disconnect/reconnect; tools come back automatically.
	const toolsAfterReconnect = await session.sendSlash(`/mcp tools ${slug}`);
	expect.soft(toolsAfterReconnect).toContain(`${slug}__get-sum`);

	const removed = await session.sendSlash(`/mcp remove ${slug}`);
	expect.soft(removed).toContain(`removed ${slug}`);
}, 30_000);

test("cli e2e-ui LLM prompt: agent uses get-sum(20, 22) via stdio chat and replies with 42", async () => {
	const session = await startHeadlessSlashSession({
		model: "gpt-4o-mini",
		provider: "openai",
		tmpDirPrefix: "bodhi-pi-e2e-ui-cli-mcp-",
	});
	activeSession = session;

	const added = await session.sendSlash(`/mcp add {"url":"${mcpEverythingUrl()}","auth":"public"}`);
	const slug = added.replace(/^added: /, "").trim();
	await session.sendSlash(`/mcp connect ${slug}`);
	await session.sendSlash(`/mcp include ${slug}`);

	const response = await session.sendChat(
		`Using the everything-mcp tool "${slug}__get-sum", find the sum of 20 and 22. Reply with just the number.`,
	);
	expect.soft(response).toMatch(/(^|[^0-9])42([^0-9]|$)/);
	expect.soft(response).not.toMatch(/4200|4_200|420\b/);
}, 60_000);
