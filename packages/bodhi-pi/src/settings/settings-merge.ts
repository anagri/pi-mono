import { isPlainObject } from "@/_internal/object.js";
import type { BodhiPiProjectSettings } from "./settings.js";

/** One-level deep merge; `undefined` in overrides inherits from base. */
export function mergeSettings(base: BodhiPiProjectSettings, overrides: BodhiPiProjectSettings): BodhiPiProjectSettings {
	const result: Record<string, unknown> = { ...base };
	for (const [key, overrideValue] of Object.entries(overrides)) {
		if (overrideValue === undefined) continue;
		const baseValue = result[key];
		if (isPlainObject(baseValue) && isPlainObject(overrideValue)) {
			result[key] = { ...baseValue, ...overrideValue };
		} else {
			result[key] = overrideValue;
		}
	}
	return result as BodhiPiProjectSettings;
}
