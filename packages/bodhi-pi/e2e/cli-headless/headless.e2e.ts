import { type ChildProcessByStdio, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Readable as NodeReadable, Writable as NodeWritable } from "node:stream";
import { fileURLToPath } from "node:url";
import { requireEnv } from "@test/helpers/env.js";
import { afterEach, expect, test } from "vitest";

// Spawns test-app-cli in --headless mode, feeds tagged user prompts on stdin,
// reads `<response>…</response>` blocks from stdout. Stays runtime-specific:
// the in-memory project doesn't include this directory (see vitest.e2e.config.ts).

const here = path.dirname(fileURLToPath(import.meta.url));
const TEST_APP_CLI_BIN = path.resolve(here, "../test-app-cli/dist/cli.js");

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

test("headless mode: user prompt → tagged <response> block contains agent text", async () => {
	requireEnv("OPENAI_API_KEY");
	const session = await startHeadlessSession({ model: "gpt-4o-mini", provider: "openai" });
	activeSession = session;

	const response = await session.send("Answer in one word: what day comes after Monday?");
	expect(response.toLowerCase()).toContain("tuesday");
}, 60_000);

test("headless mode: multi-turn context survives across stdin lines in the same session", async () => {
	requireEnv("OPENAI_API_KEY");
	const session = await startHeadlessSession({ model: "gpt-4o-mini", provider: "openai" });
	activeSession = session;

	const ack = await session.send("My favourite colour is teal. Reply with the single word 'noted' and nothing else.");
	expect(ack.toLowerCase()).toContain("noted");

	const recall = await session.send("What is my favourite colour? Reply with just the colour word.");
	expect(recall.toLowerCase()).toContain("teal");
}, 60_000);

test("headless mode: tool-call writes to real disk via the spawned cli's Node FS", async () => {
	requireEnv("OPENAI_API_KEY");
	const session = await startHeadlessSession({ model: "gpt-4o-mini", provider: "openai" });
	activeSession = session;

	const outPath = path.join(session.tmpDir, "headless-out.txt");
	await session.send(`Use the write tool to create the file ${outPath} with exactly the text: hello headless`);

	// Real Node FS write — confirmed by reading directly on disk, not via the agent.
	const stored = await fs.readFile(outPath, "utf-8");
	expect(stored.toLowerCase()).toContain("hello headless");
}, 60_000);
