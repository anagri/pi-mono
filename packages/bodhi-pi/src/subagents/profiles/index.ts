import { byName } from "@/_internal/sort.js";
import type { SubagentProfile } from "../types.js";
import { EXPLORE_PROFILE } from "./explore.js";
import { PLANNER_PROFILE } from "./planner.js";

const BUILTIN_PROFILES: readonly SubagentProfile[] = [EXPLORE_PROFILE, PLANNER_PROFILE];

for (const p of BUILTIN_PROFILES) {
	if (p.disabled === true) {
		throw new Error(`built-in subagent profile '${p.name}' must not declare disabled:true`);
	}
	if (p.source !== "builtin") {
		throw new Error(`built-in subagent profile '${p.name}' must declare source:"builtin"`);
	}
}

export function getBuiltinSubagentProfiles(): SubagentProfile[] {
	return [...BUILTIN_PROFILES].sort(byName);
}
