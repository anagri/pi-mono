import type { SessionEntry } from "@bodhiapp/bodhi-pi";
import Dexie, { type Table } from "dexie";

export interface SessionRow {
	id: string;
	cwd: string;
	createdAt: number;
	updatedAt: number;
	leafId?: string | null;
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
