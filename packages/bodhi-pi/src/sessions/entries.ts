import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

/**
 * `parentId` forms the conversation DAG. Optional during the Phase A1 migration
 * window: legacy entries omit it and fall back to array-order linearization in
 * `buildSessionContext`.
 */
export interface BaseEntry {
	id: string;
	parentId?: string | null;
	timestamp: number;
}

export interface MessageEntry extends BaseEntry {
	type: "message";
	message: AgentMessage;
}

export interface ModelChangeEntry extends BaseEntry {
	type: "model_change";
	provider: string;
	modelId: string;
}

export interface ThinkingChangeEntry extends BaseEntry {
	type: "thinking_change";
	level: ModelThinkingLevel;
}

/**
 * Per-session MCP inclusion snapshot. Written by `_bodhi-pi/mcp/include` and
 * `_bodhi-pi/mcp/exclude` and by the `mcpServers`-shortcut path on session/new.
 * Replayed on session/load + session/resume to restore the previously-included
 * slugs (matches `model_change` snapshot semantics).
 */
export interface McpInclusionEntry extends BaseEntry {
	type: "mcp_inclusion_set";
	slugs: string[];
}

export interface CompactionDetails {
	readFiles: string[];
	modifiedFiles: string[];
}

export interface CompactionEntry extends BaseEntry {
	type: "compaction";
	summary: string;
	/** First entry id NOT summarized (kept verbatim in context). */
	firstKeptEntryId: string;
	tokensBefore: number;
	details?: CompactionDetails;
	/** Set by `session_before_compact` extension hooks that produce custom summaries. */
	fromHook?: boolean;
}

export interface BranchSummaryEntry extends BaseEntry {
	type: "branch_summary";
	/** Anchor entry id where the abandoned branch diverged. null = from root. */
	fromId: string | null;
	summary: string;
	details?: CompactionDetails;
	fromHook?: boolean;
}

export interface SessionInfoEntry extends BaseEntry {
	type: "session_info";
	name?: string;
}

/**
 * Naming note: coding-agent calls this `custom`. bodhi-pi keeps `extension` —
 * see `packages/bodhi-pi/CONTEXT.md` flagged-ambiguities for the formalised
 * divergence.
 */
export interface ExtensionEntry extends BaseEntry {
	type: "extension";
	extensionName: string;
	customType: string;
	data: unknown;
}

export interface CustomMessageEntry extends BaseEntry {
	type: "custom_message";
	extensionName: string;
	customType: string;
	content: string;
	/** When false, the entry is informational and skipped during context build. */
	display: boolean;
	details?: unknown;
}

export interface SubagentLinkEntry extends BaseEntry {
	type: "subagent_link";
	parentSessionId: string;
	profileName: string;
	task: string;
	toolCallId: string;
	depth: number;
}

export interface SubagentCompleteEntry extends BaseEntry {
	type: "subagent_complete";
	status: "completed" | "cancelled" | "failed";
	summary: string;
	durationMs: number;
	error?: string;
}

export type SessionEntry =
	| MessageEntry
	| ModelChangeEntry
	| ThinkingChangeEntry
	| McpInclusionEntry
	| CompactionEntry
	| BranchSummaryEntry
	| SessionInfoEntry
	| ExtensionEntry
	| CustomMessageEntry
	| SubagentLinkEntry
	| SubagentCompleteEntry;

export interface ReadExtensionEntriesFilter {
	extensionName?: string;
	customType?: string;
}
