import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionFactory, RegisteredExtension } from "@/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = path.resolve(here, "../data");

const SUPPORTED_FLAT = new Set([".js", ".mjs", ".cjs"]);

/**
 * Resolve the absolute path of a fixture's `.bodhi-pi/` source folder. Tests
 * pass the fixture name; the harness lives at `<repo>/packages/bodhi-pi/e2e/`
 * so the data root is its `data/` sibling.
 */
export function fixtureBodhiPiDir(fixtureName: string): string {
	return path.join(DATA_ROOT, fixtureName, ".bodhi-pi");
}

/**
 * Phase-1 in-memory loader: walks `<data>/<fixture>/.bodhi-pi/extensions/` for
 * flat `.js`/`.mjs`/`.cjs` files and dynamic-imports each one from its
 * monorepo location. Imports resolve from the source path so the .js can
 * (in the future) `import` from npm packages via the monorepo's node_modules.
 *
 * Phase 4 replaces this with the richer `createNodePackageExtensionLoader`
 * that also handles directory entries with `package.json`.
 */
export async function loadFixtureFactoriesFromSource(fixtureName: string): Promise<RegisteredExtension[]> {
	const extDir = path.join(fixtureBodhiPiDir(fixtureName), "extensions");
	let entries: string[];
	try {
		entries = await fs.readdir(extDir);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw err;
	}

	const result: RegisteredExtension[] = [];
	for (const filename of entries.sort()) {
		const ext = path.extname(filename).toLowerCase();
		if (!SUPPORTED_FLAT.has(ext)) continue;
		const name = path.basename(filename, ext);
		const filePath = path.join(extDir, filename);
		const mod = (await import(pathToFileURL(filePath).href)) as { default?: unknown };
		const factory = mod.default ?? mod;
		if (typeof factory !== "function") {
			throw new Error(`bodhiPiFixture '${fixtureName}': ${filename} default export is not a function`);
		}
		result.push({ name, factory: factory as ExtensionFactory });
	}
	return result;
}
