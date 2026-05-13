import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RegisteredExtension } from "@/index.js";
import { createNodePackageExtensionLoader } from "./extension-loaders/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = path.resolve(here, "../data");

export function fixtureBodhiPiDir(fixtureName: string): string {
	return path.join(DATA_ROOT, fixtureName, ".bodhi-pi");
}

/**
 * In-memory loader: walks `<data>/<fixture>/.bodhi-pi/extensions/` for both
 * flat `.js`/`.mjs`/`.cjs` files and directory entries (with optional
 * `package.json` declaring `pi.extensions`). Imports resolve from the source
 * path so package-mode extensions can `import` from npm packages via the
 * monorepo's node_modules.
 */
export async function loadFixtureFactoriesFromSource(fixtureName: string): Promise<RegisteredExtension[]> {
	return createNodePackageExtensionLoader({ cwd: fixtureBodhiPiDir(fixtureName), extensionsDir: "extensions" });
}
