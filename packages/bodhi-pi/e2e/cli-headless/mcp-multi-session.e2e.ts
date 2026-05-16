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
	if (!url) throw new Error("BODHI_PI_E2E_MCP_EVERYTHING_HTTP_URL not set");
	return url;
}

async function newCliSession(): Promise<HeadlessSlashSession> {
	return startHeadlessSlashSession({
		model: "gpt-4o-mini",
		provider: "openai",
		tmpDirPrefix: "bodhi-pi-e2e-ui-cli-mcp-multi-",
	});
}

async function listSessionIds(session: HeadlessSlashSession): Promise<string[]> {
	const out = await session.sendSlash(`/session list`);
	return out
		.split("\n")
		.map((l) => l.replace(/^[\s*]+/, "").trim())
		.filter(Boolean);
}

test("cli multi-session: /mcp disconnect from session B drops tools in session A", async () => {
	const session = await newCliSession();
	activeSession = session;

	const added = await session.sendSlash(`/mcp add url=${mcpEverythingUrl()}`);
	const slug = added.replace(/^added: /, "").trim();
	await session.sendSlash(`/mcp connect ${slug}`);

	// session A: included by default? no — bodhi-pi sends mcpServers: [] on every newSession, which excludes all.
	await session.sendSlash(`/mcp include ${slug}`);
	const aTools = await session.sendSlash(`/mcp tools ${slug}`);
	expect.soft(aTools).toContain(`${slug}__get-sum`);

	// Create session B; switch is automatic on `/session new`.
	const created = await session.sendSlash(`/session new`);
	const sidB = created
		.replace(/^session\s+/, "")
		.replace(/\s+\(active\)$/, "")
		.trim();
	expect.soft(sidB.length).toBeGreaterThan(0);

	await session.sendSlash(`/mcp include ${slug}`);
	const bTools = await session.sendSlash(`/mcp tools ${slug}`);
	expect.soft(bTools).toContain(`${slug}__get-sum`);

	// Global disconnect from session B's context must drop tools for session A too.
	await session.sendSlash(`/mcp disconnect ${slug}`);
	const bAfter = await session.sendSlash(`/mcp tools ${slug}`);
	expect.soft(bAfter).toContain("(no tools");

	// Switch back to A — its inclusion set still has the slug but the global connection is gone.
	const sessions = await listSessionIds(session);
	const firstSession = sessions[0];
	if (firstSession) await session.sendSlash(`/session switch ${firstSession}`);
	const aAfter = await session.sendSlash(`/mcp tools ${slug}`);
	expect.soft(aAfter).toContain("(no tools");
}, 30_000);

test("cli multi-session: /mcp exclude in session B leaves session A's tools intact", async () => {
	const session = await newCliSession();
	activeSession = session;

	const added = await session.sendSlash(`/mcp add url=${mcpEverythingUrl()}`);
	const slug = added.replace(/^added: /, "").trim();
	await session.sendSlash(`/mcp connect ${slug}`);
	await session.sendSlash(`/mcp include ${slug}`); // session A includes

	const aBefore = await session.sendSlash(`/mcp tools ${slug}`);
	expect.soft(aBefore).toContain(`${slug}__get-sum`);

	// session B — also include, then exclude. session A must be untouched.
	await session.sendSlash(`/session new`);
	await session.sendSlash(`/mcp include ${slug}`);
	await session.sendSlash(`/mcp exclude ${slug}`);
	const bAfter = await session.sendSlash(`/mcp tools ${slug}`);
	expect.soft(bAfter).toContain("(no tools");

	// switch back to session A — its inclusion set was untouched by B's exclude.
	const sessions = await listSessionIds(session);
	const firstSession = sessions[0];
	if (firstSession) await session.sendSlash(`/session switch ${firstSession}`);
	const aAfter = await session.sendSlash(`/mcp tools ${slug}`);
	expect.soft(aAfter).toContain(`${slug}__get-sum`);
}, 30_000);
