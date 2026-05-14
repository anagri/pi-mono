import fs from "node:fs/promises";
import path from "node:path";
import { fixtureBodhiPiDir } from "../seed-bodhi-pi.js";
import { mintTestToken } from "./auth.js";

// Shared workspace provisioning for the Node-side harnesses. Used by the cli,
// http, and ws harness branches; the http/ws branches additionally use
// mintTestUser to derive a per-test (userId, token, cwd) triple.

export interface MintTestUserOptions {
	dataDir: string;
}

export interface MintTestUserResult {
	userId: number;
	token: string;
	cwd: string;
}

/**
 * Per-test user identity + workspace path for the http and ws harnesses. The
 * multi-tenant SQLite isolates session/kv state under <dataDir>/users/<id>/.
 * Random 32-bit id keeps the cross-test collision odds negligible.
 */
export function mintTestUser(opts: MintTestUserOptions): MintTestUserResult {
	const userId = Math.floor(Math.random() * 0x7fff_ffff);
	const token = mintTestToken({ id: userId, email: `test-${userId}@example.com` });
	const cwd = path.join(opts.dataDir, "users", String(userId), "workspace");
	return { userId, token, cwd };
}

export interface ProvisionWorkspaceOptions {
	cwd: string;
	/**
	 * Name of a `.bodhi-pi/` fixture under `packages/bodhi-pi/e2e/data/<name>/`
	 * to symlink into `<cwd>/.bodhi-pi`. The agent's extension loader walks the
	 * symlinked snapshot at session bootstrap.
	 */
	fixture?: string;
}

/**
 * Ensure `cwd` exists and (when a fixture is requested) symlink the fixture's
 * `.bodhi-pi/` into it. Following the symlink reaches the monorepo
 * node_modules so package-mode extensions can `import` from npm.
 */
export async function provisionWorkspace(opts: ProvisionWorkspaceOptions): Promise<void> {
	await fs.mkdir(opts.cwd, { recursive: true });
	if (opts.fixture) {
		await fs.symlink(fixtureBodhiPiDir(opts.fixture), path.join(opts.cwd, ".bodhi-pi"), "dir");
	}
}
