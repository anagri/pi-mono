// Duplicated from packages/bodhi-pi/e2e/helpers/extension-loaders/node-package-loader.ts.
// test-apps/ is standalone — it must not import from e2e/. Keep this surface
// in lockstep with the e2e copy.

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionFactory, RegisteredExtension } from "@bodhiapp/bodhi-pi";
import { createJiti } from "jiti";

const FLAT_EXTS = new Set([".js", ".mjs", ".cjs"]);

export interface NodePackageLoaderOptions {
	cwd: string;
	extensionsDir?: string;
}

interface PiManifest {
	extensions?: string[];
}

interface PackageJsonShape {
	pi?: PiManifest;
}

export async function createNodePackageExtensionLoader(opts: NodePackageLoaderOptions): Promise<RegisteredExtension[]> {
	const dir = path.resolve(opts.cwd, opts.extensionsDir ?? ".bodhi-pi/extensions");
	let entries: { name: string; isDir: boolean }[];
	try {
		const dirents = await fs.readdir(dir, { withFileTypes: true });
		entries = dirents.map((d) => ({ name: d.name, isDir: d.isDirectory() }));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw err;
	}

	const jiti = createJiti(import.meta.url, { interopDefault: true });
	const result: RegisteredExtension[] = [];
	const seen = new Set<string>();

	for (const { name, isDir } of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		const fullPath = path.join(dir, name);
		if (isDir) {
			const loaded = await loadDirectoryExtension(fullPath, jiti);
			if (loaded && !seen.has(loaded.name)) {
				seen.add(loaded.name);
				result.push(loaded);
			}
			continue;
		}
		const ext = path.extname(name).toLowerCase();
		if (!FLAT_EXTS.has(ext)) continue;
		const extensionName = path.basename(name, ext);
		if (seen.has(extensionName)) {
			console.warn(`[node-package-loader] name collision: "${extensionName}" already loaded; skipping ${name}`);
			continue;
		}
		const factory = await loadModuleDefault(fullPath);
		if (!factory) continue;
		seen.add(extensionName);
		result.push({ name: extensionName, factory });
	}
	return result;
}

async function loadDirectoryExtension(
	dir: string,
	jiti: ReturnType<typeof createJiti>,
): Promise<RegisteredExtension | undefined> {
	const name = path.basename(dir);
	const pkgPath = path.join(dir, "package.json");
	let manifest: PackageJsonShape | undefined;
	try {
		manifest = JSON.parse(await fs.readFile(pkgPath, "utf-8")) as PackageJsonShape;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			console.error(`[node-package-loader] failed to read ${pkgPath}:`, err);
		}
	}

	const candidates: string[] = [];
	if (manifest?.pi?.extensions?.length) {
		for (const rel of manifest.pi.extensions) candidates.push(path.resolve(dir, rel));
	} else {
		for (const conv of ["index.ts", "index.js", "index.mjs"]) candidates.push(path.join(dir, conv));
	}

	for (const candidate of candidates) {
		try {
			await fs.access(candidate);
		} catch {
			continue;
		}
		const factory = await loadModuleDefault(candidate, jiti);
		if (factory) return { name, factory };
	}

	console.warn(`[node-package-loader] no loadable entry found for extension directory ${dir}`);
	return undefined;
}

async function loadModuleDefault(
	filePath: string,
	jiti?: ReturnType<typeof createJiti>,
): Promise<ExtensionFactory | undefined> {
	const ext = path.extname(filePath).toLowerCase();
	// Resolve symlinks so Node's CJS resolver walks node_modules from the real
	// location, not the symlinked path.
	const realPath = await fs.realpath(filePath);
	try {
		let mod: unknown;
		if (ext === ".ts" || ext === ".tsx") {
			if (!jiti) throw new Error("ts entry requires jiti");
			mod = await jiti.import(realPath, { default: true });
		} else {
			const imported = (await import(pathToFileURL(realPath).href)) as { default?: unknown };
			mod = imported.default ?? imported;
		}
		if (typeof mod !== "function") {
			console.warn(`[node-package-loader] ${filePath}: default export is not a function — skipping`);
			return undefined;
		}
		return mod as ExtensionFactory;
	} catch (err) {
		console.error(`[node-package-loader] failed to load ${filePath}:`, err);
		return undefined;
	}
}
