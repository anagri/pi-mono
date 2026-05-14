import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function loadScenario(name: string): Record<string, string> {
	const here = path.dirname(fileURLToPath(import.meta.url));
	const root = path.join(here, "..", "data", name);
	const out: Record<string, string> = {};
	const walk = (abs: string) => {
		for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
			const child = path.join(abs, entry.name);
			if (entry.isDirectory()) walk(child);
			else if (entry.isFile()) {
				const rel = path.relative(root, child).split(path.sep).join("/");
				out[rel] = fs.readFileSync(child, "utf8");
			}
		}
	};
	walk(root);
	return out;
}
