export type AgentMode = "ask" | "plan" | "edit" | "allow-all";

export const ALL_AGENT_MODES: readonly AgentMode[] = ["ask", "plan", "edit", "allow-all"] as const;

export const MODES_BY_PERMISSIVENESS: readonly AgentMode[] = ["plan", "ask", "edit", "allow-all"] as const;

export const DEFAULT_AGENT_MODE: AgentMode = "ask";

export interface ModeDisplay {
	name: string;
	description: string;
}

export const MODE_DISPLAY: Record<AgentMode, ModeDisplay> = {
	ask: {
		name: "Ask",
		description: "Request permission for edits, shell, MCP, sub-agents",
	},
	plan: {
		name: "Plan",
		description: "Read-only — explore and propose without touching the workspace",
	},
	edit: {
		name: "Edit",
		description: "Allow file edits; still ask for shell, MCP, sub-agents",
	},
	"allow-all": {
		name: "Allow All",
		description: "Run every tool without asking (use with care)",
	},
};

export type ToolCategory = "read" | "edit" | "search" | "execute" | "mcp" | "subagent" | "other";

export const ALL_TOOL_CATEGORIES: readonly ToolCategory[] = [
	"read",
	"edit",
	"search",
	"execute",
	"mcp",
	"subagent",
	"other",
] as const;

export type PermissionDecision = "allow" | "ask" | "deny";

export type PermissionPattern = string;

export interface PermissionPolicy {
	categories: Partial<Record<ToolCategory, PermissionDecision>>;
	tools: Record<PermissionPattern, PermissionDecision>;
	alwaysAllow: PermissionPattern[];
	alwaysDeny: PermissionPattern[];
}

export interface ModePreset {
	mode: AgentMode;
	description: string;
	policy: PermissionPolicy;
	systemPromptSuffix?: string;
}

export type ApprovalDecision = { kind: "allow" } | { kind: "deny"; reason: string };

export type PermissionGrant = "allow" | "deny";

export interface ModeRuntimeCapabilities {
	allowsAllowAllMode: boolean;
	allowsAllowAllModeAsDefault: boolean;
}

export type ModeChangeReason = "user" | "session_load" | "submit_plan_approved" | "settings_change" | "subagent_spawn";

export function isAgentMode(value: unknown): value is AgentMode {
	return typeof value === "string" && (ALL_AGENT_MODES as readonly string[]).includes(value);
}
