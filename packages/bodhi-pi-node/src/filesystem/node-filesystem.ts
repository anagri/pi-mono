import fs from "node:fs/promises";
import path from "node:path";
import type { DirEntry, FileStat, Filesystem } from "@bodhiapp/bodhi-pi";

export interface NodeFilesystemOptions {
	/** Absolute root for the path-jail. Every method rejects paths outside this directory. */
	rootCwd: string;
}

export function createNodeFilesystem(opts: NodeFilesystemOptions): Filesystem {
	const { rootCwd } = opts;
	const unjailed = rootCwd === "/";
	function jail(absolutePath: string): string {
		const resolved = path.resolve(absolutePath);
		if (unjailed) return resolved;
		if (resolved !== rootCwd && !resolved.startsWith(rootCwd + path.sep)) {
			throw Object.assign(new Error(`EACCES: path escapes root: ${absolutePath}`), { code: "EACCES" });
		}
		return resolved;
	}

	return {
		async readTextFile(absolutePath) {
			return fs.readFile(jail(absolutePath), "utf-8");
		},

		async writeTextFile(absolutePath, content) {
			await fs.writeFile(jail(absolutePath), content, "utf-8");
		},

		async appendTextFile(absolutePath, content) {
			await fs.appendFile(jail(absolutePath), content, "utf-8");
		},

		async list(absolutePath) {
			const entries = await fs.readdir(jail(absolutePath), { withFileTypes: true });
			return entries.map(
				(e): DirEntry => ({
					name: e.name,
					isFile: e.isFile(),
					isDirectory: e.isDirectory(),
				}),
			);
		},

		async stat(absolutePath) {
			const s = await fs.stat(jail(absolutePath));
			return {
				isFile: s.isFile(),
				isDirectory: s.isDirectory(),
				size: s.size,
				mtimeMs: s.mtimeMs,
			} satisfies FileStat;
		},

		async exists(absolutePath) {
			try {
				await fs.access(jail(absolutePath));
				return true;
			} catch {
				return false;
			}
		},

		async mkdir(absolutePath, opts) {
			await fs.mkdir(jail(absolutePath), { recursive: opts?.recursive ?? false });
		},

		async remove(absolutePath, opts) {
			await fs.rm(jail(absolutePath), { recursive: opts?.recursive ?? false, force: true });
		},
	};
}
