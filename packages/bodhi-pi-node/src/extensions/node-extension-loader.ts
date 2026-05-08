import fs from "node:fs/promises";
import path from "node:path";
import type { ExtensionFactory, RegisteredExtension } from "@bodhiapp/bodhi-pi";
import { createJiti } from "jiti";

export interface NodeExtensionLoaderOptions {
	/**
	 * Project root. The loader walks `<cwd>/.bodhi-pi/extensions/*.{ts,js,mjs,cjs}`.
	 */
	cwd: string;
	/**
	 * Optional override of the directory under `cwd` to search.
	 * Defaults to ".bodhi-pi/extensions".
	 */
	extensionsDir?: string;
}

const SUPPORTED = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);

/**
 * Discover and load extensions from `<cwd>/.bodhi-pi/extensions/*.{ts,js}` via jiti.
 *
 * Behaviour mirrors web-acp-agent's prior loader:
 *   - First-wins on filename collision (here: deterministic by readdir order).
 *   - A bad extension (parse error, missing default export, factory throws at load)
 *     is logged + skipped — peer extensions are unaffected.
 *
 * jiti requires `node:fs` + `node:vm`; it does not work in browsers. The browser
 * counterpart lives in `@bodhiapp/bodhi-pi-browser`.
 */
export async function createNodeExtensionLoader(opts: NodeExtensionLoaderOptions): Promise<RegisteredExtension[]> {
	const dir = path.resolve(opts.cwd, opts.extensionsDir ?? ".bodhi-pi/extensions");
	let entries: string[];
	try {
		entries = await fs.readdir(dir);
	} catch (err) {
		// Missing directory is normal — extensions are optional.
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw err;
	}

	const jiti = createJiti(opts.cwd, { interopDefault: true, fsCache: false, moduleCache: false });
	const result: RegisteredExtension[] = [];
	const seen = new Set<string>();

	for (const filename of entries.sort()) {
		const ext = path.extname(filename).toLowerCase();
		if (!SUPPORTED.has(ext)) continue;
		const name = path.basename(filename, ext);
		if (seen.has(name)) {
			// First wins; log + skip.
			console.warn(`[bodhi-pi-node] extension name collision: "${name}" already loaded; skipping ${filename}`);
			continue;
		}
		const filePath = path.join(dir, filename);
		try {
			const mod = await jiti.import<unknown>(filePath);
			const factory = (mod as { default?: unknown })?.default ?? mod;
			if (typeof factory !== "function") {
				console.warn(`[bodhi-pi-node] extension ${filename}: default export is not a function — skipping`);
				continue;
			}
			seen.add(name);
			result.push({ name, factory: factory as ExtensionFactory });
		} catch (err) {
			console.error(`[bodhi-pi-node] failed to load extension ${filename}:`, err);
		}
	}

	return result;
}
