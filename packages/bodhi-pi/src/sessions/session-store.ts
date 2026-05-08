import type { AgentMessage } from "@mariozechner/pi-agent-core";

/** Discriminator-typed entry persisted in the session log. */
export type SessionEntry =
	| { type: "message"; id: string; timestamp: number; message: AgentMessage }
	| { type: "model_change"; id: string; timestamp: number; provider: string; modelId: string }
	| ExtensionEntry;

/**
 * Custom session entry written by an extension via `pi.appendEntry`.
 *
 * `extensionName` is used by `readExtensionEntries` for filtering; `customType`
 * is opaque to bodhi-pi (extensions choose their own taxonomy, e.g.
 * "web-search-results", "todo-list", "audit-log"). `data` is JSON-cloneable
 * payload — implementations MUST round-trip it through their store.
 */
export interface ExtensionEntry {
	type: "extension";
	id: string;
	timestamp: number;
	extensionName: string;
	customType: string;
	data: unknown;
}

/** Filter for `readExtensionEntries`. Both fields are AND-combined. */
export interface ReadExtensionEntriesFilter {
	extensionName?: string;
	customType?: string;
}

/** Full session record returned by load(). */
export interface SessionRecord {
	id: string;
	cwd: string;
	createdAt: number;
	/** Last-modified timestamp. Implementations MUST bump this on every `append()`. */
	updatedAt: number;
	entries: SessionEntry[];
}

/** Lightweight info returned by list(). */
export interface SessionInfo {
	sessionId: string;
	cwd: string;
	createdAt: number;
	/** Last-modified timestamp. */
	updatedAt: number;
	messageCount: number;
}

/** List request shape. */
export interface ListSessionsRequest {
	cwd?: string;
	cursor?: string;
}

/** List response shape. */
export interface ListSessionsResult {
	sessions: SessionInfo[];
	nextCursor?: string;
}

/**
 * Host-injected persistence boundary for ACP sessions.
 *
 * Append-only by design. There is no `close()`: ACP `session/close` is a runtime
 * concern (drop the live agent, abort pending work) and never touches the store.
 * `delete()` is terminal — used by the `_bodhi-pi/session/delete` extension method.
 */
export interface SessionStore {
	/** Create a brand-new session with the given cwd. Returns the assigned id + initial record. */
	create(meta: { cwd: string }): Promise<SessionRecord>;

	/** Load full record by id. Returns undefined if no such session exists. */
	load(sessionId: string): Promise<SessionRecord | undefined>;

	/** Append one entry. Caller (the agent) provides the entry id. */
	append(sessionId: string, entry: SessionEntry): Promise<void>;

	/**
	 * List sessions (optional cwd filter + opaque pagination cursor).
	 *
	 * Ephemeral / single-page implementations (e.g. `createInMemorySessionStore`)
	 * may ignore `cursor`. Disk-backed and remote implementations MUST honour
	 * cursor semantics: when a previous call returned `nextCursor`, passing
	 * that string back in must yield the next page.
	 */
	list(req: ListSessionsRequest): Promise<ListSessionsResult>;

	/** Permanently delete a session and all its entries. */
	delete(sessionId: string): Promise<void>;

	/**
	 * Read extension entries previously written via `append({ type: "extension", ... })`.
	 *
	 * Extensions call this on `session_start` to rebuild in-memory state from
	 * past sessions (e.g. replaying a todo list, restoring search-result cache).
	 * Filtering is AND-combined; pass `{}` to read every extension entry.
	 */
	readExtensionEntries(sessionId: string, filter?: ReadExtensionEntriesFilter): Promise<ExtensionEntry[]>;
}
