// ported from packages/bodhi-pi-browser/src/extensions/browser-extension-loader.ts
import type { ExtensionFactory, Filesystem, RegisteredExtension } from "@bodhiapp/bodhi-pi";

export interface BrowserExtensionLoaderOptions {
	filesystem: Filesystem;
	cwd: string;
	extensionsDir?: string;
}

const SUPPORTED = new Set([".js", ".mjs"]);

function joinPosix(...parts: string[]): string {
	return parts.join("/").replace(/\/+/g, "/").replace(/\/$/, "");
}

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
