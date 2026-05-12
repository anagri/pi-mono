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
	type BodhiPiAcpConnection,
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
const TEST_APP_CLI_BIN = path.resolve(here, "../test-app-cli/dist/test-app-cli/src/cli.js");

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
	clientConn: BodhiPiAcpConnection;
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
	if (runtime === "http") return createHttpHarness(opts);
	throw new Error(`createE2EHarness: runtime '${runtime}' not yet supported`);
}

async function createInMemoryHarness(opts: E2EHarnessOptions): Promise<E2EHarness> {
	const filesystem = opts.filesystem ?? createInMemoryFilesystem();
	const sessionStore = opts.sessionStore ?? createInMemorySessionStore();
	const kvStore = opts.kvStore ?? createInMemoryKvStore();
	// Default scriptExecutor reads from the harness's filesystem so run_script
	// tests work without explicit wiring. The cli/http runtimes use the real
	// Node executor via their respective hosts.
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
	// Non-root default so tests can compose paths as `${h.cwd}/file.txt` without
	// hitting `//file.txt`.
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
	const { createNodeFilesystem } = await import("@e2e/helpers/node-adapters/index.js");

	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bodhi-pi-e2e-cli-"));
	const dbPath = path.join(tmpDir, "sessions.db");
	const homeDir = path.join(tmpDir, ".home");
	await fs.mkdir(homeDir, { recursive: true });
	const kvDir = path.join(homeDir, ".bodhi-pi-cli", "kv");
	await fs.mkdir(kvDir, { recursive: true });

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
		env: { ...process.env, HOME: homeDir },
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

	const filesystem = createNodeFilesystem({ rootCwd: tmpDir });
	const sessionStore = createInMemorySessionStore();
	const kvStore = createInMemoryKvStore();
	void kvDir;
	void dbPath;

	const cleanup = async () => {
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
		filesystem,
		sessionStore,
		kvStore,
		cwd: tmpDir,
		cleanup,
	};
}

async function createHttpHarness(opts: E2EHarnessOptions): Promise<E2EHarness> {
	const { createNodeFilesystem } = await import("@e2e/helpers/node-adapters/index.js");
	const { HttpAcpConnection } = await import("./http-connection.js");
	const { mintTestToken } = await import("./auth.js");
	// In-process buildServer is the cleanest way to wire models + getApiKey
	// upfront. Spawning bodhi-pi-http would require it to accept --models /
	// --default-model / env-based API keys — a small follow-up. For now we
	// import the factory from the sibling package via a relative dist path
	// (workspace symlink resolution), avoiding a package.json devDep on it.
	const { buildServer } = (await import(
		"@bodhiapp/bodhi-pi-http/dist/server/server.js"
	)) as typeof import("@bodhiapp/bodhi-pi-http/dist/server/server.js");

	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bodhi-pi-e2e-http-"));
	const dataDir = path.join(tmpDir, ".data");
	await fs.mkdir(dataDir, { recursive: true });

	const server = await buildServer({
		port: 0,
		dataDir,
		models: opts.models,
		defaultModelId: opts.defaultModelId,
		...(opts.getApiKey ? { getApiKey: opts.getApiKey } : {}),
		workspaceOverride: tmpDir,
		staticDir: null,
	});

	const port = server.port();
	const baseUrl = `http://localhost:${port}`;
	const token = mintTestToken();
	const updates: SessionNotification[] = [];
	const clientConn = new HttpAcpConnection({
		baseUrl,
		token,
		onUpdate: (n) => updates.push(n),
	});

	const filesystem = createNodeFilesystem({ rootCwd: tmpDir });
	const sessionStore = createInMemorySessionStore();
	const kvStore = createInMemoryKvStore();

	const cleanup = async () => {
		await server.close();
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
