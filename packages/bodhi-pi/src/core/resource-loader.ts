import path from "node:path";
import type { Filesystem } from "@/filesystem/filesystem.js";

const CONTEXT_FILE_CANDIDATES = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"] as const;

export interface ContextFile {
	path: string;
	content: string;
}

async function loadContextFileFromDir(fs: Filesystem, dir: string): Promise<ContextFile | null> {
	for (const filename of CONTEXT_FILE_CANDIDATES) {
		const filePath = path.posix.join(dir, filename);
		if (!(await fs.exists(filePath))) continue;
		try {
			const content = await fs.readTextFile(filePath);
			return { path: filePath, content };
		} catch {
			// Unreadable file at this candidate → try next.
		}
	}
	return null;
}

/**
 * Walk from `cwd` up to the filesystem root, collecting one AGENTS.md /
 * AGENTS.MD / CLAUDE.md / CLAUDE.MD per directory (first match wins per dir).
 * Order in the returned array is root-first → cwd-last so the most specific
 * instruction lands last in the system prompt.
 *
 * Uses the injected `Filesystem` exclusively — no `node:fs`. Browser hosts
 * with a mounted FSA root terminate naturally when `path.posix.dirname`
 * returns the same dir.
 */
export async function loadProjectContextFiles(fs: Filesystem, cwd: string): Promise<ContextFile[]> {
	const collected: ContextFile[] = [];
	const seen = new Set<string>();
	let currentDir = path.posix.normalize(cwd);

	while (true) {
		const file = await loadContextFileFromDir(fs, currentDir);
		if (file && !seen.has(file.path)) {
			collected.unshift(file);
			seen.add(file.path);
		}
		const parent = path.posix.dirname(currentDir);
		if (parent === currentDir) break;
		currentDir = parent;
	}

	return collected;
}
