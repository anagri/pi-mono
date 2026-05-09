import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DATA_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "data");

/**
 * Walk `e2e/data/<name>/` recursively and return a flat
 * `Record<seedPath, utf8Content>`. Each `seedPath` is the file's path relative
 * to the scenario root with a leading slash and forward slashes.
 *
 * Mirrors `bodhi-pi-web/e2e/helpers/seed.ts:44-59`. Different consumer here:
 * `spawnTestServer` materializes the entries onto disk under a tmpdir which
 * the ws-server then uses as the agent's cwd via `--workspace`.
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

/**
 * Materialize a flat `{ "/relative/path": "utf8 contents" }` map onto disk
 * under `root`. Used by `spawnTestServer` to seed a tmpdir before launching
 * the ws-server.
 */
export function writeFiles(root: string, files: Record<string, string>): void {
	for (const [rel, content] of Object.entries(files)) {
		const abs = path.join(root, rel.startsWith("/") ? rel.slice(1) : rel);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, content, "utf8");
	}
}
