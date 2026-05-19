import { type AgentMode, MODE_DISPLAY, type ModePreset, type PermissionPolicy } from "./types.js";

const EMPTY_POLICY: PermissionPolicy = {
	categories: {},
	tools: {},
	alwaysAllow: [],
	alwaysDeny: [],
};

const ALLOW_ALL_POLICY: PermissionPolicy = {
	categories: { read: "allow", edit: "allow", search: "allow", execute: "allow", mcp: "allow", subagent: "allow" },
	tools: {},
	alwaysAllow: [],
	alwaysDeny: [],
};

export const MODE_PRESETS: Record<AgentMode, ModePreset> = {
	ask: { mode: "ask", description: MODE_DISPLAY.ask.description, policy: EMPTY_POLICY },
	plan: { mode: "plan", description: MODE_DISPLAY.plan.description, policy: EMPTY_POLICY },
	edit: { mode: "edit", description: MODE_DISPLAY.edit.description, policy: EMPTY_POLICY },
	"allow-all": {
		mode: "allow-all",
		description: MODE_DISPLAY["allow-all"].description,
		policy: ALLOW_ALL_POLICY,
	},
};
