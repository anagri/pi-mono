import { loadHandle, queryPermission, requestPermission, saveHandle } from "@bodhiapp/bodhi-pi-browser";
import { fsaWorkspaceProvider, seedWorkspaceProvider, type WorkspaceProvider } from "./provider";

// These globals are implementation details of bootstrap; nothing else in src/
// touches them.
declare global {
	interface Window {
		__bodhiPiWebSeed?: { name: string; files: Record<string, string> };
		showDirectoryPicker?: (options?: {
			id?: string;
			mode?: "read" | "readwrite";
			startIn?: string | FileSystemHandle;
		}) => Promise<FileSystemDirectoryHandle>;
	}
}

export type BootstrapResult =
	| { ready: true; workspace: WorkspaceProvider }
	| { ready: false; kind: "needs-pick" }
	| { ready: false; kind: "needs-permission"; handle: FileSystemDirectoryHandle; name: string };

export async function bootstrapWorkspace(): Promise<BootstrapResult> {
	const seed = typeof window !== "undefined" ? window.__bodhiPiWebSeed : undefined;
	if (seed) {
		return {
			ready: true,
			workspace: seedWorkspaceProvider({ name: seed.name, files: seed.files }),
		};
	}

	const stored = await loadHandle();
	if (stored) {
		const state = await queryPermission(stored.handle);
		if (state === "granted") {
			return {
				ready: true,
				workspace: fsaWorkspaceProvider({ handle: stored.handle, name: stored.name }),
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
	// Picker dialog consumes the user-activation token, so a follow-up
	// `requestPermission` call would fail; the resolved handle is already granted.
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
