import { dirname, join } from "pathe";
import { isPlainObject } from "@/_internal/object.js";
import type { Filesystem } from "@/filesystem/filesystem.js";
import { type BodhiPiProjectSettings, GLOBAL_SETTINGS_PATH, loadProjectSettings, SETTINGS_PATH } from "./settings.js";
import { loadGlobalSettings } from "./settings-global.js";

export type SettingsScope = "global" | "project" | "session";

/** Parse `"a.b.c"` into `["a","b","c"]`. Empty/invalid → []. */
export function parseDottedKey(key: string): string[] {
	if (!key) return [];
	return key.split(".").filter((p) => p.length > 0);
}

/** Build a nested object from a dotted path and value. `setAt({}, ["a","b"], 1)` → `{ a: { b: 1 } }`. */
export function setAt(target: Record<string, unknown>, path: string[], value: unknown): Record<string, unknown> {
	if (path.length === 0) return target;
	const root = { ...target };
	let cur = root;
	for (let i = 0; i < path.length - 1; i++) {
		const key = path[i];
		const existing = cur[key];
		const next = isPlainObject(existing) ? { ...existing } : {};
		cur[key] = next;
		cur = next;
	}
	cur[path[path.length - 1]] = value;
	return root;
}

/** Delete a dotted path in-place on a clone. Returns the clone. */
export function unsetAt(target: Record<string, unknown>, path: string[]): Record<string, unknown> {
	if (path.length === 0) return target;
	const root = { ...target };
	let cur: Record<string, unknown> = root;
	for (let i = 0; i < path.length - 1; i++) {
		const next = cur[path[i]];
		if (!isPlainObject(next)) return root;
		const cloned = { ...next };
		cur[path[i]] = cloned;
		cur = cloned;
	}
	delete cur[path[path.length - 1]];
	return root;
}

/** Read a dotted path. Returns `undefined` if any segment is missing. */
export function getAt(target: Record<string, unknown>, path: string[]): unknown {
	let cur: unknown = target;
	for (const seg of path) {
		if (!isPlainObject(cur)) return undefined;
		cur = cur[seg];
	}
	return cur;
}

/** Try JSON.parse; on failure return the raw string. Used for `/settings set` value parsing. */
export function parseSettingValue(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
}

async function writeJsonAt(fs: Filesystem, filePath: string, value: BodhiPiProjectSettings): Promise<void> {
	const dir = dirname(filePath);
	await fs.mkdir(dir, { recursive: true });
	await fs.writeTextFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function projectPath(cwd: string): string {
	return join(cwd, SETTINGS_PATH);
}

function globalPath(homeDir: string): string {
	return join(homeDir, GLOBAL_SETTINGS_PATH);
}

export async function writeProjectSetting(
	fs: Filesystem,
	cwd: string,
	dottedKey: string,
	value: unknown,
): Promise<BodhiPiProjectSettings> {
	const existing = await loadProjectSettings(fs, cwd);
	const updated = setAt(existing.settings as Record<string, unknown>, parseDottedKey(dottedKey), value);
	await writeJsonAt(fs, projectPath(cwd), updated as BodhiPiProjectSettings);
	return updated as BodhiPiProjectSettings;
}

export async function unsetProjectSetting(
	fs: Filesystem,
	cwd: string,
	dottedKey: string,
): Promise<BodhiPiProjectSettings> {
	const existing = await loadProjectSettings(fs, cwd);
	const updated = unsetAt(existing.settings as Record<string, unknown>, parseDottedKey(dottedKey));
	await writeJsonAt(fs, projectPath(cwd), updated as BodhiPiProjectSettings);
	return updated as BodhiPiProjectSettings;
}

export async function writeGlobalSetting(
	fs: Filesystem,
	homeDir: string,
	dottedKey: string,
	value: unknown,
): Promise<BodhiPiProjectSettings> {
	const existing = await loadGlobalSettings(fs, homeDir);
	const updated = setAt(existing.settings as Record<string, unknown>, parseDottedKey(dottedKey), value);
	await writeJsonAt(fs, globalPath(homeDir), updated as BodhiPiProjectSettings);
	return updated as BodhiPiProjectSettings;
}

export async function unsetGlobalSetting(
	fs: Filesystem,
	homeDir: string,
	dottedKey: string,
): Promise<BodhiPiProjectSettings> {
	const existing = await loadGlobalSettings(fs, homeDir);
	const updated = unsetAt(existing.settings as Record<string, unknown>, parseDottedKey(dottedKey));
	await writeJsonAt(fs, globalPath(homeDir), updated as BodhiPiProjectSettings);
	return updated as BodhiPiProjectSettings;
}
