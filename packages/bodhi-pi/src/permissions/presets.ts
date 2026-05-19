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

const PLAN_POLICY: PermissionPolicy = {
	categories: {
		read: "allow",
		search: "allow",
		subagent: "allow",
		edit: "deny",
		execute: "deny",
		other: "deny",
	},
	tools: {},
	alwaysAllow: [],
	alwaysDeny: [],
};

const PLAN_SYSTEM_PROMPT_SUFFIX = `You are operating in PLAN MODE.

Your job is to research and propose, not to implement. Use read-only tools
(read, ls, find, grep) and read-only MCP tools to explore the codebase. Use
the subagent tool to delegate focused research tasks. Do NOT call write,
edit, bash, or other mutating tools — they will be rejected.

When your analysis is complete, propose your plan to the user as natural
language text. The user will review and either ask you to revise (stay in
plan mode) or approve and switch to edit/allow-all mode for execution.`;

export const MODE_PRESETS: Record<AgentMode, ModePreset> = {
	ask: { mode: "ask", description: MODE_DISPLAY.ask.description, policy: EMPTY_POLICY },
	plan: {
		mode: "plan",
		description: MODE_DISPLAY.plan.description,
		policy: PLAN_POLICY,
		systemPromptSuffix: PLAN_SYSTEM_PROMPT_SUFFIX,
	},
	edit: { mode: "edit", description: MODE_DISPLAY.edit.description, policy: EMPTY_POLICY },
	"allow-all": {
		mode: "allow-all",
		description: MODE_DISPLAY["allow-all"].description,
		policy: ALLOW_ALL_POLICY,
	},
};
