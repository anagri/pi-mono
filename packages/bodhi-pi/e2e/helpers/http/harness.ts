import fs from "node:fs/promises";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { type BodhiPiEvent, createBodhiPiClient, createInMemoryKvStore, createInMemorySessionStore } from "@/index.js";
import { waitForAgentEndBalance } from "../events-assert.js";
import type { E2EHarness, E2EHarnessOptions } from "../harness.js";
import { createNodeFilesystem } from "../node-adapters/index.js";
import { pickDefined } from "../pick-defined.js";
import { createReadOnlyFilesystemProxy, seedFilesViaFilesystem } from "../test-filesystem.js";
import { HttpAcpConnection } from "./connection.js";
import { mintTestUser, provisionWorkspace } from "./workspace.js";

export async function createHttpHarness(opts: E2EHarnessOptions): Promise<E2EHarness> {
	const baseUrl = process.env.BODHI_PI_E2E_HTTP_BASE_URL;
	const dataDir = process.env.BODHI_PI_E2E_HTTP_DATA_DIR;
	if (!baseUrl || !dataDir) {
		throw new Error(
			"http harness: BODHI_PI_E2E_HTTP_BASE_URL / BODHI_PI_E2E_HTTP_DATA_DIR not set. The shared test-app-http must be spawned by e2e/global-setup.ts before tests run.",
		);
	}

	const { token, cwd } = mintTestUser({ dataDir });
	await provisionWorkspace({ cwd, ...pickDefined({ fixture: opts.bodhiPiFixture }) });

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
