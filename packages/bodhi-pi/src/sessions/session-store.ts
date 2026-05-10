export type {
	BaseEntry,
	BranchSummaryEntry,
	CompactionDetails,
	CompactionEntry,
	CustomMessageEntry,
	ExtensionEntry,
	LabelEntry,
	MessageEntry,
	ModelChangeEntry,
	ReadExtensionEntriesFilter,
	SessionEntry,
	SessionInfoEntry,
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
	/** Set when this session was created by `_bodhi-pi/session/fork` or `/clone`. */
	parentSessionId?: string;
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
}

export interface ListSessionsRequest {
	cwd?: string;
	cursor?: string;
}

export interface ListSessionsResult {
	sessions: SessionInfo[];
	nextCursor?: string;
}

/**
 * Append-only by design. There is no `close()`: ACP `session/close` is a runtime
 * concern (drop the live agent, abort pending work) and never touches the store.
 * `delete()` is terminal — used by the `_bodhi-pi/session/delete` extension method.
 */
export interface SessionStore {
	create(meta: { cwd: string; parentSessionId?: string }): Promise<SessionRecord>;

	load(sessionId: string): Promise<SessionRecord | undefined>;

	append(sessionId: string, entry: SessionEntry): Promise<void>;

	/**
	 * Stores that don't yet track tree state may treat this as a no-op; tree-aware
	 * features (compaction, fork) require persistence.
	 */
	setLeafId?(sessionId: string, entryId: string | null): Promise<void>;

	/**
	 * Copy entries reachable from `fromEntryId` (walking parentId backwards) into
	 * a new session record.
	 *   - `"before"` excludes `fromEntryId` (used by /fork: caller re-edits the message at that id)
	 *   - `"at"` includes `fromEntryId` (used by /clone)
	 */
	forkRecord?(
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
