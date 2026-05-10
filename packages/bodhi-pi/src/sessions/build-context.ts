import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { BranchSummaryEntry, CompactionEntry, CustomMessageEntry, SessionEntry } from "./entries.js";
import type { SessionRecord } from "./session-store.js";

export interface SessionContext {
	messages: AgentMessage[];
	currentModelId: string | null;
	name: string | null;
}

/**
 * Walk parentId chain from `leafId` (or last entry if absent) back to root and
 * return entries in chronological order. Falls back to `entries.slice()` when
 * no parentId links exist (legacy migration window).
 */
export function walkPath(entries: SessionEntry[], leafId?: string | null): SessionEntry[] {
	const haveParentLinks = entries.some((e) => e.parentId !== undefined && e.parentId !== null);
	if (!haveParentLinks) return entries.slice();
	const byId = new Map<string, SessionEntry>();
	for (const entry of entries) byId.set(entry.id, entry);
	const start = leafId ? byId.get(leafId) : entries[entries.length - 1];
	if (!start) return [];
	const path: SessionEntry[] = [];
	let cur: SessionEntry | undefined = start;
	while (cur) {
		path.unshift(cur);
		cur = cur.parentId ? byId.get(cur.parentId) : undefined;
	}
	return path;
}

/**
 * Synthesize a user-role message that frames a checkpoint summary. bodhi-pi's
 * `AgentMessage` is `Message`-only (no custom roles), so coding-agent's
 * `compactionSummary`/`branchSummary` AgentMessages are encoded as user text
 * with `<context-summary>` tags the LLM can read as instructions.
 */
function compactionSummaryMessage(entry: CompactionEntry): AgentMessage {
	return {
		role: "user",
		content: [
			{
				type: "text",
				text: `<context-summary tokens-before="${entry.tokensBefore}">\n${entry.summary}\n</context-summary>`,
			},
		],
		timestamp: entry.timestamp,
	} as AgentMessage;
}

function branchSummaryMessage(entry: BranchSummaryEntry): AgentMessage {
	return {
		role: "user",
		content: [
			{
				type: "text",
				text: `<branch-summary from-id="${entry.fromId ?? ""}">\n${entry.summary}\n</branch-summary>`,
			},
		],
		timestamp: entry.timestamp,
	} as AgentMessage;
}

function customDisplayMessage(entry: CustomMessageEntry): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text: entry.content }],
		timestamp: entry.timestamp,
	} as AgentMessage;
}

/**
 * Walk the session DAG from `leafId` (or last entry if absent) to root via
 * parentId, collecting messages, the current model id, and name. Compaction
 * entries on the path replace pre-checkpoint history with the synthesized
 * summary message followed by entries from `firstKeptEntryId` onwards.
 *
 * Falls back to array-order linearization for legacy entries that lack
 * parentId — see migration note in `entries.ts`.
 */
export function buildSessionContext(
	record: Pick<SessionRecord, "entries" | "leafId">,
	leafId?: string | null,
): SessionContext {
	const entries = record.entries;
	const byId = new Map<string, SessionEntry>();
	for (const entry of entries) byId.set(entry.id, entry);

	const targetLeaf = leafId !== undefined ? leafId : (record.leafId ?? null);
	if (targetLeaf === null && entries.length === 0) {
		return { messages: [], currentModelId: null, name: null };
	}

	let path: SessionEntry[];
	const haveParentLinks = entries.some((e: SessionEntry) => e.parentId !== undefined && e.parentId !== null);
	if (haveParentLinks && targetLeaf !== null) {
		const start = byId.get(targetLeaf) ?? entries[entries.length - 1];
		path = [];
		let cur: SessionEntry | undefined = start;
		while (cur) {
			path.unshift(cur);
			cur = cur.parentId ? byId.get(cur.parentId) : undefined;
		}
	} else {
		path = entries.slice();
	}

	let currentModelId: string | null = null;
	let name: string | null = null;
	let compaction: CompactionEntry | null = null;
	for (const entry of path) {
		if (entry.type === "model_change") {
			currentModelId = entry.modelId;
		} else if (entry.type === "session_info" && entry.name !== undefined) {
			name = entry.name;
		} else if (entry.type === "compaction") {
			compaction = entry;
		}
	}

	const messages: AgentMessage[] = [];
	const appendIfMessage = (entry: SessionEntry) => {
		if (entry.type === "message") {
			messages.push(entry.message);
		} else if (entry.type === "branch_summary" && entry.summary) {
			messages.push(branchSummaryMessage(entry));
		} else if (entry.type === "custom_message" && entry.display) {
			messages.push(customDisplayMessage(entry));
		}
	};

	if (compaction) {
		messages.push(compactionSummaryMessage(compaction));
		const compactionIdx = path.findIndex((e) => e.id === compaction.id);
		let foundFirstKept = false;
		for (let i = 0; i < compactionIdx; i++) {
			const entry = path[i];
			if (entry.id === compaction.firstKeptEntryId) foundFirstKept = true;
			if (foundFirstKept) appendIfMessage(entry);
		}
		for (let i = compactionIdx + 1; i < path.length; i++) {
			appendIfMessage(path[i]);
		}
	} else {
		for (const entry of path) appendIfMessage(entry);
	}

	return { messages, currentModelId, name };
}
