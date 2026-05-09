import type { ExtensionFactory, Filesystem, RegisteredExtension } from "@bodhiapp/bodhi-pi";

export interface BrowserExtensionLoaderOptions {
	/**
	 * Bodhi-pi `Filesystem` to read source from. In typical browser hosts this
	 * is the `createZenfsFilesystem()` instance (FSA-mounted or seeded).
	 */
	filesystem: Filesystem;
	/** Project root inside the mounted filesystem (e.g. `/mnt/<name>`). */
	cwd: string;
	/** Optional override; defaults to ".bodhi-pi/extensions". */
	extensionsDir?: string;
}

const SUPPORTED = new Set([".js", ".mjs"]);

function joinPosix(...parts: string[]): string {
	return parts.join("/").replace(/\/+/g, "/").replace(/\/$/, "");
}

/**
 * Browser counterpart to `createNodeExtensionLoader`. Reads JS source files from
 * the injected `Filesystem` and dynamic-imports them via `data:text/javascript;base64,…`.
 *
 * **JS-only** — TypeScript source is not supported here. TS support requires
 * `esbuild-wasm` (or similar in-browser transform); deferred until a real use
 * case appears.
 *
 * **CSP**: `import("data:text/javascript;base64,…")` works without `unsafe-eval`
 * because it uses native ESM evaluation. Hosts with strict `script-src` may need
 * to add `'self' data:` or relax accordingly.
 */
export async function createBrowserExtensionLoader(
	opts: BrowserExtensionLoaderOptions,
): Promise<RegisteredExtension[]> {
	const dir = joinPosix(opts.cwd, opts.extensionsDir ?? ".bodhi-pi/extensions");
	if (!(await opts.filesystem.exists(dir))) return [];

	let entries: { name: string; isFile: boolean; isDirectory: boolean }[];
	try {
		entries = await opts.filesystem.list(dir);
	} catch (err) {
		console.error(`[bodhi-pi-browser] failed to list ${dir}:`, err);
		return [];
	}

	const result: RegisteredExtension[] = [];
	const seen = new Set<string>();

	const sorted = [...entries].filter((e) => e.isFile).sort((a, b) => a.name.localeCompare(b.name));

	for (const file of sorted) {
		const lower = file.name.toLowerCase();
		const ext = lower.slice(lower.lastIndexOf("."));
		if (!SUPPORTED.has(ext)) continue;
		const baseName = file.name.slice(0, file.name.length - ext.length);
		if (seen.has(baseName)) {
			console.warn(
				`[bodhi-pi-browser] extension name collision: "${baseName}" already loaded; skipping ${file.name}`,
			);
			continue;
		}
		const filePath = joinPosix(dir, file.name);
		try {
			const source = await opts.filesystem.readTextFile(filePath);
			// btoa requires a binary string (1 byte per code unit); we map UTF-8 bytes
			// 1:1 into latin1 code points (0x00–0xFF) so non-ASCII source survives the
			// round-trip via a `data:text/javascript;base64,…` URL.
			const bytes = new TextEncoder().encode(source);
			const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
			const dataUrl = `data:text/javascript;base64,${btoa(binary)}`;
			const mod = await import(/* @vite-ignore */ dataUrl);
			const factory = (mod as { default?: unknown })?.default ?? mod;
			if (typeof factory !== "function") {
				console.warn(`[bodhi-pi-browser] extension ${file.name}: default export is not a function — skipping`);
				continue;
			}
			seen.add(baseName);
			result.push({ name: baseName, factory: factory as ExtensionFactory });
		} catch (err) {
			console.error(`[bodhi-pi-browser] failed to load extension ${file.name}:`, err);
		}
	}

	return result;
}
