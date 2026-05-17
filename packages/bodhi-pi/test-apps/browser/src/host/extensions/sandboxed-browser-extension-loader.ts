// Extended with tools / commands / providers proxies so the shared
// extensions.e2e.ts suite can exercise registerTool + registerProvider
// under MV3 CSP. See sandbox/sandbox-bridge.ts for the widened surface.

import type {
	BodhiPiEvent,
	BodhiPiEventType,
	ExtensionAPI,
	ExtensionFactory,
	Filesystem,
	RegisteredExtension,
} from "@bodhiapp/bodhi-pi";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";
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
 * re-attach `pi.on` / `pi.registerTool` / `pi.registerCommand` /
 * `pi.registerProvider` registrations as proxies that round-trip the
 * callbacks back to the sandbox.
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
			const load = await opts.bridge.loadExtension(source);
			seen.add(baseName);
			const factory: ExtensionFactory = async (pi: ExtensionAPI) => {
				for (const reg of load.registrations) {
					const eventType = reg.eventType as BodhiPiEventType;
					pi.on(eventType, async (event: BodhiPiEvent) => {
						const result = await opts.bridge.invokeHandler(reg.handlerId, sanitizeEvent(event));
						return result as never;
					});
				}
				for (const tool of load.tools) {
					pi.registerTool({
						name: tool.name,
						description: tool.description,
						parameters: tool.parameters as TSchema,
						execute: async (toolCallId, params) => {
							const r = await opts.bridge.invokeTool(tool.toolId, toolCallId, sanitizeEvent(params));
							return r as never;
						},
					});
				}
				for (const cmd of load.commands) {
					pi.registerCommand(cmd.name, {
						description: cmd.description,
						template: cmd.template,
						...(cmd.argumentHint !== undefined ? { argumentHint: cmd.argumentHint } : {}),
					});
				}
				for (const prov of load.providers) {
					pi.registerProvider(prov.name, {
						model: prov.model as Model<Api>,
						...(prov.hasGetApiKey
							? { getApiKey: (p: string) => opts.bridge.getProviderApiKey(prov.providerId, p) }
							: {}),
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
 * over `postMessage`. We pass through `JSON` to coerce to a structured-
 * cloneable plain shape; extension handlers/tools that stick to data fields
 * work unchanged.
 */
function sanitizeEvent(event: unknown): unknown {
	try {
		return JSON.parse(JSON.stringify(event));
	} catch {
		return undefined;
	}
}
