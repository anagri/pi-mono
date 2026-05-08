import { del, get, set } from "idb-keyval";

/**
 * IndexedDB-backed persistence for `FileSystemDirectoryHandle`s. Browsers
 * structure-clone FSA handles transparently, so `idb-keyval` round-trips them
 * with no extra serialisation. Pattern lifted from
 * `BodhiSearch/web-acp/src/vault/fsa-handle-store.ts`.
 *
 * Permission policy:
 *   - `queryPermission` is fine without a user gesture.
 *   - `requestPermission` MUST be invoked from a user-initiated event handler,
 *     otherwise the browser rejects.
 */

const HANDLE_KEY = "bodhi-pi-web:dir-handle";

export interface StoredHandle {
	handle: FileSystemDirectoryHandle;
	name: string;
}

export async function loadHandle(): Promise<StoredHandle | undefined> {
	try {
		const stored = await get<StoredHandle>(HANDLE_KEY);
		if (stored?.handle && typeof stored.name === "string") return stored;
	} catch {
		// fall through
	}
	return undefined;
}

export async function saveHandle(handle: FileSystemDirectoryHandle): Promise<void> {
	try {
		await set(HANDLE_KEY, { handle, name: handle.name });
	} catch (err) {
		console.warn("[fsa-handle-store] saveHandle failed:", err);
	}
}

export async function clearHandle(): Promise<void> {
	try {
		await del(HANDLE_KEY);
	} catch {
		// ignore
	}
}

type PermissionMode = "read" | "readwrite";
type FsaPermissionDescriptor = { mode: PermissionMode };

interface FsaPermissionExtensions {
	queryPermission?: (opts: FsaPermissionDescriptor) => Promise<PermissionState>;
	requestPermission?: (opts: FsaPermissionDescriptor) => Promise<PermissionState>;
}

function ext(handle: FileSystemDirectoryHandle): FsaPermissionExtensions {
	return handle as unknown as FsaPermissionExtensions;
}

export async function queryPermission(
	handle: FileSystemDirectoryHandle,
	mode: PermissionMode = "readwrite",
): Promise<PermissionState> {
	const fn = ext(handle).queryPermission;
	if (!fn) return "prompt";
	try {
		return await fn.call(handle, { mode });
	} catch {
		return "prompt";
	}
}

export async function requestPermission(
	handle: FileSystemDirectoryHandle,
	mode: PermissionMode = "readwrite",
): Promise<PermissionState> {
	const fn = ext(handle).requestPermission;
	if (!fn) return "denied";
	try {
		return await fn.call(handle, { mode });
	} catch {
		return "denied";
	}
}
