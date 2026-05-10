import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DATA_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "data");

/**
 * Walk `e2e/playwright/data/<name>/` recursively → flat path-content map.
 * Mirrors `bodhi-pi-ws-frontend/e2e/helpers/seed.ts:5-47`.
 */
export function loadScenario(name: string): Record<string, string> {
	const root = path.join(DATA_ROOT, name);
	if (!fs.existsSync(root)) {
		throw new Error(`scenario "${name}" not found at ${root}`);
	}
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

export function writeFiles(root: string, files: Record<string, string>): void {
	for (const [rel, content] of Object.entries(files)) {
		const abs = path.join(root, rel.startsWith("/") ? rel.slice(1) : rel);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, content, "utf8");
	}
}
