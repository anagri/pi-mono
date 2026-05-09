import type { Page } from "@playwright/test";

/**
 * Inject a workspace seed via `addInitScript` so the bootstrap step picks it
 * up before Chrome's File System Access dialog would otherwise be shown. The
 * worker mounts a ZenFS InMemory backend at `/mnt/<name>` and seeds the files.
 *
 * Also sets `__bodhiPiWebRecordEvents` so the bootstrap returns
 * `recordEvents: true` in `BootstrapResult`. The recording flag is independent
 * of FSA-vs-seed at the worker level (production interfaces never carry test
 * concerns), but Playwright always wants both — so the helper sets both.
 *
 * Pattern lifted from `BodhiSearch/web-acp/e2e/helpers/install-volumes.ts`.
 */
export interface WorkspaceSeed {
	name: string;
	files: Record<string, string>;
}

export async function seedWorkspace(page: Page, seed: WorkspaceSeed): Promise<void> {
	await page.addInitScript((s: WorkspaceSeed) => {
		const w = window as unknown as { __bodhiPiWebSeed: WorkspaceSeed; __bodhiPiWebRecordEvents: boolean };
		w.__bodhiPiWebSeed = s;
		w.__bodhiPiWebRecordEvents = true;
	}, seed);
}

/** Default seed used when a spec just needs *some* mounted folder. */
export const DEFAULT_SEED: WorkspaceSeed = { name: "demo", files: { "/readme.txt": "hello" } };
