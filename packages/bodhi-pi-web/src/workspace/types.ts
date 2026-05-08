/**
 * Resolved workspace handed to the worker on init. The bootstrap step decides
 * which `mode` we're in:
 *
 *   - `"fsa"`: production path. Chrome's File System Access API has granted
 *     a `FileSystemDirectoryHandle` (already in IndexedDB or freshly picked).
 *     The worker mounts it via `@zenfs/dom`'s WebAccess backend.
 *   - `"seed"`: e2e/test path. The page injects a `window.__bodhiPiWebSeed`
 *     payload before load; the worker mounts an `InMemory` ZenFS backend and
 *     writes the seed files.
 *
 * In either case the agent sees a real `Filesystem` rooted at `/mnt/<name>`.
 */
export interface FsaWorkspace {
	mode: "fsa";
	mountName: string;
	rootPath: string;
	handle: FileSystemDirectoryHandle;
}

export interface SeedWorkspace {
	mode: "seed";
	mountName: string;
	rootPath: string;
	seed: { files: Record<string, string> };
}

export type WorkspaceConfig = FsaWorkspace | SeedWorkspace;

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
