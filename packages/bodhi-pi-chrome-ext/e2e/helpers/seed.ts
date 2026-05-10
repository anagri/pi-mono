import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";

// `__bodhiPiWebSeed` is the only sanctioned whitebox bridge in this e2e suite —
// no DOM affordance can replace Chrome's File System Access picker bypass.
export interface WorkspaceSeed {
	name: string;
	files: Record<string, string>;
}

export async function seedWorkspace(page: Page, seed: WorkspaceSeed): Promise<void> {
	await page.addInitScript((s: WorkspaceSeed) => {
		const w = window as unknown as { __bodhiPiWebSeed: WorkspaceSeed };
		w.__bodhiPiWebSeed = s;
	}, seed);
}

const DATA_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "data");

// Returned shape matches `seedWorkspaceProvider`'s expected `files` map:
// keys are paths relative to the scenario root with a leading slash.
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
