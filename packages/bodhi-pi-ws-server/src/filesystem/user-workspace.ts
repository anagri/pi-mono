import { mkdirSync } from "node:fs";
import path from "node:path";

/**
 * Resolve and ensure the per-user workspace directory exists.
 *
 * Layout: `<dataDir>/users/<userId>/workspace/`. Returns the absolute path,
 * which becomes the agent's `cwd` for that connection.
 */
export function ensureUserWorkspace(dataDir: string, userId: number): string {
	const cwd = path.resolve(dataDir, "users", String(userId), "workspace");
	mkdirSync(cwd, { recursive: true });
	return cwd;
}

export interface ResolveUserWorkspaceOptions {
	dataDir: string;
	userId: number;
	/** When set, overrides per-user routing; every user shares this directory. */
	workspaceOverride?: string;
}

/**
 * Single seam for choosing a connection's cwd. With `workspaceOverride` set
 * (CLI `--workspace <dir>`), all users share that directory (single-tenant
 * test mode). Otherwise the per-user workspace is auto-mkdir'd.
 */
export function resolveUserWorkspace(opts: ResolveUserWorkspaceOptions): string {
	if (opts.workspaceOverride) return opts.workspaceOverride;
	return ensureUserWorkspace(opts.dataDir, opts.userId);
}
