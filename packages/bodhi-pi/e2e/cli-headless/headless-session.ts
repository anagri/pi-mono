import { type ChildProcessByStdio, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Readable as NodeReadable, Writable as NodeWritable } from "node:stream";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const TEST_APP_CLI_BIN = path.resolve(here, "..", "..", "test-apps", "cli", "dist", "host", "cli.js");

export interface HeadlessSlashSession {
	child: ChildProcessByStdio<NodeWritable, NodeReadable, null>;
	tmpDir: string;
	sendSlash: (cmd: string) => Promise<string>;
	sendChat: (prompt: string) => Promise<string>;
	cleanup: () => Promise<void>;
}

export interface StartHeadlessSlashSessionOpts {
	model: string;
	provider: string;
	/** tmpdir prefix; defaults to `bodhi-pi-e2e-ui-cli-`. */
	tmpDirPrefix?: string;
}

/**
 * Spawn `test-app-cli --headless` against a fresh tmpdir + sqlite db. Returns a
 * promise-based helper that writes lines to stdin and parses `<command-response>`
 * / `<response>` blocks emitted by the headless REPL.
 */
export async function startHeadlessSlashSession(opts: StartHeadlessSlashSessionOpts): Promise<HeadlessSlashSession> {
	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), opts.tmpDirPrefix ?? "bodhi-pi-e2e-ui-cli-"));
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
