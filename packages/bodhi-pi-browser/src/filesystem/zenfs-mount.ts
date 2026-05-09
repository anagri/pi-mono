import { configure, mount, umount } from "@zenfs/core";
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

export async function unmountAt(rootPath: string): Promise<void> {
	if (!configured) return;
	try {
		umount(rootPath);
	} catch {
		// not mounted; ignore
	}
}
