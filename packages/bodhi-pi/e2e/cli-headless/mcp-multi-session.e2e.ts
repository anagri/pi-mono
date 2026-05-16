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
	cleanup: () => Promise<void>;
}

async function startHeadlessSlashSession(opts: { model: string; provider: string }): Promise<HeadlessSlashSession> {
	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bodhi-pi-e2e-ui-cli-mcp-multi-"));
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
		} catch {}
		try {
			child.kill("SIGTERM");
		} catch {}
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

function mcpEverythingUrl(): string {
	const url = process.env.BODHI_PI_E2E_MCP_EVERYTHING_HTTP_URL;
	if (!url) throw new Error("BODHI_PI_E2E_MCP_EVERYTHING_HTTP_URL not set");
	return url;
}

// One cli process, two sessions: confirm that a global disconnect from one
// session removes the tools from the other session immediately.
test("cli multi-session: /mcp disconnect from session B drops tools in session A", async () => {
	const session = await startHeadlessSlashSession({ model: "gpt-4o-mini", provider: "openai" });
	activeSession = session;

	const added = await session.sendSlash(`/mcp add url=${mcpEverythingUrl()}`);
	const slug = added.replace(/^added: /, "").trim();
	await session.sendSlash(`/mcp connect ${slug}`);

	// session A: created at startup. Include the MCP and confirm tools are visible.
	await session.sendSlash(`/mcp include ${slug}`);
	const aTools = await session.sendSlash(`/mcp tools ${slug}`);
	expect.soft(aTools).toContain(`${slug}__get-sum`);

	// Create session B and switch into it. Session B's inclusion set is empty by
	// default (client wrapper sends mcpServers: []), so an explicit /mcp include
	// is required to surface the globally-connected MCP.
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

	// Switch back to A — its inclusion set still has the slug, but the connection
	// is gone, so tools must be empty.
	const sidA =
		(await session.sendSlash(`/session list`))
			.split("\n")
			.find((l) => l.trim().startsWith("*"))
			?.slice(2)
			.trim() ?? "";
	void sidA;
	// /session list ordering: first session at top, second at bottom; new ones get
	// active by default. Switching to the first listed (oldest = A).
	const allLines = (await session.sendSlash(`/session list`))
		.split("\n")
		.map((l) => l.replace(/^[\s*]+/, "").trim())
		.filter(Boolean);
	const firstSession = allLines[0];
	if (firstSession) {
		await session.sendSlash(`/session switch ${firstSession}`);
	}
	const aAfter = await session.sendSlash(`/mcp tools ${slug}`);
	expect.soft(aAfter).toContain("(no tools");
}, 30_000);
