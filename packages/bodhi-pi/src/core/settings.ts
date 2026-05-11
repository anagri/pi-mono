import path from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { Filesystem } from "@/filesystem/filesystem.js";
import type { CompactionSettings } from "@/sessions/compaction.js";

export const SETTINGS_PATH = ".bodhi-pi/settings.json";
/** Path under the user's home where the global layer lives (Node hosts only). */
export const GLOBAL_SETTINGS_PATH = ".bodhi-pi/settings.json";

/** Per-provider stream options (retry / timeout). Threaded into pi-ai SimpleStreamOptions. */
export interface ProviderOptionsEntry {
	maxRetries?: number;
	timeoutMs?: number;
	maxRetryDelayMs?: number;
}

/** Default retry behavior applied when a specific provider isn't called out. */
export interface RetrySettings {
	maxRetries?: number;
	baseDelayMs?: number;
	maxDelayMs?: number;
	enabled?: boolean;
}

export interface BodhiPiProjectSettings {
	compaction?: Partial<CompactionSettings>;
	appendSystemPrompt?: string;
	defaultThinkingLevel?: ModelThinkingLevel;
	providerOptions?: Record<string, ProviderOptionsEntry>;
	retry?: RetrySettings;
	/** Unknown keys are preserved here so /config can surface them for debugging. */
	[key: string]: unknown;
}

export interface ProjectSettingsResult {
	settings: BodhiPiProjectSettings;
	present: boolean;
	parseError?: string;
}

/**
 * Read `<cwd>/.bodhi-pi/settings.json` via the injected Filesystem.
 * Missing file → `{ settings: {}, present: false }`. Parse error → empty
 * settings with `parseError` set; never throws.
 */
export async function loadProjectSettings(fs: Filesystem, cwd: string): Promise<ProjectSettingsResult> {
	const filePath = path.posix.join(cwd, SETTINGS_PATH);
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
			return { settings: {}, present: true, parseError: "settings.json must be a JSON object" };
		}
		return { settings: parsed, present: true };
	} catch (e) {
		return { settings: {}, present: true, parseError: `invalid JSON: ${(e as Error).message}` };
	}
}
