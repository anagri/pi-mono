import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildServer, type ServerHandle } from "../../src/server/server.js";

export interface RealServer {
	server: ServerHandle;
	dataDir: string;
	url: string;
	cleanup: () => Promise<void>;
}

/**
 * Real e2e server with no baked-in models/keys. Tests configure auth blackbox
 * via `_bodhi-pi/kv/set auth/<provider>` (or the `/login` slash) on the client
 * side; the dynamic model registry then surfaces the matching provider catalog.
 */
export async function startRealServer(): Promise<RealServer> {
	const dataDir = mkdtempSync(path.join(os.tmpdir(), "bodhi-pi-http-e2e-"));
	const server = await buildServer({ port: 0, dataDir });
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
