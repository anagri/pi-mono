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
	type AnyMessage,
	type Client,
	ClientSideConnection,
	ndJsonStream,
	type SessionNotification,
	type Stream,
} from "@agentclientprotocol/sdk";
import type { Api, Model } from "@earendil-works/pi-ai";
import { recorder } from "@test/helpers/event-recorder.js";
import { createTestHarness } from "@test/helpers/harness.js";
import { createTestScriptExecutor } from "@test/helpers/script-executor.js";
import {
	type BodhiPiAcpConnection,
	type BodhiPiClient,
	type BodhiPiEvent,
	type CompactionSettings,
	createBodhiPiClient,
	createInMemoryFilesystem,
	createInMemoryKvStore,
	createInMemorySessionStore,
	type Filesystem,
	type KvStore,
	type ScriptExecutor,
	type SessionStore,
} from "@/index.js";
import { waitForAgentEndBalance } from "./events-assert.js";
import { getRuntime } from "./runtime.js";
import { fixtureBodhiPiDir, loadFixtureFactoriesFromSource } from "./seed-bodhi-pi.js";

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
	/**
	 * Name of a folder under `packages/bodhi-pi/e2e/data/<name>/.bodhi-pi/`
	 * whose contents seed the agent's project-rooted config (extensions,
	 * commands, skills, settings). Per-runtime dispatch lives in the harness
	 * branches: in-memory loads via the rich loader (jiti) from the source
	 * path; cli/http symlink the source folder into the spawned process's cwd
	 * and let the agent's existing loader pick it up.
	 */
	bodhiPiFixture?: string;
	compaction?: Partial<CompactionSettings>;
}

export interface E2EHarness {
	clientConn: BodhiPiAcpConnection;
	client: BodhiPiClient;
	updates: SessionNotification[];
	/**
	 * Lifecycle events captured during the test, populated by the runtime's
	 * event channel: direct push (in-memory), SSE `_bodhi-pi/lifecycle/event`
	 * frames (http), or stderr ndjson lines (cli). Read after `flushEvents()`.
	 */
	events: BodhiPiEvent[];
	/**
	 * Sync barrier between `prompt()` and assertions. Required for cli (stderr
	 * and stdout are independent pipes); no-op fast path for in-memory/http.
	 * Resolves when every observed `agent_start` has a matching `agent_end`
	 * and no new event has arrived for a short idle window.
	 */
	flushEvents: () => Promise<void>;
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
	if (runtime === "ws") return createWsHarness(opts);
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
	const { log: events, handlers } = recorder();
	const extensionFactories = opts.bodhiPiFixture ? await loadFixtureFactoriesFromSource(opts.bodhiPiFixture) : [];
	const inner = createTestHarness({
		models: opts.models,
		defaultModelId: opts.defaultModelId,
		filesystem,
		sessionStore,
		kvStore,
		scriptExecutor,
		eventHandlers: handlers,
		...(opts.getApiKey ? { getApiKey: opts.getApiKey } : {}),
		...(opts.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
		...(opts.appendSystemPrompt !== undefined ? { appendSystemPrompt: opts.appendSystemPrompt } : {}),
		...(extensionFactories.length > 0 ? { extensionFactories } : {}),
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
		events,
		flushEvents: () => waitForAgentEndBalance(events),
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
	void kvDir;
	void dbPath;

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

	const baseUrl = process.env.BODHI_PI_E2E_HTTP_BASE_URL;
	const dataDir = process.env.BODHI_PI_E2E_HTTP_DATA_DIR;
	if (!baseUrl || !dataDir) {
		throw new Error(
			"http harness: BODHI_PI_E2E_HTTP_BASE_URL / BODHI_PI_E2E_HTTP_DATA_DIR not set. The shared test-app-http must be spawned by e2e/global-setup.ts before tests run.",
		);
	}

	// Per-test user token → multi-tenant SQLite isolates workspaces under
	// <dataDir>/users/<id>/workspace/. Random 32-bit id keeps the cross-test
	// collision odds negligible.
	const userId = Math.floor(Math.random() * 0x7fff_ffff);
	const token = mintTestToken({ id: userId, email: `test-${userId}@example.com` });
	const cwd = path.join(dataDir, "users", String(userId), "workspace");
	await fs.mkdir(cwd, { recursive: true });

	// When the test seeds a fixture, symlink the source `.bodhi-pi/` into the
	// per-user workspace. wireAgentForRequest's `createNodeExtensionLoader` walks
	// the symlinked snapshot per request; following the symlink reaches the
	// monorepo node_modules for package-mode imports.
	if (opts.bodhiPiFixture) {
		await fs.symlink(fixtureBodhiPiDir(opts.bodhiPiFixture), path.join(cwd, ".bodhi-pi"), "dir");
	}

	const updates: SessionNotification[] = [];
	const events: BodhiPiEvent[] = [];
	const clientConn = new HttpAcpConnection({
		baseUrl,
		token,
		onUpdate: (n) => updates.push(n),
		onLifecycleEvent: (e) => events.push(e),
	});

	const filesystem = createNodeFilesystem({ rootCwd: cwd });
	const sessionStore = createInMemorySessionStore();
	const kvStore = createInMemoryKvStore();

	const cleanup = async () => {
		// Server stays up (global-setup teardown shuts it down). Only the per-user
		// workspace directory belongs to this test.
		await fs.rm(cwd, { recursive: true, force: true });
	};

	return {
		clientConn,
		client: createBodhiPiClient(clientConn, { cwd }),
		updates,
		events,
		flushEvents: () => waitForAgentEndBalance(events),
		filesystem,
		sessionStore,
		kvStore,
		cwd,
		cleanup,
	};
}

async function createWsHarness(opts: E2EHarnessOptions): Promise<E2EHarness> {
	const { createNodeFilesystem } = await import("@e2e/helpers/node-adapters/index.js");
	const { openWsConnection } = await import("./ws-connection.js");
	const { mintTestToken } = await import("./auth.js");

	const baseUrl = process.env.BODHI_PI_E2E_WS_BASE_URL;
	const dataDir = process.env.BODHI_PI_E2E_WS_DATA_DIR;
	if (!baseUrl || !dataDir) {
		throw new Error(
			"ws harness: BODHI_PI_E2E_WS_BASE_URL / BODHI_PI_E2E_WS_DATA_DIR not set. The shared test-app-http (ws spawn) must be spawned by e2e/global-setup.ts before tests run.",
		);
	}

	// Per-test user token → multi-tenant SQLite isolates workspaces under
	// <dataDir>/users/<id>/workspace/. The stateful-per-WS-connection agent
	// lifecycle means cross-test bleed would be catastrophic if user IDs
	// collided — random 32-bit id keeps the odds negligible.
	const userId = Math.floor(Math.random() * 0x7fff_ffff);
	const token = mintTestToken({ id: userId, email: `test-${userId}@example.com` });
	const cwd = path.join(dataDir, "users", String(userId), "workspace");
	await fs.mkdir(cwd, { recursive: true });

	// When the test seeds a fixture, symlink the source `.bodhi-pi/` into the
	// per-user workspace. wireAgentForWsConnection's extension loader walks the
	// symlinked snapshot once per connection.
	if (opts.bodhiPiFixture) {
		await fs.symlink(fixtureBodhiPiDir(opts.bodhiPiFixture), path.join(cwd, ".bodhi-pi"), "dir");
	}

	const updates: SessionNotification[] = [];
	const events: BodhiPiEvent[] = [];
	const handle = await openWsConnection({
		baseUrl,
		token,
		onUpdate: (n) => updates.push(n),
		onLifecycleEvent: (e) => events.push(e),
	});

	const filesystem = createNodeFilesystem({ rootCwd: cwd });
	const sessionStore = createInMemorySessionStore();
	const kvStore = createInMemoryKvStore();

	const cleanup = async () => {
		await handle.close();
		// Server stays up (global-setup teardown shuts it down). Only the per-user
		// workspace directory belongs to this test.
		await fs.rm(cwd, { recursive: true, force: true });
	};

	return {
		clientConn: handle.conn,
		client: createBodhiPiClient(handle.conn, { cwd }),
		updates,
		events,
		flushEvents: () => waitForAgentEndBalance(events),
		filesystem,
		sessionStore,
		kvStore,
		cwd,
		cleanup,
	};
}

export type { AnyMessage };
