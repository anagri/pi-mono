import type { SessionEntry } from "@/sessions/session-store.js";

export const SUBAGENT_FORK_FILTER: Set<SessionEntry["type"]> = new Set([
	"mcp_inclusion_set",
	"extension",
	"subagent_link",
	"subagent_complete",
]);
