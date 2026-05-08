import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ClientSideConnection, SessionNotification } from "@agentclientprotocol/sdk";
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
}

export async function createCliTestHarness(opts: CliTestHarnessOptions): Promise<CliTestHarness> {
	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bodhi-pi-cli-e2e-"));
	const dbPath = path.join(tmpDir, "sessions.db");
	const provider = opts.provider ?? opts.model.provider;

	const agent = createCliAgent({
		cwd: tmpDir,
		dbPath,
		models: [opts.model],
		defaultModelId: opts.model.id,
		getApiKey: (p) => (p === provider ? opts.apiKey : undefined),
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
		cleanup: () => fs.rm(tmpDir, { recursive: true, force: true }),
	};
}
