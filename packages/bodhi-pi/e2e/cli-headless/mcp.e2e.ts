import { type ChildProcessByStdio, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Readable as NodeReadable, Writable as NodeWritable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const TEST_APP_CLI_BIN = path.resolve(here, "..", "..", "test-apps", "cli", "dist", "cli.js");

interface HeadlessSlashSession {
	child: ChildProcessByStdio<NodeWritable, NodeReadable, null>;
	tmpDir: string;
	sendSlash: (cmd: string) => Promise<string>;
	sendChat: (prompt: string) => Promise<string>;
	cleanup: () => Promise<void>;
}

async function startHeadlessSlashSession(opts: { model: string; provider: string }): Promise<HeadlessSlashSession> {
	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bodhi-pi-e2e-ui-cli-mcp-"));
	const dbPath = path.join(tmpDir, "sessions.db");
	const homeDir = path.join(tmpDir, ".home");
	await fs.mkdir(homeDir, { recursive: true });

	const args = [
		TEST_APP_CLI_BIN,
		"--headless",
		"--cwd",
		tmpDir,
		"--db",
		dbPath,
		"--no-extensions",
		"--default-model",
		opts.model,
		"--models",
		`${opts.provider}:${opts.model}`,
	];

	const child: ChildProcessByStdio<NodeWritable, NodeReadable, null> = spawn("node", args, {
		stdio: ["pipe", "pipe", "inherit"],
		env: { ...process.env, HOME: homeDir },
	});

	let buffer = "";
	type Pending = { tag: "command-response" | "response"; resolve: (text: string) => void };
	const pending: Pending[] = [];

	child.stdout.setEncoding("utf-8");
	child.stdout.on("data", (chunk: string) => {
		buffer += chunk;
		while (true) {
			const next = pending[0];
			if (!next) return;
			const openTag = `<${next.tag}>`;
			const closeTag = `</${next.tag}>`;
			const start = buffer.indexOf(openTag);
			const end = buffer.indexOf(closeTag);
			if (start === -1 || end === -1 || end < start) break;
			const text = buffer.slice(start + openTag.length, end).trim();
			buffer = buffer.slice(end + closeTag.length);
			pending.shift();
			next.resolve(text);
		}
	});

	function sendSlash(cmd: string): Promise<string> {
		return new Promise((resolve) => {
			pending.push({ tag: "command-response", resolve });
			child.stdin.write(`${cmd}\n`);
		});
	}

	function sendChat(prompt: string): Promise<string> {
		return new Promise((resolve) => {
			pending.push({ tag: "response", resolve });
			child.stdin.write(`${prompt}\n`);
		});
	}

	const cleanup = async () => {
		try {
			child.stdin.end();
		} catch {}
		try {
			child.kill("SIGTERM");
		} catch {}
		await fs.rm(tmpDir, { recursive: true, force: true });
	};

	return { child, tmpDir, sendSlash, sendChat, cleanup };
}

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
	const session = await startHeadlessSlashSession({ model: "gpt-4o-mini", provider: "openai" });
	activeSession = session;

	const added = await session.sendSlash(`/mcp add url=${mcpEverythingUrl()}`);
	expect.soft(added).toMatch(/^added: /);
	const slug = added.replace(/^added: /, "").trim();
	expect.soft(slug.length).toBeGreaterThan(0);

	const listed = await session.sendSlash("/mcps");
	expect.soft(listed).toContain(slug);
	expect.soft(listed).toContain("disconnected");

	const connected = await session.sendSlash(`/mcp connect ${slug}`);
	expect.soft(connected).toContain(`${slug}__get-sum`);

	const tools = await session.sendSlash(`/mcp tools ${slug}`);
	expect.soft(tools).toContain(`${slug}__get-sum`);

	const disconnected = await session.sendSlash(`/mcp disconnect ${slug}`);
	expect.soft(disconnected).toContain(`disconnected ${slug}`);
	const toolsEmpty = await session.sendSlash(`/mcp tools ${slug}`);
	expect.soft(toolsEmpty).toContain("(no tools");

	const reconnected = await session.sendSlash(`/mcp reconnect ${slug}`);
	expect.soft(reconnected).toContain(`${slug}__get-sum`);

	const removed = await session.sendSlash(`/mcp remove ${slug}`);
	expect.soft(removed).toContain(`removed ${slug}`);
}, 30_000);

test("cli e2e-ui LLM prompt: agent uses get-sum(20, 22) via stdio chat and replies with 42", async () => {
	const session = await startHeadlessSlashSession({ model: "gpt-4o-mini", provider: "openai" });
	activeSession = session;

	const added = await session.sendSlash(`/mcp add url=${mcpEverythingUrl()}`);
	const slug = added.replace(/^added: /, "").trim();
	await session.sendSlash(`/mcp connect ${slug}`);

	const response = await session.sendChat(
		`Using the everything-mcp tool "${slug}__get-sum", find the sum of 20 and 22. Reply with just the number.`,
	);
	expect.soft(response).toContain("42");
}, 60_000);
