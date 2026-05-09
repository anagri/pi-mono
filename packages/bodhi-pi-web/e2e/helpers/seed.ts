import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

const DATA_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "data");

/**
 * Walk `e2e/data/<name>/` recursively and return a flat
 * `Record<seedPath, utf8Content>` ready to plug into `WorkspaceSeed.files`.
 * Each `seedPath` is the file's path relative to the scenario root, with a
 * leading slash and forward slashes — i.e. the same shape `seedWorkspaceProvider`
 * expects when it mounts the ZenFS InMemory backend at `/mnt/<seed.name>`.
 *
 * Mirror of cli's `test/fixtures/<scenario>/` pattern: scenario bytes live on
 * disk (one source of truth, easy to inspect) instead of being inlined as JS
 * string literals across spec files.
 */
export function loadScenario(name: string): Record<string, string> {
	const root = path.join(DATA_ROOT, name);
	const out: Record<string, string> = {};
	const walk = (abs: string) => {
		for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
			const child = path.join(abs, entry.name);
			if (entry.isDirectory()) walk(child);
			else if (entry.isFile()) {
				const rel = `/${path.relative(root, child).split(path.sep).join("/")}`;
				out[rel] = fs.readFileSync(child, "utf8");
			}
		}
	};
	walk(root);
	return out;
}

/** Default seed used when a spec just needs *some* mounted folder. */
export const DEFAULT_SEED: WorkspaceSeed = { name: "demo", files: loadScenario("default") };
