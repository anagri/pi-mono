export type {
	BaseEntry,
	BranchSummaryEntry,
	CompactionDetails,
	CompactionEntry,
	CustomMessageEntry,
	ExtensionEntry,
	MessageEntry,
	ModelChangeEntry,
	ReadExtensionEntriesFilter,
	SessionEntry,
	SessionInfoEntry,
	SubagentBatchEntry,
	SubagentCompleteEntry,
	SubagentLinkEntry,
} from "./entries.js";

import type { ExtensionEntry, ReadExtensionEntriesFilter, SessionEntry } from "./entries.js";

export interface SessionRecord {
	id: string;
	cwd: string;
	createdAt: number;
	/** Last-modified timestamp. Implementations MUST bump this on every `append()`. */
	updatedAt: number;
	/**
	 * Current head of the conversation DAG. Optional during the migration window;
	 * tree-aware features (compaction, fork) populate it via `setLeafId`.
	 */
	leafId?: string | null;
	parentSessionId?: string;
	subagent?: { profileName: string };
	/** Latest `session_info.name` on the active path. */
	name?: string;
	entries: SessionEntry[];
}

export interface SessionInfo {
	sessionId: string;
	cwd: string;
	createdAt: number;
	updatedAt: number;
	messageCount: number;
	name?: string;
	parentSessionId?: string;
	subagent?: { profileName: string };
}

export interface ListSessionsRequest {
	cwd?: string;
	cursor?: string;
	parentSessionId?: string;
	includeSubagentChildren?: boolean;
}

export interface ListSessionsResult {
	sessions: SessionInfo[];
	nextCursor?: string;
}

/**
 * Append-only by design — `session/close` drops runtime state, only `delete()` removes the record.
 * `load()` returns `undefined` for an unknown id; other mutators reject. `list({ cursor })` MUST
 * honour pagination when a previous call returned `nextCursor`. `setLeafId` and `forkRecord` are
 * required — every in-tree store implements them, and tree-aware features (compaction, fork,
 * branch summary, navigate) depend on their presence.
 */
export interface SessionStore {
	create(meta: { cwd: string; parentSessionId?: string; subagent?: { profileName: string } }): Promise<SessionRecord>;

	load(sessionId: string): Promise<SessionRecord | undefined>;

	append(sessionId: string, entry: SessionEntry): Promise<void>;

	/** Updates the active branch's head. Required by compaction, fork, and `session/navigate`. */
	setLeafId(sessionId: string, entryId: string | null): Promise<void>;

	/**
	 * Copy entries reachable from `fromEntryId` (walking parentId backwards) into
	 * a new session record.
	 *   - `"before"` excludes `fromEntryId` (used by /fork: caller re-edits the message at that id)
	 *   - `"at"` includes `fromEntryId` (used by /clone)
	 */
	forkRecord(
		sourceSessionId: string,
		fromEntryId: string,
		position: "before" | "at",
	): Promise<{ newSessionId: string }>;

	/**
	 * Ephemeral / single-page implementations may ignore `cursor`. Disk-backed and
	 * remote implementations MUST honour cursor semantics: when a previous call
	 * returned `nextCursor`, passing that string back must yield the next page.
	 */
	list(req: ListSessionsRequest): Promise<ListSessionsResult>;

	delete(sessionId: string): Promise<void>;

	/** Filtering is AND-combined; pass `{}` to read every extension entry. */
	readExtensionEntries(sessionId: string, filter?: ReadExtensionEntriesFilter): Promise<ExtensionEntry[]>;
}
