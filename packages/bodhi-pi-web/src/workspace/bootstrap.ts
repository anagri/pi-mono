import { loadHandle, queryPermission, requestPermission, saveHandle } from "@bodhiapp/bodhi-pi-browser";
import type { WorkspaceConfig } from "./types";

/**
 * Workspace bootstrap. Three states this can resolve to:
 *   - `{ ready: true, workspace }` — chat surface can mount.
 *   - `{ ready: false, kind: "needs-permission", handle }` — handle exists in
 *     IndexedDB but permission lapsed; user-gesture required to re-grant.
 *   - `{ ready: false, kind: "needs-pick" }` — fresh browser, no handle yet.
 *
 * Test path: if `window.__bodhiPiWebSeed` is set (Playwright `addInitScript`),
 * we short-circuit to a seed workspace and skip IndexedDB / FSA entirely.
 */
export type BootstrapResult =
	| { ready: true; workspace: WorkspaceConfig }
	| { ready: false; kind: "needs-pick" }
	| { ready: false; kind: "needs-permission"; handle: FileSystemDirectoryHandle; name: string };

export async function bootstrapWorkspace(): Promise<BootstrapResult> {
	// Test seed wins.
	const seed = typeof window !== "undefined" ? window.__bodhiPiWebSeed : undefined;
	if (seed) {
		return {
			ready: true,
			workspace: {
				mode: "seed",
				mountName: seed.name,
				rootPath: `/mnt/${seed.name}`,
				seed: { files: seed.files },
			},
		};
	}

	// Persistent handle.
	const stored = await loadHandle();
	if (stored) {
		const state = await queryPermission(stored.handle);
		if (state === "granted") {
			return {
				ready: true,
				workspace: {
					mode: "fsa",
					mountName: stored.name,
					rootPath: `/mnt/${stored.name}`,
					handle: stored.handle,
				},
			};
		}
		return { ready: false, kind: "needs-permission", handle: stored.handle, name: stored.name };
	}

	return { ready: false, kind: "needs-pick" };
}

export async function pickAndPersistDirectory(): Promise<WorkspaceConfig | undefined> {
	if (typeof window === "undefined" || typeof window.showDirectoryPicker !== "function") {
		throw new Error("File System Access API not available in this browser");
	}
	const handle = await window.showDirectoryPicker({ mode: "readwrite" });
	const granted = await requestPermission(handle, "readwrite");
	if (granted !== "granted") return undefined;
	await saveHandle(handle);
	return {
		mode: "fsa",
		mountName: handle.name,
		rootPath: `/mnt/${handle.name}`,
		handle,
	};
}

export async function reGrantPermission(
	handle: FileSystemDirectoryHandle,
	name: string,
): Promise<WorkspaceConfig | undefined> {
	const state = await requestPermission(handle, "readwrite");
	if (state !== "granted") return undefined;
	return {
		mode: "fsa",
		mountName: name,
		rootPath: `/mnt/${name}`,
		handle,
	};
}
