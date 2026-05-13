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
import { createReadOnlyFilesystemProxy, seedFilesViaFilesystem } from "./test-filesystem.js";

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
	/**
	 * Read-only filesystem proxy over the agent's real Filesystem. Exposes
	 * `readTextFile` + `exists` only; all other methods throw. Pre-init seeding
	 * uses `setupFiles` instead (Option B — uniform across all runtimes so
	 * browser, which cannot share a Filesystem handle across realms, can run
	 * the same shared suite).
	 */
	filesystem: Filesystem;
	/**
	 * Seed files at paths relative to `cwd`. MUST be called before
	 * `clientConn.initialize()`. Parent directories are created automatically.
	 */
	setupFiles: (files: Record<string, string>) => Promise<void>;
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
	if (runtime === "browser") return createBrowserHarness(opts);
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
		filesystem: createReadOnlyFilesystemProxy(inner.filesystem),
		setupFiles: (files) => seedFilesViaFilesystem(inner.filesystem, cwd, files),
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
		filesystem: createReadOnlyFilesystemProxy(filesystem),
		setupFiles: (files) => seedFilesViaFilesystem(filesystem, tmpDir, files),
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
		filesystem: createReadOnlyFilesystemProxy(filesystem),
		setupFiles: (files) => seedFilesViaFilesystem(filesystem, cwd, files),
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
		filesystem: createReadOnlyFilesystemProxy(filesystem),
		setupFiles: (files) => seedFilesViaFilesystem(filesystem, cwd, files),
		sessionStore,
		kvStore,
		cwd,
		cleanup,
	};
}

async function loadFixtureSeedFiles(
	fixture: string,
	opts: { getApiKey?: (provider: string) => string | undefined },
): Promise<Record<string, string>> {
	const root = fixtureBodhiPiDir(fixture);
	const out: Record<string, string> = {};
	async function walk(absDir: string, relDir: string): Promise<void> {
		const entries = await fs.readdir(absDir, { withFileTypes: true });
		for (const entry of entries) {
			const childAbs = path.join(absDir, entry.name);
			const childRel = relDir ? `${relDir}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				await walk(childAbs, childRel);
			} else if (entry.isFile()) {
				out[`.bodhi-pi/${childRel}`] = await fs.readFile(childAbs, "utf-8");
			}
		}
	}
	await walk(root, "");
	// register-provider is shipped as a TypeScript package-mode extension —
	// the cli/http jiti loader handles it, but the browser extension loader
	// only picks flat .js/.mjs files. Generate a flat JS twin with the
	// anthropic API key baked in (read from the harness's getApiKey, which
	// is how Node's `process.env.ANTHROPIC_API_KEY` would have flowed in).
	if (fixture === "register-provider") {
		const apiKey = opts.getApiKey?.("anthropic") ?? process.env.ANTHROPIC_API_KEY ?? "";
		out[".bodhi-pi/extensions/register-provider.js"] =
			`// Auto-generated flat-JS twin of the TS package-mode register-provider
// extension for the browser e2e harness. The TS file under
// register-provider/src/index.ts continues to power cli/http/ws.
// Mirrors the runtime shape from pi-ai's claude-haiku-4-5 entry.
export default function registerAnthropicProvider(pi) {
  const apiKey = ${JSON.stringify(apiKey)};
  if (!apiKey) throw new Error("register-provider (browser): anthropic api key missing");
  const model = {
    id: "claude-haiku-4-5",
    name: "Claude Haiku 4.5 (latest)",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    contextWindow: 200000,
    maxTokens: 64000,
  };
  pi.registerProvider("ext-anthropic", { model, getApiKey: () => apiKey });
}
`;
	}
	return out;
}

async function createBrowserHarness(opts: E2EHarnessOptions): Promise<E2EHarness> {
	const { BrowserAcpConnection } = await import("./browser-connection.js");
	const { createBrowserFilesystem } = await import("./browser-filesystem.js");
	const { launchHarnessContext } = await import("./browser-launch.js");

	const baseUrl = process.env.BODHI_PI_E2E_BROWSER_BASE_URL;
	if (!baseUrl) {
		throw new Error(
			"browser harness: BODHI_PI_E2E_BROWSER_BASE_URL not set. The Vite dev server for test-app-browser must be started by e2e/global-setup.ts before tests run.",
		);
	}

	const userId = String(Math.floor(Math.random() * 0x7fff_ffff));
	const userEmail = `test-${userId}@example.com`;
	// `/mnt/test-workspace` is the InMemory ZenFS mount the page creates at
	// setup-submit; all in-page paths (workspace + slash readback) are
	// rooted there. Shared tests compose paths as `${h.cwd}/file.txt`.
	const cwd = "/mnt/test-workspace";

	const stagedFiles: Record<string, string> = {};
	if (opts.bodhiPiFixture) {
		Object.assign(
			stagedFiles,
			await loadFixtureSeedFiles(opts.bodhiPiFixture, {
				...(opts.getApiKey ? { getApiKey: opts.getApiKey } : {}),
			}),
		);
	}
	const updates: SessionNotification[] = [];
	const events: BodhiPiEvent[] = [];

	// Resolve API keys from the host-supplied getApiKey for every provider
	// referenced by the configured models. The worker uses these to build its
	// own (provider) => key closure.
	const apiKeys: Record<string, string> = {};
	if (opts.getApiKey) {
		const providers = new Set<string>();
		for (const m of opts.models) providers.add(m.provider);
		for (const p of providers) {
			const k = opts.getApiKey(p);
			if (k) apiKeys[p] = k;
		}
	}

	type LaunchHandle = {
		page: import("playwright").Page;
		close: () => Promise<void>;
		conn: InstanceType<typeof BrowserAcpConnection>;
	};
	let handle: LaunchHandle | null = null;

	async function ensureLaunched(): Promise<LaunchHandle> {
		if (handle) return handle;
		const ctx = await launchHarnessContext({
			baseUrl: baseUrl as string,
			userId,
			userEmail,
			seedFiles: stagedFiles,
			models: opts.models,
			defaultModelId: opts.defaultModelId,
			apiKeys,
			...(opts.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
			...(opts.appendSystemPrompt !== undefined ? { appendSystemPrompt: opts.appendSystemPrompt } : {}),
			...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
		});
		const conn = new BrowserAcpConnection({
			page: ctx.page,
			onUpdate: (n) => updates.push(n),
			onLifecycleEvent: (e) => events.push(e),
		});
		handle = { page: ctx.page, close: ctx.close, conn };
		return handle;
	}

	const clientConn: BodhiPiAcpConnection = {
		async initialize(params) {
			const { conn } = await ensureLaunched();
			return conn.initialize(params);
		},
		async newSession(params) {
			const { conn } = await ensureLaunched();
			return conn.newSession(params);
		},
		async loadSession(params) {
			const { conn } = await ensureLaunched();
			return conn.loadSession(params);
		},
		async resumeSession(params) {
			const { conn } = await ensureLaunched();
			return conn.resumeSession(params);
		},
		async listSessions(params) {
			const { conn } = await ensureLaunched();
			return conn.listSessions(params);
		},
		async closeSession(params) {
			const { conn } = await ensureLaunched();
			return conn.closeSession(params);
		},
		async setSessionConfigOption(params) {
			const { conn } = await ensureLaunched();
			return conn.setSessionConfigOption(params);
		},
		async prompt(params) {
			const { conn } = await ensureLaunched();
			return conn.prompt(params);
		},
		async cancel(params) {
			const { conn } = await ensureLaunched();
			return conn.cancel(params);
		},
		async extMethod(method, params) {
			const { conn } = await ensureLaunched();
			return conn.extMethod(method, params);
		},
	};

	// Use a lazy-resolving Filesystem so reads work before initialize. In
	// practice all reads are post-prompt (after init), so the page is always
	// launched by the time these get called.
	const filesystem: Filesystem = {
		async readTextFile(p) {
			const { page } = await ensureLaunched();
			return createBrowserFilesystem({ page }).readTextFile(p);
		},
		async exists(p) {
			const { page } = await ensureLaunched();
			return createBrowserFilesystem({ page }).exists(p);
		},
		async writeTextFile() {
			throw new Error(
				"e2e browser harness: filesystem.writeTextFile() is disabled. Use h.setupFiles({...}) before clientConn.initialize().",
			);
		},
		async mkdir() {
			throw new Error(
				"e2e browser harness: filesystem.mkdir() is disabled. Use h.setupFiles({...}) before clientConn.initialize().",
			);
		},
		async list() {
			throw new Error("e2e browser harness: filesystem.list() is disabled.");
		},
		async stat() {
			throw new Error("e2e browser harness: filesystem.stat() is disabled.");
		},
		async remove() {
			throw new Error("e2e browser harness: filesystem.remove() is disabled.");
		},
	};

	const setupFiles = async (files: Record<string, string>): Promise<void> => {
		if (handle) {
			throw new Error("h.setupFiles must be called BEFORE clientConn.initialize() under the browser runtime");
		}
		for (const [k, v] of Object.entries(files)) {
			stagedFiles[k] = v;
		}
	};

	// Browser harness uses in-memory session/kv stubs at the test side —
	// the real backing store lives inside the in-page Dexie. Tests assert at
	// the protocol level (extMethod for kv, listSessions for sessions), not
	// against these stubs.
	const sessionStore = createInMemorySessionStore();
	const kvStore = createInMemoryKvStore();

	const cleanup = async () => {
		if (handle) {
			await handle.close();
			handle = null;
		}
	};

	return {
		clientConn,
		client: createBodhiPiClient(clientConn, { cwd }),
		updates,
		events,
		flushEvents: () => waitForAgentEndBalance(events),
		filesystem,
		setupFiles,
		sessionStore,
		kvStore,
		cwd,
		cleanup,
	};
}

export type { AnyMessage };
