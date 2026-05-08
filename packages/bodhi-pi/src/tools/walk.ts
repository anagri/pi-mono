import path from "node:path";
import type { Filesystem } from "@/filesystem/filesystem.js";

export interface WalkEntry {
	absolutePath: string;
	isFile: boolean;
	isDirectory: boolean;
}

export interface WalkOptions {
	/** Stop after collecting this many entries (matched files + directories visited). */
	maxEntries?: number;
	/** Skip directory if predicate returns true. Useful for ignoring node_modules, .git, etc. */
	skipDir?: (absolutePath: string) => boolean;
	signal?: AbortSignal;
}

const DEFAULT_SKIP = new Set([".git", "node_modules"]);

function defaultSkipDir(absolutePath: string): boolean {
	return DEFAULT_SKIP.has(path.basename(absolutePath));
}

/**
 * Pure-JS recursive directory walk over a `Filesystem`.
 *
 * Yields each directory entry (file or subdir) with its absolute path. The
 * walker visits subdirectories depth-first; ordering inside a single directory
 * is whatever `Filesystem.list` returns (alphabetical for the in-memory impl).
 *
 * Browser-portable: no `node:fs`, no shell-out.
 */
export async function* walk(fs: Filesystem, rootAbsolute: string, opts: WalkOptions = {}): AsyncGenerator<WalkEntry> {
	const skipDir = opts.skipDir ?? defaultSkipDir;
	const stack: string[] = [rootAbsolute];
	let yielded = 0;

	while (stack.length > 0) {
		if (opts.signal?.aborted) return;
		const dir = stack.pop() as string;
		let children: Awaited<ReturnType<Filesystem["list"]>>;
		try {
			children = await fs.list(dir);
		} catch {
			continue;
		}
		for (const entry of children) {
			const absolutePath = path.posix.join(dir, entry.name);
			if (entry.isDirectory && skipDir(absolutePath)) continue;
			yield { absolutePath, isFile: entry.isFile, isDirectory: entry.isDirectory };
			yielded++;
			if (opts.maxEntries !== undefined && yielded >= opts.maxEntries) return;
			if (entry.isDirectory) stack.push(absolutePath);
		}
	}
}
