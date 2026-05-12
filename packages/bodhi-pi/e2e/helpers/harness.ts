import { type ChildProcessByStdio, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Readable as NodeReadable, Writable as NodeWritable } from "node:stream";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
	type Agent,
	type AnyMessage,
	type Client,
	ClientSideConnection,
	ndJsonStream,
	type SessionNotification,
	type Stream,
} from "@agentclientprotocol/sdk";
import type { Api, Model } from "@earendil-works/pi-ai";
import { createTestHarness } from "@test/helpers/harness.js";
import { createTestScriptExecutor } from "@test/helpers/script-executor.js";
import {
	type BodhiPiClient,
	type BodhiPiEventHandlers,
	type CompactionSettings,
	createBodhiPiClient,
	createInMemoryFilesystem,
	createInMemoryKvStore,
	createInMemorySessionStore,
	type Filesystem,
	type KvStore,
	type RegisteredExtension,
	type ScriptExecutor,
	type SessionStore,
} from "@/index.js";
import { getRuntime } from "./runtime.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const TEST_APP_CLI_BIN = path.resolve(here, "../test-app-cli/dist/cli.js");

export interface E2EHarnessOptions {
	models: Model<Api>[];
	defaultModelId: string;
	getApiKey?: (provider: string) => string | undefined;
	systemPrompt?: string;
	appendSystemPrompt?: string;
	homeDir?: string;
	// In-memory only — under cli runtime these are ignored; tests using them
	// must guard with `it.runIf(isRuntime('in-memory'))`.
	filesystem?: Filesystem;
	sessionStore?: SessionStore;
	kvStore?: KvStore;
	scriptExecutor?: ScriptExecutor;
	eventHandlers?: BodhiPiEventHandlers;
	extensionFactories?: RegisteredExtension[];
	compaction?: Partial<CompactionSettings>;
}

export interface E2EHarness {
	clientConn: ClientSideConnection;
	client: BodhiPiClient;
	updates: SessionNotification[];
	filesystem: Filesystem;
	sessionStore: SessionStore;
	kvStore: KvStore;
	/** Working directory the agent is rooted at. Tests pass this to `newSession({cwd})`. */
	cwd: string;
	cleanup: () => Promise<void>;
}

export async function createE2EHarness(opts: E2EHarnessOptions): Promise<E2EHarness> {
	const runtime = getRuntime();
	if (runtime === "in-memory") return createInMemoryHarness(opts);
	if (runtime === "cli") return createCliHarness(opts);
	throw new Error(`createE2EHarness: runtime '${runtime}' not yet supported`);
}

async function createInMemoryHarness(opts: E2EHarnessOptions): Promise<E2EHarness> {
	const filesystem = opts.filesystem ?? createInMemoryFilesystem();
	const sessionStore = opts.sessionStore ?? createInMemorySessionStore();
	const kvStore = opts.kvStore ?? createInMemoryKvStore();
	// Auto-wire the test script executor against the harness's filesystem so
	// run_script tests don't need to know about either. The cli runtime ships
	// Node's real scriptExecutor automatically (createNodeScriptExecutor in agent.ts).
	const scriptExecutor = opts.scriptExecutor ?? createTestScriptExecutor(filesystem);
	const inner = createTestHarness({
		models: opts.models,
		defaultModelId: opts.defaultModelId,
		filesystem,
		sessionStore,
		kvStore,
		scriptExecutor,
		...(opts.getApiKey ? { getApiKey: opts.getApiKey } : {}),
		...(opts.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
		...(opts.appendSystemPrompt !== undefined ? { appendSystemPrompt: opts.appendSystemPrompt } : {}),
		...(opts.eventHandlers ? { eventHandlers: opts.eventHandlers } : {}),
		...(opts.extensionFactories ? { extensionFactories: opts.extensionFactories } : {}),
		...(opts.compaction ? { compaction: opts.compaction } : {}),
		...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
	});
	// Default in-memory cwd to "/proj" rather than "/" so tests can compose
	// paths like `${h.cwd}/file.txt` without ending up with "//file.txt".
	// Tests that don't care about cwd still work fine. The cli runtime uses a
	// tmpdir which is similarly non-root.
	const cwd = opts.homeDir ?? "/proj";
	await filesystem.mkdir(cwd, { recursive: true });
	return {
		clientConn: inner.clientConn,
		client: createBodhiPiClient(inner.clientConn, { cwd }),
		updates: inner.updates,
		filesystem: inner.filesystem,
		sessionStore: inner.sessionStore,
		kvStore: inner.kvStore,
		cwd,
		cleanup: async () => {},
	};
}

async function createCliHarness(opts: E2EHarnessOptions): Promise<E2EHarness> {
	const { createNodeFilesystem, createNodeKvStore, createSqliteSessionStore } = await import(
		"@bodhiapp/bodhi-pi-node"
	);

	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bodhi-pi-e2e-cli-"));
	const dbPath = path.join(tmpDir, "sessions.db");
	const homeDir = path.join(tmpDir, ".home");
	await fs.mkdir(homeDir, { recursive: true });
	const kvDir = path.join(homeDir, ".bodhi-pi-cli", "kv");
	await fs.mkdir(kvDir, { recursive: true });

	// Build --models / --default-model args from opts.
	const modelsArg = opts.models.map((m) => `${m.provider}:${m.id}`).join(",");

	const args = [
		TEST_APP_CLI_BIN,
		"--rpc",
		"--cwd",
		tmpDir,
		"--db",
		dbPath,
		"--no-extensions",
		"--default-model",
		opts.defaultModelId,
	];
	if (modelsArg) args.push("--models", modelsArg);

	const child: ChildProcessByStdio<NodeWritable, NodeReadable, null> = spawn("node", args, {
		stdio: ["pipe", "pipe", "inherit"],
		env: {
			...process.env,
			HOME: homeDir,
			// Make sure pi-ai picks up the env-resolved API keys via test-app-cli's
			// PROVIDER_ENV map. We inherit OPENAI_API_KEY etc. from the test process.
		},
	});

	const input = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
	const output = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
	const stream: Stream = ndJsonStream(input, output);

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

	// Real-FS / real-SQLite handles for the test side. Both ends share the same
	// tmpDir + dbPath, so writes through `harness.filesystem` are visible to the
	// child's agent, and reads via `harness.sessionStore` reflect what the child
	// persisted.
	const filesystem = createNodeFilesystem({ rootCwd: tmpDir });
	const sessionStore = createSqliteSessionStore({ dbPath });
	const kvStore = createNodeKvStore({ dir: kvDir });

	const cleanup = async () => {
		try {
			child.kill("SIGTERM");
		} catch {
			// already exited
		}
		// Drop SQLite handles before removing files (better-sqlite3 has its own
		// close lifecycle; if it leaks we still rm-rf the dir).
		await fs.rm(tmpDir, { recursive: true, force: true });
	};

	return {
		clientConn,
		client: createBodhiPiClient(clientConn, { cwd: tmpDir }),
		updates,
		filesystem,
		sessionStore,
		kvStore,
		cwd: tmpDir,
		cleanup,
	};
}

export type { AnyMessage };
