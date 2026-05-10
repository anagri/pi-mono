import { configure, InMemory, fs as zenFs, mount as zenMount } from "@zenfs/core";
import { mountFsaHandle } from "../filesystem/zenfs-mount";

/**
 * Single seam over how a workspace's filesystem bytes get mounted into ZenFS.
 *
 * Two implementations live below: `fsaWorkspaceProvider` (production, FSA handle)
 * and `seedWorkspaceProvider` (e2e/test, in-memory seed). Downstream code (App,
 * DirectoryGate, RuntimeProvider, runtime, worker) consumes only this interface
 * and must NOT branch on FSA-vs-seed. Production interfaces carry no test concerns
 * — there is no `isTest` flag here.
 *
 * The discriminator only crosses one boundary: `bootstrap.ts` constructs a
 * provider, the `WorkspaceData` over `postMessage` carries a `{kind, …}` record
 * (closures don't survive structured clone), the worker reconstructs a
 * `WorkspaceProvider` from the data and calls `mount()` exactly once.
 */
export interface WorkspaceProvider {
	readonly mountName: string;
	readonly rootPath: string;
	/** Mount the underlying filesystem into ZenFS. Called once by the worker. */
	mount(): Promise<void>;
	/**
	 * Wire-format the provider for `postMessage` (closures don't survive
	 * structured clone). `runtime.ts` calls this when posting `InitMessage`;
	 * the worker reconstructs a provider via `workspaceProviderFromData`.
	 */
	toData(): WorkspaceData;
}

/**
 * Discriminated wire-format. `bootstrap.ts` returns a `WorkspaceProvider` to the
 * UI; `runtime.ts` serialises it to `WorkspaceData` for `postMessage`; the worker
 * rebuilds a provider from the data via `workspaceProviderFromData`.
 */
export type WorkspaceData =
	| { kind: "fsa"; name: string; handle: FileSystemDirectoryHandle }
	| { kind: "seed"; name: string; files: Record<string, string> };

/** Production: mount a Chrome FSA `FileSystemDirectoryHandle` into ZenFS. */
export function fsaWorkspaceProvider(opts: { handle: FileSystemDirectoryHandle; name: string }): WorkspaceProvider {
	const { handle, name } = opts;
	const rootPath = `/mnt/${name}`;
	return {
		mountName: name,
		rootPath,
		async mount() {
			await mountFsaHandle({ handle, mountName: name });
		},
		toData() {
			return { kind: "fsa", name, handle };
		},
	};
}

/**
 * e2e/test: mount an InMemory ZenFS backend and write the seed files into it.
 *
 * The implementation talks to `@zenfs/core` directly (NOT through any
 * `bodhi-pi-browser` helper) because in-memory seed mounting is a test-only
 * concern that does not belong in the publishable adapter package.
 */
export function seedWorkspaceProvider(opts: { name: string; files: Record<string, string> }): WorkspaceProvider {
	const { name, files } = opts;
	const rootPath = `/mnt/${name}`;
	return {
		mountName: name,
		rootPath,
		async mount() {
			await ensureZenfs();
			zenMount(rootPath, InMemory.create({ label: name }));
			for (const rel of Object.keys(files).sort()) {
				const absolute = rel.startsWith("/") ? `${rootPath}${rel}` : `${rootPath}/${rel}`;
				if (absolute.includes("/../") || absolute.endsWith("/..") || !absolute.startsWith(`${rootPath}/`)) {
					throw new Error(`unsafe seed path: ${rel}`);
				}
				const slash = absolute.lastIndexOf("/");
				if (slash > rootPath.length) {
					try {
						await zenFs.promises.mkdir(absolute.slice(0, slash), { recursive: true });
					} catch (err) {
						if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
					}
				}
				await zenFs.promises.writeFile(absolute, files[rel] ?? "", { encoding: "utf-8" });
			}
		},
		toData() {
			return { kind: "seed", name, files };
		},
	};
}

/** Wire-side ↔ provider helper used by the worker after receiving `InitMessage`. */
export function workspaceProviderFromData(data: WorkspaceData): WorkspaceProvider {
	if (data.kind === "fsa") return fsaWorkspaceProvider({ handle: data.handle, name: data.name });
	return seedWorkspaceProvider({ name: data.name, files: data.files });
}

let zenfsConfigured = false;
async function ensureZenfs(): Promise<void> {
	if (zenfsConfigured) return;
	await configure({ mounts: {} });
	zenfsConfigured = true;
}
