import { join } from "pathe";
import type { Filesystem } from "@/filesystem/filesystem.js";
import { type BodhiPiProjectSettings, GLOBAL_SETTINGS_PATH, type ProjectSettingsResult } from "./settings.js";

/** Read `<homeDir>/.bodhi-pi/settings.json`. Node-only; browser hosts omit `homeDir`. Never throws. */
export async function loadGlobalSettings(fs: Filesystem, homeDir: string): Promise<ProjectSettingsResult> {
	const filePath = join(homeDir, GLOBAL_SETTINGS_PATH);
	if (!(await fs.exists(filePath))) {
		return { settings: {}, present: false };
	}
	let raw: string;
	try {
		raw = await fs.readTextFile(filePath);
	} catch (e) {
		return { settings: {}, present: false, parseError: `read failed: ${(e as Error).message}` };
	}
	try {
		const parsed = JSON.parse(raw) as BodhiPiProjectSettings;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return { settings: {}, present: true, parseError: "global settings.json must be a JSON object" };
		}
		return { settings: parsed, present: true };
	} catch (e) {
		return { settings: {}, present: true, parseError: `invalid JSON: ${(e as Error).message}` };
	}
}
