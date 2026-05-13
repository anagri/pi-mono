// InMemory ZenFS mount for the test workspace. Agent (in the worker, once
// Phase 3 wires it) and the page-side slash router (/file, /exists) both
// read through the same mount; seeded content is visible to the agent, and
// in-tool writes the agent makes are observable to the harness through the
// slash router. Pattern mirrors bodhi-pi-browser/src/workspace/provider.ts:63
// (seedWorkspaceProvider) — InMemory.create + zenMount via @zenfs/core.

import { configure, fs, InMemory, mount } from "@zenfs/core";

export const WORKSPACE_NAME = "test-workspace";
export const WORKSPACE_ROOT = `/mnt/${WORKSPACE_NAME}`;

let mounted = false;

export async function mountWorkspace(seedFiles: Record<string, string>): Promise<void> {
	if (mounted) {
		throw new Error("workspace already mounted");
	}
	await configure({ mounts: {} });
	mount(WORKSPACE_ROOT, InMemory.create({ label: WORKSPACE_NAME }));
	mounted = true;
	for (const relPath of Object.keys(seedFiles).sort()) {
		const abs = `${WORKSPACE_ROOT}/${relPath}`;
		const slash = abs.lastIndexOf("/");
		if (slash > WORKSPACE_ROOT.length) {
			await fs.promises.mkdir(abs.slice(0, slash), { recursive: true });
		}
		await fs.promises.writeFile(abs, seedFiles[relPath] ?? "", { encoding: "utf-8" });
	}
}

export async function readWorkspaceFile(absPath: string): Promise<string> {
	const buf = await fs.promises.readFile(absPath, "utf-8");
	return typeof buf === "string" ? buf : String(buf);
}

export async function workspaceFileExists(absPath: string): Promise<boolean> {
	try {
		await fs.promises.access(absPath);
		return true;
	} catch {
		return false;
	}
}
