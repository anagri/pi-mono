import { loadHandle, queryPermission, requestPermission, saveHandle } from "@bodhiapp/bodhi-pi-browser";
import { fsaWorkspaceProvider, seedWorkspaceProvider, type WorkspaceProvider } from "./provider";

// File-local ambient declaration. The seed and FSA picker globals are an
// implementation detail of bootstrap; nothing else in src/ touches them.
// Keeping the augmentation off `workspace/types.ts` (and out of every
// downstream importer's ambient scope) was the point of Batch F.
declare global {
	interface Window {
		__bodhiPiWebSeed?: { name: string; files: Record<string, string> };
		__bodhiPiWebRecordEvents?: boolean;
		showDirectoryPicker?: (options?: {
			id?: string;
			mode?: "read" | "readwrite";
			startIn?: string | FileSystemHandle;
		}) => Promise<FileSystemDirectoryHandle>;
	}
}

/**
 * Workspace bootstrap. Three states this can resolve to:
 *   - `{ ready: true, workspace, recordEvents }` — chat surface can mount.
 *   - `{ ready: false, kind: "needs-permission", handle }` — handle exists in
 *     IndexedDB but permission lapsed; user-gesture required to re-grant.
 *   - `{ ready: false, kind: "needs-pick" }` — fresh browser, no handle yet.
 *
 * Test path: if `window.__bodhiPiWebSeed` is set (Playwright `addInitScript`),
 * we short-circuit to a seed workspace and skip IndexedDB / FSA entirely.
 *
 * `recordEvents` is an independent observability toggle, NOT derived from "is
 * this a test workspace". Playwright sets `window.__bodhiPiWebRecordEvents = true`
 * alongside the seed; production never sets either flag.
 */
export type BootstrapResult =
	| { ready: true; workspace: WorkspaceProvider; recordEvents: boolean }
	| { ready: false; kind: "needs-pick" }
	| { ready: false; kind: "needs-permission"; handle: FileSystemDirectoryHandle; name: string };

function readRecordEventsFlag(): boolean {
	if (typeof window === "undefined") return false;
	return window.__bodhiPiWebRecordEvents === true;
}

export async function bootstrapWorkspace(): Promise<BootstrapResult> {
	const recordEvents = readRecordEventsFlag();

	// Test seed wins.
	const seed = typeof window !== "undefined" ? window.__bodhiPiWebSeed : undefined;
	if (seed) {
		return {
			ready: true,
			workspace: seedWorkspaceProvider({ name: seed.name, files: seed.files }),
			recordEvents,
		};
	}

	// Persistent handle.
	const stored = await loadHandle();
	if (stored) {
		const state = await queryPermission(stored.handle);
		if (state === "granted") {
			return {
				ready: true,
				workspace: fsaWorkspaceProvider({ handle: stored.handle, name: stored.name }),
				recordEvents,
			};
		}
		return { ready: false, kind: "needs-permission", handle: stored.handle, name: stored.name };
	}

	return { ready: false, kind: "needs-pick" };
}

export async function pickAndPersistDirectory(): Promise<WorkspaceProvider | undefined> {
	if (typeof window === "undefined" || typeof window.showDirectoryPicker !== "function") {
		throw new Error("File System Access API not available in this browser");
	}
	// `showDirectoryPicker({ mode: "readwrite" })` already grants the requested
	// mode when the user picks a folder — the resolved handle is usable as-is.
	// We do NOT call `queryPermission` or `requestPermission` here: the picker
	// dialog consumes the user-activation token, so any follow-up call needs a
	// fresh gesture and may falsely return "prompt"/"denied". Pattern lifted
	// from BodhiSearch/web-acp/src/hooks/useVolumes.ts:147-179.
	const handle = await window.showDirectoryPicker({ mode: "readwrite" });
	await saveHandle(handle);
	return fsaWorkspaceProvider({ handle, name: handle.name });
}

export async function reGrantPermission(
	handle: FileSystemDirectoryHandle,
	name: string,
): Promise<WorkspaceProvider | undefined> {
	const state = await requestPermission(handle, "readwrite");
	if (state !== "granted") return undefined;
	return fsaWorkspaceProvider({ handle, name });
}
