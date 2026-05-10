import { mkdirSync } from "node:fs";
import path from "node:path";

/** Resolve and ensure `<dataDir>/users/<userId>/workspace/`. */
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

export function resolveUserWorkspace(opts: ResolveUserWorkspaceOptions): string {
	if (opts.workspaceOverride) return opts.workspaceOverride;
	return ensureUserWorkspace(opts.dataDir, opts.userId);
}
