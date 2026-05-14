import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { Page } from "playwright";
import {
	type BodhiPiAcpConnection,
	type BodhiPiEvent,
	createBodhiPiClient,
	createInMemoryKvStore,
	createInMemorySessionStore,
	type Filesystem,
} from "@/index.js";
import { waitForAgentEndBalance } from "../events-assert.js";
import type { E2EHarness, E2EHarnessOptions } from "../harness.js";
import { BrowserAcpConnection } from "./acp-connection.js";
import { createBrowserFilesystem } from "./filesystem.js";
import { loadFixtureSeedFiles } from "./load-fixture-seed-files.js";
import type { HarnessSetupOptions } from "./page-setup.js";

// Shared body for the two page-driven harnesses (browser, chrome-ext). The
// runtime-specific entry points pass their own `ensurePage` (which boots the
// right kind of Chromium context — regular vs. persistent-with-extension) and
// the env-var name that holds the page URL.

export interface PageDrivenHarnessConfig {
	baseUrlEnvVar: string;
	/** Human-readable label for stub error messages: "e2e browser harness", "e2e chrome-ext harness". */
	label: string;
	ensurePage: (opts: HarnessSetupOptions) => Promise<{ page: Page; close: () => Promise<void> }>;
}

// ACP method surface forwarded through the lazy-launch Proxy. Single source of
// truth; new ACP methods are picked up automatically as the harness stays in
// lockstep with `BodhiPiAcpConnection`.
const ACP_METHODS = [
	"initialize",
	"newSession",
	"loadSession",
	"resumeSession",
	"listSessions",
	"closeSession",
	"setSessionConfigOption",
	"prompt",
	"cancel",
	"extMethod",
] as const;
type AcpMethod = (typeof ACP_METHODS)[number];

export async function createPageDrivenHarness(
	opts: E2EHarnessOptions,
	cfg: PageDrivenHarnessConfig,
): Promise<E2EHarness> {
	const baseUrl = process.env[cfg.baseUrlEnvVar];
	if (!baseUrl) {
		throw new Error(
			`${cfg.label}: ${cfg.baseUrlEnvVar} not set. Global setup must launch the page-driven runtime before tests run.`,
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
		page: Page;
		close: () => Promise<void>;
		conn: InstanceType<typeof BrowserAcpConnection>;
	};
	let handle: LaunchHandle | null = null;

	async function ensureLaunched(): Promise<LaunchHandle> {
		if (handle) return handle;
		const ctx = await cfg.ensurePage({
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

	// Lazy-launch Proxy: every BodhiPiAcpConnection call defers context boot
	// until first use. Unknown property accesses return undefined so that
	// `then` / `Symbol.iterator` probes from awaitable-detection don't trigger
	// a spurious launch. Methods are invoked via `Reflect.apply(fn, conn, args)`
	// so `this` resolves to the BrowserAcpConnection instance (its method bodies
	// dispatch through `this.call(...)`).
	const acpMethodSet = new Set<AcpMethod>(ACP_METHODS);
	const clientConn = new Proxy({} as BodhiPiAcpConnection, {
		get(_target, prop) {
			if (typeof prop !== "string") return undefined;
			if (!acpMethodSet.has(prop as AcpMethod)) return undefined;
			return async (...args: unknown[]) => {
				const { conn } = await ensureLaunched();
				const fn = (conn as unknown as Record<string, (...a: unknown[]) => unknown>)[prop];
				return Reflect.apply(fn, conn, args);
			};
		},
	});

	// Read-only Filesystem proxy over the in-page ZenFS mount, lazily delegated
	// to createBrowserFilesystem once the page is launched. Writes throw with
	// cfg.label baked in.
	const filesystem: Filesystem = {
		async readTextFile(p) {
			const { page } = await ensureLaunched();
			return createBrowserFilesystem({ page, label: cfg.label }).readTextFile(p);
		},
		async exists(p) {
			const { page } = await ensureLaunched();
			return createBrowserFilesystem({ page, label: cfg.label }).exists(p);
		},
		async writeTextFile() {
			const { page } = await ensureLaunched();
			return createBrowserFilesystem({ page, label: cfg.label }).writeTextFile("", "");
		},
		async appendTextFile() {
			const { page } = await ensureLaunched();
			return createBrowserFilesystem({ page, label: cfg.label }).appendTextFile("", "");
		},
		async mkdir() {
			const { page } = await ensureLaunched();
			return createBrowserFilesystem({ page, label: cfg.label }).mkdir("");
		},
		async list() {
			const { page } = await ensureLaunched();
			return createBrowserFilesystem({ page, label: cfg.label }).list("");
		},
		async stat() {
			const { page } = await ensureLaunched();
			return createBrowserFilesystem({ page, label: cfg.label }).stat("");
		},
		async remove() {
			const { page } = await ensureLaunched();
			return createBrowserFilesystem({ page, label: cfg.label }).remove("");
		},
	};

	const setupFiles = async (files: Record<string, string>): Promise<void> => {
		if (handle) {
			throw new Error(`h.setupFiles must be called BEFORE clientConn.initialize() under the ${cfg.label} runtime`);
		}
		for (const [k, v] of Object.entries(files)) {
			stagedFiles[k] = v;
		}
	};

	// Page-driven harness uses in-memory session/kv stubs at the test side —
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
