import type { CpOptions, FileContent, FsStat, IFileSystem, MkdirOptions, RmOptions } from "just-bash";
import { join, resolve } from "pathe";
import type { Filesystem } from "@/index.js";

interface DirentEntry {
	name: string;
	isFile: boolean;
	isDirectory: boolean;
	isSymbolicLink: boolean;
}

const DEFAULT_MODE_FILE = 0o644;
const DEFAULT_MODE_DIR = 0o755;

function contentToString(content: FileContent): string {
	if (typeof content === "string") return content;
	return new TextDecoder().decode(content);
}

function fsError(code: string, message: string): Error {
	return Object.assign(new Error(`${code}: ${message}`), { code });
}

/**
 * Lockstep copy of `test-apps/app-utils/just-bash-fs-adapter.ts` (e2e is a blackbox
 * suite that may not import test-app packages). Wraps a bodhi-pi `Filesystem` so it
 * satisfies just-bash's `IFileSystem`.
 *
 * Methods bodhi-pi's Filesystem doesn't expose directly:
 *   - `cp`/`mv` — implemented as compound ops over read/write/stat/list/remove.
 *   - `chmod`/`symlink`/`link`/`readlink`/`utimes` — silently swallowed; bash
 *     commands like `chmod +x` don't surface a fatal error where unsupported.
 *   - `lstat`/`realpath` — fall through to stat / return the input path.
 *   - `getAllPaths` — returns `[]`; bash's glob layer falls back to per-dir readdir.
 */
export function createJustBashFsAdapter(filesystem: Filesystem): IFileSystem {
	async function adaptStat(absPath: string): Promise<FsStat> {
		const s = await filesystem.stat(absPath);
		return {
			isFile: s.isFile,
			isDirectory: s.isDirectory,
			isSymbolicLink: false,
			mode: s.isDirectory ? DEFAULT_MODE_DIR : DEFAULT_MODE_FILE,
			size: s.size,
			mtime: new Date(s.mtimeMs),
		};
	}

	async function copyOne(src: string, dst: string, recursive: boolean): Promise<void> {
		const s = await filesystem.stat(src);
		if (s.isDirectory) {
			if (!recursive) throw fsError("EISDIR", `cannot copy directory without recursive: ${src}`);
			await filesystem.mkdir(dst, { recursive: true });
			const entries = await filesystem.list(src);
			for (const entry of entries) {
				await copyOne(join(src, entry.name), join(dst, entry.name), recursive);
			}
			return;
		}
		const text = await filesystem.readTextFile(src);
		await filesystem.writeTextFile(dst, text);
	}

	const adapter: IFileSystem = {
		async readFile(p) {
			return filesystem.readTextFile(p);
		},
		async readFileBuffer(p) {
			const text = await filesystem.readTextFile(p);
			return new TextEncoder().encode(text);
		},
		async writeFile(p, content) {
			await filesystem.writeTextFile(p, contentToString(content));
		},
		async appendFile(p, content) {
			await filesystem.appendTextFile(p, contentToString(content));
		},
		async exists(p) {
			return filesystem.exists(p);
		},
		async stat(p) {
			return adaptStat(p);
		},
		async lstat(p) {
			return adaptStat(p);
		},
		async mkdir(p, opts?: MkdirOptions) {
			await filesystem.mkdir(p, { recursive: opts?.recursive ?? false });
		},
		async readdir(p) {
			const entries = await filesystem.list(p);
			return entries.map((e) => e.name);
		},
		async readdirWithFileTypes(p) {
			const entries = await filesystem.list(p);
			return entries.map<DirentEntry>((e) => ({
				name: e.name,
				isFile: e.isFile,
				isDirectory: e.isDirectory,
				isSymbolicLink: false,
			}));
		},
		async rm(p, opts?: RmOptions) {
			if (opts?.force) {
				if (!(await filesystem.exists(p))) return;
			}
			await filesystem.remove(p, { recursive: opts?.recursive ?? false });
		},
		async cp(src, dst, opts?: CpOptions) {
			await copyOne(src, dst, opts?.recursive ?? false);
		},
		async mv(src, dst) {
			await copyOne(src, dst, true);
			const s = await filesystem.stat(src);
			await filesystem.remove(src, { recursive: s.isDirectory });
		},
		resolvePath(base, p) {
			return resolve(base, p);
		},
		getAllPaths() {
			return [];
		},
		async chmod() {},
		async symlink() {
			throw fsError("ENOSYS", "symlink not supported by bodhi-pi Filesystem");
		},
		async link() {
			throw fsError("ENOSYS", "link not supported by bodhi-pi Filesystem");
		},
		async readlink() {
			throw fsError("ENOSYS", "readlink not supported by bodhi-pi Filesystem");
		},
		async realpath(p) {
			return p;
		},
		async utimes() {},
	};
	return adapter;
}
