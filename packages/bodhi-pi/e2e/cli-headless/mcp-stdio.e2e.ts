import { type ChildProcessByStdio, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Readable as NodeReadable, Writable as NodeWritable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";

// cli e2e-ui for MCP stdio — drives `/mcp add command=npx args=…` through the
// test-app-cli's `--headless` slash dispatcher. Same wire framing
// (`<command-response>…</command-response>`) as `cli-headless/mcp.e2e.ts`.

const here = path.dirname(fileURLToPath(import.meta.url));
const TEST_APP_CLI_BIN = path.resolve(here, "..", "..", "test-apps", "cli", "dist", "cli.js");

interface HeadlessSlashSession {
	child: ChildProcessByStdio<NodeWritable, NodeReadable, null>;
	tmpDir: string;
	sendSlash: (cmd: string) => Promise<string>;
	cleanup: () => Promise<void>;
}

async function startHeadlessSlashSession(opts: { model: string; provider: string }): Promise<HeadlessSlashSession> {
	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bodhi-pi-e2e-ui-cli-mcp-stdio-"));
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
	const pending: Array<(text: string) => void> = [];

	child.stdout.setEncoding("utf-8");
	child.stdout.on("data", (chunk: string) => {
		buffer += chunk;
		while (true) {
			const start = buffer.indexOf("<command-response>");
			const end = buffer.indexOf("</command-response>");
			if (start === -1 || end === -1 || end < start) break;
			const text = buffer.slice(start + "<command-response>".length, end).trim();
			buffer = buffer.slice(end + "</command-response>".length);
			const resolver = pending.shift();
			if (resolver) resolver(text);
		}
	});

	function sendSlash(cmd: string): Promise<string> {
		return new Promise((resolve) => {
			pending.push(resolve);
			child.stdin.write(`${cmd}\n`);
		});
	}

	const cleanup = async () => {
		try {
			child.stdin.end();
		} catch {
			// ignored
		}
		try {
			child.kill("SIGTERM");
		} catch {
			// already exited
		}
		await fs.rm(tmpDir, { recursive: true, force: true });
	};

	return { child, tmpDir, sendSlash, cleanup };
}

let activeSession: HeadlessSlashSession | undefined;

afterEach(async () => {
	if (activeSession) {
		await activeSession.cleanup();
		activeSession = undefined;
	}
});

test("cli e2e-ui (stdio): /mcp add command=npx … round-trip via headless stdin/stdout", async () => {
	const session = await startHeadlessSlashSession({ model: "gpt-4o-mini", provider: "openai" });
	activeSession = session;

	const added = await session.sendSlash(
		`/mcp add command=npx args=["--yes","@modelcontextprotocol/server-everything","stdio"]`,
	);
	expect.soft(added).toMatch(/^added: /);
	const slug = added.replace(/^added: /, "").trim();
	expect.soft(slug).toBe("server-everything");

	const connected = await session.sendSlash(`/mcp connect ${slug}`);
	expect.soft(connected).toContain(`${slug}__echo`);

	const tools = await session.sendSlash(`/mcp tools ${slug}`);
	expect.soft(tools).toContain(`${slug}__echo`);

	const disconnected = await session.sendSlash(`/mcp disconnect ${slug}`);
	expect.soft(disconnected).toContain(`disconnected ${slug}`);

	const reconnected = await session.sendSlash(`/mcp reconnect ${slug}`);
	expect.soft(reconnected).toContain(`${slug}__echo`);

	const removed = await session.sendSlash(`/mcp remove ${slug}`);
	expect.soft(removed).toContain(`removed ${slug}`);
}, 60_000); // npx -y cold start can take ~10s
