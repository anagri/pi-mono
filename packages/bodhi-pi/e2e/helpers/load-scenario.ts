import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SHARED_ROOT = path.resolve(here, "..", "..", "scenarios");
const LOCAL_ROOT = path.resolve(here, "..", "data");

export async function loadScenarioFiles(name: string): Promise<Record<string, string>> {
	const sharedRoot = path.join(SHARED_ROOT, name);
	const localRoot = path.join(LOCAL_ROOT, name);
	const root = existsSync(sharedRoot) ? sharedRoot : localRoot;
	const out: Record<string, string> = {};
	async function walk(absDir: string, relDir: string): Promise<void> {
		const entries = await fs.readdir(absDir, { withFileTypes: true });
		for (const entry of entries) {
			const childAbs = path.join(absDir, entry.name);
			const childRel = relDir ? `${relDir}/${entry.name}` : entry.name;
			if (entry.isDirectory()) await walk(childAbs, childRel);
			else if (entry.isFile()) out[childRel] = await fs.readFile(childAbs, "utf-8");
		}
	}
	await walk(root, "");
	return out;
}
