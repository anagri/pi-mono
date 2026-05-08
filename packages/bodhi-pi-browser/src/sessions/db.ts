import type { SessionEntry } from "@bodhiapp/bodhi-pi";
import Dexie, { type Table } from "dexie";

/**
 * Dexie schema for browser-side session persistence.
 *
 * `sessions` rows hold the lightweight metadata (cwd + timestamps); each
 * `entries` row carries one `SessionEntry` payload as JSON. Storing the full
 * entry as JSON keeps the schema stable across bodhi-pi minor versions — same
 * rationale as the SQLite store in `bodhi-pi-node`.
 *
 * We use composition (not class extension) because tsgo trips on Dexie's
 * `var Dexie: DexieConstructor` declaration when subclassing — `tsc` is fine
 * but tsgo doesn't pick up the merged instance interface methods.
 */

export interface SessionRow {
	id: string;
	cwd: string;
	createdAt: number;
	updatedAt: number;
}

export interface EntryRow {
	pk?: number;
	sessionId: string;
	seq: number;
	entry: SessionEntry;
}

export interface BodhiPiBrowserDbHandle {
	db: Dexie;
	sessions: Table<SessionRow, string>;
	entries: Table<EntryRow, number>;
}

export function openBodhiPiBrowserDb(dbName: string): BodhiPiBrowserDbHandle {
	const db = new Dexie(dbName);
	db.version(1).stores({
		sessions: "&id, cwd, updatedAt",
		entries: "++pk, sessionId, [sessionId+seq]",
	});
	return {
		db,
		sessions: db.table<SessionRow, string>("sessions"),
		entries: db.table<EntryRow, number>("entries"),
	};
}
