import { type ChildProcessByStdio, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Readable as NodeReadable, Writable as NodeWritable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";

// Spawns test-app-cli in --headless mode, feeds tagged user prompts on stdin,
// reads `<response>…</response>` blocks from stdout. Stays runtime-specific:
// the in-memory project doesn't include this directory (see vitest.e2e.config.ts).

const here = path.dirname(fileURLToPath(import.meta.url));
const TEST_APP_CLI_BIN = path.resolve(here, "..", "..", "test-apps", "cli", "dist", "test-app-cli", "src", "cli.js");

interface HeadlessSession {
	child: ChildProcessByStdio<NodeWritable, NodeReadable, null>;
	tmpDir: string;
	send: (prompt: string) => Promise<string>;
	cleanup: () => Promise<void>;
}

async function startHeadlessSession(opts: { model: string; provider: string }): Promise<HeadlessSession> {
	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bodhi-pi-e2e-cli-headless-"));
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

	// Stream stdout, buffer until a complete <response>…</response> block.
	let buffer = "";
	const pending: Array<(text: string) => void> = [];

	child.stdout.setEncoding("utf-8");
	child.stdout.on("data", (chunk: string) => {
		buffer += chunk;
		while (true) {
			const start = buffer.indexOf("<response>");
			const end = buffer.indexOf("</response>");
			if (start === -1 || end === -1 || end < start) break;
			const text = buffer.slice(start + "<response>".length, end).trim();
			buffer = buffer.slice(end + "</response>".length);
			const resolver = pending.shift();
			if (resolver) resolver(text);
		}
	});

	function send(prompt: string): Promise<string> {
		return new Promise((resolve) => {
			pending.push(resolve);
			child.stdin.write(`${prompt}\n`);
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

	return { child, tmpDir, send, cleanup };
}

let activeSession: HeadlessSession | undefined;

afterEach(async () => {
	if (activeSession) {
		await activeSession.cleanup();
		activeSession = undefined;
	}
});

// 60s override: three chained LLM turns + a tool-call in a single spawned session
// exceeds the 30s default. The flow shares one spawned cli + one session across
// all three steps to save the per-test spawn cost.
test("headless mode: prompt round-trip, multi-turn recall, tool-call to real disk", async () => {
	const session = await startHeadlessSession({ model: "gpt-4o-mini", provider: "openai" });
	activeSession = session;

	// Step 1: single prompt round-trip via tagged framing.
	const tuesday = await session.send("Answer in one word: what day comes after Monday?");
	expect.soft(tuesday.toLowerCase()).toContain("tuesday");

	// Step 2: multi-turn context survives across stdin lines.
	const ack = await session.send("My favourite colour is teal. Reply with the single word 'noted' and nothing else.");
	expect.soft(ack.toLowerCase()).toContain("noted");
	const recall = await session.send("What is my favourite colour? Reply with just the colour word.");
	expect.soft(recall.toLowerCase()).toContain("teal");

	// Step 3: tool-call writes to real disk via the spawned cli's Node FS.
	const outPath = path.join(session.tmpDir, "headless-out.txt");
	await session.send(`Use the write tool to create the file ${outPath} with exactly the text: hello headless`);
	const stored = await fs.readFile(outPath, "utf-8");
	expect.soft(stored.toLowerCase()).toContain("hello headless");
}, 60_000);
