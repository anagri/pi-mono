import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionFactory, RegisteredExtension } from "@/index.js";

export interface NodeExtensionLoaderOptions {
	cwd: string;
	extensionsDir?: string;
}

const SUPPORTED = new Set([".js", ".mjs", ".cjs"]);

export async function createNodeExtensionLoader(opts: NodeExtensionLoaderOptions): Promise<RegisteredExtension[]> {
	const dir = path.resolve(opts.cwd, opts.extensionsDir ?? ".bodhi-pi/extensions");
	let entries: string[];
	try {
		entries = await fs.readdir(dir);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw err;
	}

	const result: RegisteredExtension[] = [];
	const seen = new Set<string>();

	for (const filename of entries.sort()) {
		const ext = path.extname(filename).toLowerCase();
		if (!SUPPORTED.has(ext)) continue;
		const name = path.basename(filename, ext);
		if (seen.has(name)) {
			console.warn(`[node-adapters] extension name collision: "${name}" already loaded; skipping ${filename}`);
			continue;
		}
		const filePath = path.join(dir, filename);
		try {
			const mod = await import(pathToFileURL(filePath).href);
			const factory = (mod as { default?: unknown })?.default ?? mod;
			if (typeof factory !== "function") {
				console.warn(`[node-adapters] extension ${filename}: default export is not a function — skipping`);
				continue;
			}
			seen.add(name);
			result.push({ name, factory: factory as ExtensionFactory });
		} catch (err) {
			console.error(`[node-adapters] failed to load extension ${filename}:`, err);
		}
	}

	return result;
}
