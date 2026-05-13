// ported from packages/bodhi-pi-browser/src/extensions/sandboxed-browser-extension-loader.ts

import type {
	BodhiPiEvent,
	BodhiPiEventType,
	ExtensionAPI,
	ExtensionFactory,
	Filesystem,
	RegisteredExtension,
} from "@bodhiapp/bodhi-pi";
import type { SandboxBridge } from "../sandbox/sandbox-bridge.js";

export interface SandboxedExtensionLoaderOptions {
	filesystem: Filesystem;
	cwd: string;
	bridge: SandboxBridge;
	extensionsDir?: string;
}

const SUPPORTED = new Set([".js", ".mjs"]);

function joinPosix(...parts: string[]): string {
	return parts.join("/").replace(/\/+/g, "/").replace(/\/$/, "");
}

/**
 * Sandbox-bridge counterpart to `createBrowserExtensionLoader`. Reads
 * extension source from the filesystem, ships it to a sandboxed iframe for
 * dynamic evaluation, and returns `RegisteredExtension`s whose factories
 * re-attach `pi.on` handlers that round-trip back to the sandbox.
 *
 * `pi.on` is the only `ExtensionAPI` surface proxied today — the redact-
 * secrets extension and our existing tests need nothing more. Other surfaces
 * (`registerTool`, `registerCommand`, `registerProvider`, `events`, …) throw
 * inside the sandbox so a misuse surfaces during load rather than silently.
 */
export async function createSandboxedBrowserExtensionLoader(
	opts: SandboxedExtensionLoaderOptions,
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
			const { registrations } = await opts.bridge.loadExtension(source);
			seen.add(baseName);
			const factory: ExtensionFactory = async (pi: ExtensionAPI) => {
				for (const reg of registrations) {
					const eventType = reg.eventType as BodhiPiEventType;
					pi.on(eventType, async (event: BodhiPiEvent) => {
						const result = await opts.bridge.invokeHandler(reg.handlerId, sanitizeEvent(event));
						return result as never;
					});
				}
			};
			result.push({ name: baseName, factory });
		} catch (err) {
			console.error(`[bodhi-pi-browser] failed to load extension ${file.name}:`, err);
		}
	}

	return result;
}

/**
 * Strip non-cloneable members (functions, AbortSignal, etc.) before sending
 * the event to the sandbox via `postMessage`. We pass it through `JSON` to
 * coerce to a structured-cloneable plain shape; extension handlers that
 * stick to data fields (like redact-secrets) work unchanged.
 */
function sanitizeEvent(event: unknown): unknown {
	try {
		return JSON.parse(JSON.stringify(event));
	} catch {
		return undefined;
	}
}
