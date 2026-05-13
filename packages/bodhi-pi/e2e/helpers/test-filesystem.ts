import path from "node:path";
import type { Filesystem } from "@/index.js";

// Test-side wrapper around a real Filesystem the agent uses. Mutating methods
// (mkdir/writeTextFile/remove) and metadata methods (list/stat) throw uniformly
// across runtimes so the suite behaves identically under in-memory/cli/http/ws/
// browser. Reads (readTextFile/exists) pass through.
//
// Pre-init seeding uses `setupFiles` (Phase 1 migration, Option B): the harness
// resolves relative paths against `cwd` and writes through the inner Filesystem
// before any agent boot. After initialize, in-session writes are forbidden by
// design — the browser runtime can't share a Filesystem handle between the
// Node test process and the in-page ZenFS; all runtimes follow the same rule
// so cross-project test behavior stays uniform.

export function createReadOnlyFilesystemProxy(inner: Filesystem): Filesystem {
	const block = (method: string) => () => {
		throw new Error(
			`e2e harness: h.filesystem.${method}() is disabled. Use await h.setupFiles({...}) before clientConn.initialize() to seed files.`,
		);
	};
	return {
		readTextFile: (p) => inner.readTextFile(p),
		exists: (p) => inner.exists(p),
		writeTextFile: block("writeTextFile"),
		mkdir: block("mkdir"),
		remove: block("remove"),
		list: block("list"),
		stat: block("stat"),
	};
}

export async function seedFilesViaFilesystem(
	inner: Filesystem,
	cwd: string,
	files: Record<string, string>,
): Promise<void> {
	for (const [relPath, content] of Object.entries(files)) {
		if (relPath.startsWith("/")) {
			throw new Error(`setupFiles: path must be relative to cwd, got absolute path "${relPath}"`);
		}
		const absPath = path.posix.join(cwd, relPath);
		const dir = path.posix.dirname(absPath);
		if (dir && dir !== cwd && dir !== "/") {
			await inner.mkdir(dir, { recursive: true });
		}
		await inner.writeTextFile(absPath, content);
	}
}
