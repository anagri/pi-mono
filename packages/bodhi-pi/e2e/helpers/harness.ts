import type { AnyMessage, SessionNotification } from "@agentclientprotocol/sdk";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
	BodhiPiAcpConnection,
	BodhiPiClient,
	BodhiPiEvent,
	CompactionSettings,
	Filesystem,
	KvStore,
	ScriptExecutor,
	SessionStore,
} from "@/index.js";
import { type E2ERuntime, getRuntime } from "./runtime.js";

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

type HarnessFactory = (opts: E2EHarnessOptions) => Promise<E2EHarness>;

// Lazy per-runtime module loaders keep Node-only or browser-only modules out
// of the wrong project's import graph. Each entry resolves on first use.
const HARNESS_LOADERS: Record<E2ERuntime, () => Promise<HarnessFactory>> = {
	"in-memory": async () => (await import("./in-memory/harness.js")).createInMemoryHarness,
	cli: async () => (await import("./cli/harness.js")).createCliHarness,
	http: async () => (await import("./http/harness.js")).createHttpHarness,
	ws: async () => (await import("./ws/harness.js")).createWsHarness,
	browser: async () => (await import("./browser/harness.js")).createBrowserHarness,
	"chrome-ext": async () => (await import("./chrome-ext/harness.js")).createChromeExtHarness,
};

export async function createE2EHarness(opts: E2EHarnessOptions): Promise<E2EHarness> {
	const factory = await HARNESS_LOADERS[getRuntime()]();
	return factory(opts);
}

export type { AnyMessage };
