import fs from "node:fs/promises";
import path from "node:path";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { type BodhiPiEvent, createBodhiPiClient, createInMemoryKvStore, createInMemorySessionStore } from "@/index.js";
import { waitForAgentEndBalance } from "../events-assert.js";
import type { E2EHarness, E2EHarnessOptions } from "../harness.js";
import { mintTestToken } from "../http/auth.js";
import { createNodeFilesystem } from "../node-adapters/index.js";
import { fixtureBodhiPiDir } from "../seed-bodhi-pi.js";
import { createReadOnlyFilesystemProxy, seedFilesViaFilesystem } from "../test-filesystem.js";
import { openWsConnection } from "./connection.js";

export async function createWsHarness(opts: E2EHarnessOptions): Promise<E2EHarness> {
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
