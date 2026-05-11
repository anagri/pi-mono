import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type FauxProviderRegistration, registerFauxProvider } from "@earendil-works/pi-ai";
import { buildServer, type ServerHandle } from "../../src/server.js";

export interface TestServer {
	server: ServerHandle;
	dataDir: string;
	faux: FauxProviderRegistration;
	cleanup: () => Promise<void>;
}

export interface StartTestServerOptions {
	/** When set, every connection uses this dir as cwd (CLI `--workspace` analog). */
	workspaceOverride?: string;
}

export async function startTestServer(opts: StartTestServerOptions = {}): Promise<TestServer> {
	const dataDir = mkdtempSync(path.join(os.tmpdir(), "bodhi-pi-ws-server-test-"));
	const faux = registerFauxProvider();
	const fauxModel = faux.getModel();
	if (!fauxModel) throw new Error("faux provider did not return a model");

	const server = await buildServer({
		port: 0,
		dataDir,
		models: [fauxModel],
		defaultModelId: fauxModel.id,
		getApiKey: () => "test-key",
		...(opts.workspaceOverride !== undefined ? { workspaceOverride: opts.workspaceOverride } : {}),
	});

	return {
		server,
		dataDir,
		faux,
		cleanup: async () => {
			await server.close();
			faux.unregister();
			rmSync(dataDir, { recursive: true, force: true });
		},
	};
}
