import type { Page } from "@playwright/test";

/**
 * Inject a workspace seed via `addInitScript` so the bootstrap step picks it
 * up before Chrome's File System Access dialog would otherwise be shown. The
 * worker mounts a ZenFS InMemory backend at `/mnt/<name>` and seeds the files.
 *
 * Pattern lifted from `BodhiSearch/web-acp/e2e/helpers/install-volumes.ts`.
 */
export interface WorkspaceSeed {
	name: string;
	files: Record<string, string>;
}

export async function seedWorkspace(page: Page, seed: WorkspaceSeed): Promise<void> {
	await page.addInitScript((s: WorkspaceSeed) => {
		(window as unknown as { __bodhiPiWebSeed: WorkspaceSeed }).__bodhiPiWebSeed = s;
	}, seed);
}

/** Default seed used when a spec just needs *some* mounted folder. */
export const DEFAULT_SEED: WorkspaceSeed = { name: "demo", files: { "/readme.txt": "hello" } };
