import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type FauxProviderRegistration, registerFauxProvider } from "@mariozechner/pi-ai";
import { buildServer, type ServerHandle } from "../../src/server.js";

export interface TestServer {
	server: ServerHandle;
	dataDir: string;
	faux: FauxProviderRegistration;
	cleanup: () => Promise<void>;
}

/**
 * Boot a server for tests with a faux LLM provider and a tmpdir data root.
 * Caller must `cleanup()` to close the server, unregister the faux provider,
 * and remove the tmpdir.
 */
export async function startTestServer(): Promise<TestServer> {
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
