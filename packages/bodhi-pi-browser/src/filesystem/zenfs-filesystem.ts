import type { DirEntry, FileStat, Filesystem } from "@bodhiapp/bodhi-pi";
import { fs } from "@zenfs/core";

/** Reserved for future opts (no current fields). Empty interface kept for shape parity with other adapters. */
// biome-ignore lint/complexity/noBannedTypes: explicit empty options for parity with createNode/Dexie/Browser factories
export type ZenfsFilesystemOptions = {};

/**
 * Implements bodhi-pi's `Filesystem` interface by delegating to ZenFS's
 * `fs.promises` (Node-fs-shaped). The caller decides which backend(s) are
 * mounted (FSA, InMemory, OPFS, …) before building this adapter — see
 * `zenfs-mount.ts`.
 *
 * Accepts an optional empty options object so the call shape matches the other
 * publishable factories (`createNodeFilesystem`, `createDexieSessionStore`, etc.) —
 * a host can swap runtimes by changing one import line.
 */
export function createZenfsFilesystem(_opts?: ZenfsFilesystemOptions): Filesystem {
	return {
		async readTextFile(p) {
			return (await fs.promises.readFile(p, "utf-8")) as string;
		},

		async writeTextFile(p, content) {
			await fs.promises.writeFile(p, content, "utf-8");
		},

		async list(p) {
			const entries = (await fs.promises.readdir(p, { withFileTypes: true })) as Array<{
				name: string;
				isFile(): boolean;
				isDirectory(): boolean;
			}>;
			return entries
				.map<DirEntry>((d) => ({
					name: d.name,
					isFile: d.isFile(),
					isDirectory: d.isDirectory(),
				}))
				.sort((a, b) => a.name.localeCompare(b.name));
		},

		async stat(p) {
			const s = await fs.promises.stat(p);
			const stat: FileStat = {
				isFile: s.isFile(),
				isDirectory: s.isDirectory(),
				size: Number(s.size ?? 0),
				mtimeMs: Number(s.mtimeMs ?? Date.now()),
			};
			return stat;
		},

		async exists(p) {
			try {
				await fs.promises.access(p);
				return true;
			} catch {
				return false;
			}
		},

		async mkdir(p, opts) {
			await fs.promises.mkdir(p, { recursive: opts?.recursive ?? false });
		},

		async remove(p, opts) {
			await fs.promises.rm(p, { recursive: opts?.recursive ?? false, force: true });
		},
	};
}
