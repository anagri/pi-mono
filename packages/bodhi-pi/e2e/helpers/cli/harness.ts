import { type ChildProcessByStdio, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
import { provisionWorkspace } from "../http/workspace.js";
import { createNodeFilesystem } from "../node-adapters/index.js";
import { pickDefined } from "../pick-defined.js";
import { createReadOnlyFilesystemProxy, seedFilesViaFilesystem } from "../test-filesystem.js";
import { pipeLifecycleEvents } from "./lifecycle-stderr.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const TEST_APP_CLI_BIN = path.resolve(
	here,
	"..",
	"..",
	"..",
	"test-apps",
	"cli",
	"dist",
	"test-app-cli",
	"src",
	"cli.js",
);

export async function createCliHarness(opts: E2EHarnessOptions): Promise<E2EHarness> {
	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bodhi-pi-e2e-cli-"));
	const dbPath = path.join(tmpDir, "sessions.db");
	const homeDir = path.join(tmpDir, ".home");
	await fs.mkdir(homeDir, { recursive: true });
	await provisionWorkspace({ cwd: tmpDir, ...pickDefined({ fixture: opts.bodhiPiFixture }) });

	const modelsArg = opts.models.map((m) => `${m.provider}:${m.id}`).join(",");

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

	// Stderr is the event channel under --rpc — see helpers/cli/lifecycle-stderr.ts.
	const events: BodhiPiEvent[] = [];
	const stderrReader = pipeLifecycleEvents(child.stderr, events);

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
