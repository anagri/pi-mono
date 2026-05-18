import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = path.resolve(here, "..", "data");

export async function loadScenarioFiles(name: string): Promise<Record<string, string>> {
	const root = path.join(DATA_ROOT, name);
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
