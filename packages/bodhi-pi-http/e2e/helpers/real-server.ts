import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveModelsFromEnv } from "../../src/server/models.js";
import { buildServer, type ServerHandle } from "../../src/server/server.js";

export interface RealServer {
	server: ServerHandle;
	dataDir: string;
	url: string;
	cleanup: () => Promise<void>;
}

export async function startRealServer(): Promise<RealServer> {
	const dataDir = mkdtempSync(path.join(os.tmpdir(), "bodhi-pi-http-e2e-"));
	const { models, defaultModelId, getApiKey } = resolveModelsFromEnv();
	const server = await buildServer({
		port: 0,
		dataDir,
		models,
		defaultModelId,
		getApiKey,
	});
	return {
		server,
		dataDir,
		url: `http://localhost:${server.port()}`,
		cleanup: async () => {
			await server.close();
			rmSync(dataDir, { recursive: true, force: true });
		},
	};
}
