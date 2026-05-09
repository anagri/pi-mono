import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ClientSideConnection, SessionNotification } from "@agentclientprotocol/sdk";
import type { BodhiPiEventHandlers, RegisteredExtension } from "@bodhiapp/bodhi-pi";
import type { Api, Model } from "@mariozechner/pi-ai";
import { createCliAgent } from "@/agent.js";
import { createInProcessAcpPair } from "./in-process-connection.js";

export interface CliTestHarness {
	clientConn: ClientSideConnection;
	updates: SessionNotification[];
	tmpDir: string;
	dbPath: string;
	cleanup: () => Promise<void>;
}

export interface CliTestHarnessOptions {
	model: Model<Api>;
	apiKey: string;
	provider?: string;
	/** Additional models to register beyond the default. Used by cross-provider e2e. */
	extraModels?: Model<Api>[];
	/** Override the (provider → key) lookup. Takes precedence over apiKey/provider. */
	getApiKey?: (provider: string) => string | undefined;
	eventHandlers?: BodhiPiEventHandlers;
	extensionFactories?: RegisteredExtension[];
	/**
	 * Optional explicit working directory. When set, the agent's `cwd` points
	 * here and the harness will NOT clean it up — caller owns the lifecycle.
	 * Use this to point at a checked-in `test/fixtures/<scenario>/` workspace
	 * (read-only) or to share a tmpdir across multiple harness instances inside
	 * a single test (e.g. cross-instance persistence).
	 */
	cwd?: string;
	/**
	 * Optional explicit SQLite path. Defaults to a unique file under `os.tmpdir()`
	 * so concurrent harness instances against the same `cwd` (e.g. a shared
	 * fixture) never lock-conflict. Set this to share a DB across two harness
	 * instances (e.g. persistence-across-instances tests).
	 */
	dbPath?: string;
}

export async function createCliTestHarness(opts: CliTestHarnessOptions): Promise<CliTestHarness> {
	const ownsTmpDir = opts.cwd === undefined;
	const tmpDir = opts.cwd ?? (await fs.mkdtemp(path.join(os.tmpdir(), "bodhi-pi-cli-e2e-")));
	const dbPath =
		opts.dbPath ?? path.join(os.tmpdir(), `bodhi-pi-cli-e2e-db-${Math.random().toString(36).slice(2)}.db`);
	const provider = opts.provider ?? opts.model.provider;
	const getApiKey = opts.getApiKey ?? ((p: string) => (p === provider ? opts.apiKey : undefined));

	const agent = createCliAgent({
		cwd: tmpDir,
		dbPath,
		models: [opts.model, ...(opts.extraModels ?? [])],
		defaultModelId: opts.model.id,
		getApiKey,
		...(opts.eventHandlers ? { eventHandlers: opts.eventHandlers } : {}),
		...(opts.extensionFactories ? { extensionFactories: opts.extensionFactories } : {}),
	});

	const updates: SessionNotification[] = [];
	const { clientConn } = createInProcessAcpPair(agent.factory, () => ({
		sessionUpdate: async (params) => {
			updates.push(params);
		},
		requestPermission: async () => ({ outcome: { outcome: "approved" } }),
	}));

	return {
		clientConn,
		updates,
		tmpDir,
		dbPath,
		cleanup: async () => {
			// Always remove the ephemeral DB; only remove tmpDir if we created it.
			await fs.rm(dbPath, { force: true });
			await fs.rm(`${dbPath}-wal`, { force: true });
			await fs.rm(`${dbPath}-shm`, { force: true });
			if (ownsTmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
		},
	};
}
