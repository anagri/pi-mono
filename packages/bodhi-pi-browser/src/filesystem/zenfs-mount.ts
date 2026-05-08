import { configure, fs, InMemory, mount, umount } from "@zenfs/core";
import { WebAccess } from "@zenfs/dom";

/**
 * ZenFS keeps one mount table per realm. We initialise it once per worker /
 * tab via `configure({ mounts: {} })` and add mounts dynamically with
 * `mount(path, backend)`. Mirrors the pattern in
 * `BodhiSearch/web-acp-agent/src/agent/volume-registry.ts:129`.
 */
let configured = false;
async function ensureZenfs(): Promise<void> {
	if (configured) return;
	await configure({ mounts: {} });
	configured = true;
}

export interface MountResult {
	rootPath: string;
}

export async function mountFsaHandle(opts: {
	handle: FileSystemDirectoryHandle;
	mountName: string;
}): Promise<MountResult> {
	await ensureZenfs();
	const rootPath = `/mnt/${opts.mountName}`;
	const backend = await WebAccess.create({ handle: opts.handle });
	mount(rootPath, backend);
	return { rootPath };
}

export interface SeedFiles {
	[absoluteOrRelativePath: string]: string;
}

export async function mountInMemorySeed(opts: { mountName: string; files?: SeedFiles }): Promise<MountResult> {
	await ensureZenfs();
	const rootPath = `/mnt/${opts.mountName}`;
	const backend = InMemory.create({ label: opts.mountName });
	mount(rootPath, backend);

	const files = opts.files ?? {};
	for (const rel of Object.keys(files).sort()) {
		const absolute = rel.startsWith("/") ? `${rootPath}${rel}` : `${rootPath}/${rel}`;
		const slash = absolute.lastIndexOf("/");
		if (slash > 0) {
			const parent = absolute.slice(0, slash);
			try {
				await fs.promises.mkdir(parent, { recursive: true });
			} catch (err) {
				const code = (err as { code?: string } | null)?.code;
				if (code !== "EEXIST") throw err;
			}
		}
		await fs.promises.writeFile(absolute, files[rel] ?? "", { encoding: "utf-8" });
	}

	return { rootPath };
}

export async function unmountAt(rootPath: string): Promise<void> {
	if (!configured) return;
	try {
		umount(rootPath);
	} catch {
		// not mounted; ignore
	}
}
