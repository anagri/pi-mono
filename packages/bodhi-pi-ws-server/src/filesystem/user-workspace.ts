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
