import path from "node:path";
import type { DirEntry, FileStat, Filesystem } from "./filesystem.js";

type Entry = { type: "file"; content: string; mtimeMs: number } | { type: "dir"; mtimeMs: number };

function fsError(code: string, message: string): Error {
	return Object.assign(new Error(`${code}: ${message}`), { code });
}

/**
 * Map-backed reference `Filesystem`. Always rooted at `/`.
 *
 * Hosts use this for tests and ephemeral demos. Production hosts ship their
 * own backend (Node `fs`, OPFS, S3, ...) and pass it to `BodhiPiConfig`.
 */
export function createInMemoryFilesystem(): Filesystem {
	const entries = new Map<string, Entry>();
	entries.set("/", { type: "dir", mtimeMs: Date.now() });

	const norm = (p: string) => path.posix.normalize(p);

	function ensureParentDir(p: string): void {
		const parent = path.posix.dirname(p);
		const e = entries.get(parent);
		if (!e || e.type !== "dir") throw fsError("ENOENT", `parent dir missing: ${parent}`);
	}

	return {
		async readTextFile(p) {
			const e = entries.get(norm(p));
			if (!e) throw fsError("ENOENT", p);
			if (e.type !== "file") throw fsError("EISDIR", p);
			return e.content;
		},

		async writeTextFile(p, content) {
			const np = norm(p);
			ensureParentDir(np);
			entries.set(np, { type: "file", content, mtimeMs: Date.now() });
		},

		async appendTextFile(p, content) {
			const np = norm(p);
			const existing = entries.get(np);
			if (existing && existing.type !== "file") throw fsError("EISDIR", p);
			if (!existing) ensureParentDir(np);
			const prior = existing?.type === "file" ? existing.content : "";
			entries.set(np, { type: "file", content: prior + content, mtimeMs: Date.now() });
		},

		async list(p) {
			const np = norm(p);
			const e = entries.get(np);
			if (!e) throw fsError("ENOENT", p);
			if (e.type !== "dir") throw fsError("ENOTDIR", p);
			const prefix = np === "/" ? "/" : `${np}/`;
			const out: DirEntry[] = [];
			for (const [k, v] of entries) {
				if (k === np) continue;
				if (!k.startsWith(prefix)) continue;
				const rest = k.slice(prefix.length);
				if (rest.includes("/")) continue;
				out.push({ name: rest, isFile: v.type === "file", isDirectory: v.type === "dir" });
			}
			return out.sort((a, b) => a.name.localeCompare(b.name));
		},

		async stat(p) {
			const e = entries.get(norm(p));
			if (!e) throw fsError("ENOENT", p);
			const stat: FileStat = {
				isFile: e.type === "file",
				isDirectory: e.type === "dir",
				size: e.type === "file" ? e.content.length : 0,
				mtimeMs: e.mtimeMs,
			};
			return stat;
		},

		async exists(p) {
			return entries.has(norm(p));
		},

		async mkdir(p, opts) {
			const np = norm(p);
			if (entries.has(np)) {
				if (opts?.recursive) return;
				throw fsError("EEXIST", p);
			}
			if (opts?.recursive) {
				const parts = np.split("/").filter(Boolean);
				let cur = "";
				for (const part of parts) {
					cur += `/${part}`;
					if (!entries.has(cur)) entries.set(cur, { type: "dir", mtimeMs: Date.now() });
				}
				return;
			}
			ensureParentDir(np);
			entries.set(np, { type: "dir", mtimeMs: Date.now() });
		},

		async remove(p, opts) {
			const np = norm(p);
			const e = entries.get(np);
			if (!e) return;
			if (e.type === "dir") {
				const prefix = np === "/" ? "/" : `${np}/`;
				if (!opts?.recursive) {
					for (const k of entries.keys()) {
						if (k !== np && k.startsWith(prefix)) throw fsError("ENOTEMPTY", p);
					}
				}
				if (opts?.recursive) {
					for (const k of [...entries.keys()]) {
						if (k.startsWith(prefix)) entries.delete(k);
					}
				}
			}
			entries.delete(np);
		},
	};
}
