import { type ChildProcessByStdio, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import type { Readable as NodeReadable, Writable as NodeWritable } from "node:stream";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
	type Agent,
	type Client,
	ClientSideConnection,
	ndJsonStream,
	type SessionNotification,
	type Stream,
} from "@agentclientprotocol/sdk";
import { type BodhiPiEvent, createBodhiPiClient, createInMemoryKvStore, createInMemorySessionStore } from "@/index.js";
import { waitForAgentEndBalance } from "../events-assert.js";
import type { E2EHarness, E2EHarnessOptions } from "../harness.js";
import { createNodeFilesystem } from "../node-adapters/index.js";
import { fixtureBodhiPiDir } from "../seed-bodhi-pi.js";
import { createReadOnlyFilesystemProxy, seedFilesViaFilesystem } from "../test-filesystem.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const TEST_APP_CLI_BIN = path.resolve(here, "../../test-app-cli/dist/test-app-cli/src/cli.js");

export async function createCliHarness(opts: E2EHarnessOptions): Promise<E2EHarness> {
	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bodhi-pi-e2e-cli-"));
	const dbPath = path.join(tmpDir, "sessions.db");
	const homeDir = path.join(tmpDir, ".home");
	await fs.mkdir(homeDir, { recursive: true });

	const modelsArg = opts.models.map((m) => `${m.provider}:${m.id}`).join(",");

	// When the test seeds a fixture, symlink the source `.bodhi-pi/` into the
	// spawned child's cwd. Following the symlink, Node walks back to the
	// monorepo node_modules so package-mode extensions can `import` from npm.
	// Without a fixture, keep `--no-extensions` so other shared tests stay
	// isolated from each other.
	if (opts.bodhiPiFixture) {
		await fs.symlink(fixtureBodhiPiDir(opts.bodhiPiFixture), path.join(tmpDir, ".bodhi-pi"), "dir");
	}

	const args = [
		TEST_APP_CLI_BIN,
		"--rpc",
		"--cwd",
		tmpDir,
		"--db",
		dbPath,
		...(opts.bodhiPiFixture ? [] : ["--no-extensions"]),
		"--default-model",
		opts.defaultModelId,
	];
	if (modelsArg) args.push("--models", modelsArg);

	const child: ChildProcessByStdio<NodeWritable, NodeReadable, NodeReadable> = spawn("node", args, {
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, HOME: homeDir },
	});

	const input = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
	const output = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
	const stream: Stream = ndJsonStream(input, output);

	// Stderr is the event channel under --rpc: one JSON-RPC notification per
	// line (`_bodhi-pi/lifecycle/event`). Non-matching lines are forwarded so
	// genuine diagnostic output still surfaces in the test runner.
	const events: BodhiPiEvent[] = [];
	const stderrReader = readline.createInterface({ input: child.stderr });
	stderrReader.on("line", (line) => {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{")) {
			if (trimmed.length > 0) process.stderr.write(`${line}\n`);
			return;
		}
		try {
			const frame = JSON.parse(trimmed) as { method?: string; params?: unknown };
			if (frame.method === "_bodhi-pi/lifecycle/event" && frame.params && typeof frame.params === "object") {
				events.push(frame.params as BodhiPiEvent);
				return;
			}
		} catch {
			// Not a JSON-RPC frame — fall through and forward verbatim.
		}
		process.stderr.write(`${line}\n`);
	});

	const updates: SessionNotification[] = [];
	const clientConn = new ClientSideConnection(
		(_agent: Agent): Client => ({
			sessionUpdate: async (params) => {
				updates.push(params);
			},
			requestPermission: async () => ({ outcome: { outcome: "approved" } }),
		}),
		stream,
	);

	const filesystem = createNodeFilesystem({ rootCwd: tmpDir });
	const sessionStore = createInMemorySessionStore();
	const kvStore = createInMemoryKvStore();

	const cleanup = async () => {
		stderrReader.close();
		try {
			child.kill("SIGTERM");
		} catch {
			// already exited
		}
		await fs.rm(tmpDir, { recursive: true, force: true });
	};

	return {
		clientConn,
		client: createBodhiPiClient(clientConn, { cwd: tmpDir }),
		updates,
		events,
		flushEvents: () => waitForAgentEndBalance(events),
		filesystem: createReadOnlyFilesystemProxy(filesystem),
		setupFiles: (files) => seedFilesViaFilesystem(filesystem, tmpDir, files),
		sessionStore,
		kvStore,
		cwd: tmpDir,
		cleanup,
	};
}
