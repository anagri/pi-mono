import { afterEach, expect, test } from "vitest";
import { type HeadlessSlashSession, startHeadlessSlashSession } from "./headless-session.js";

let activeSession: HeadlessSlashSession | undefined;

afterEach(async () => {
	if (activeSession) {
		await activeSession.cleanup();
		activeSession = undefined;
	}
});

test("cli e2e-ui (stdio): /mcp add {command:npx,…} round-trip via headless stdin/stdout", async () => {
	const session = await startHeadlessSlashSession({
		model: "gpt-4o-mini",
		provider: "openai",
		tmpDirPrefix: "bodhi-pi-e2e-ui-cli-mcp-stdio-",
	});
	activeSession = session;

	const added = await session.sendSlash(
		`/mcp add {"command":"npx","args":["--yes","@modelcontextprotocol/server-everything","stdio"]}`,
	);
	expect.soft(added).toMatch(/^added: /);
	const slug = added.replace(/^added: /, "").trim();
	expect.soft(slug).toBe("server-everything");

	const connected = await session.sendSlash(`/mcp connect ${slug}`);
	expect.soft(connected).toContain(`${slug}__echo`);

	await session.sendSlash(`/mcp include ${slug}`);
	const tools = await session.sendSlash(`/mcp tools ${slug}`);
	expect.soft(tools).toContain(`${slug}__echo`);

	const disconnected = await session.sendSlash(`/mcp disconnect ${slug}`);
	expect.soft(disconnected).toContain(`disconnected ${slug}`);

	const reconnected = await session.sendSlash(`/mcp reconnect ${slug}`);
	expect.soft(reconnected).toContain(`${slug}__echo`);

	const removed = await session.sendSlash(`/mcp remove ${slug}`);
	expect.soft(removed).toContain(`removed ${slug}`);
}, 60_000); // npx -y cold start can take ~10s
