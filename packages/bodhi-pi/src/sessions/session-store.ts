import type { AgentMessage } from "@mariozechner/pi-agent-core";

/** Discriminator-typed entry persisted in the session log. */
export type SessionEntry =
	| { type: "message"; id: string; timestamp: number; message: AgentMessage }
	| { type: "model_change"; id: string; timestamp: number; provider: string; modelId: string };

/** Full session record returned by load(). */
export interface SessionRecord {
	id: string;
	cwd: string;
	createdAt: number;
	entries: SessionEntry[];
}

/** Lightweight info returned by list(). */
export interface SessionInfo {
	sessionId: string;
	cwd: string;
	createdAt: number;
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

	/** List sessions (optional cwd filter, opaque cursor). */
	list(req: ListSessionsRequest): Promise<ListSessionsResult>;

	/** Permanently delete a session and all its entries. */
	delete(sessionId: string): Promise<void>;
}
