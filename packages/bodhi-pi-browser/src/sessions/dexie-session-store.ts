import type {
	ListSessionsRequest,
	ListSessionsResult,
	SessionEntry,
	SessionRecord,
	SessionStore,
} from "@bodhiapp/bodhi-pi";
import { openBodhiPiBrowserDb } from "./db.js";

export interface DexieSessionStoreOptions {
	dbName?: string;
}

/**
 * Dexie-backed `SessionStore` for browser hosts. Persists across page reloads
 * via IndexedDB. Schema mirrors `bodhi-pi`'s `SessionRecord` / `SessionEntry`.
 */
export function createDexieSessionStore(opts: DexieSessionStoreOptions = {}): SessionStore {
	const handle = openBodhiPiBrowserDb(opts.dbName ?? "bodhi-pi-browser");
	const { db, sessions, entries } = handle;

	return {
		async create({ cwd }) {
			const now = Date.now();
			const record: SessionRecord = {
				id: crypto.randomUUID(),
				cwd,
				createdAt: now,
				updatedAt: now,
				entries: [],
			};
			await sessions.put({ id: record.id, cwd, createdAt: now, updatedAt: now });
			return record;
		},

		async load(sessionId) {
			const row = await sessions.get(sessionId);
			if (!row) return undefined;
			const rows = await entries.where({ sessionId }).sortBy("seq");
			return {
				id: row.id,
				cwd: row.cwd,
				createdAt: row.createdAt,
				updatedAt: row.updatedAt,
				entries: rows.map((e) => e.entry),
			};
		},

		async append(sessionId: string, entry: SessionEntry) {
			await db.transaction("rw", sessions, entries, async () => {
				const row = await sessions.get(sessionId);
				if (!row) throw new Error(`session ${sessionId} not found (or deleted)`);
				const seq = await entries.where({ sessionId }).count();
				await entries.add({ sessionId, seq, entry });
				await sessions.update(sessionId, { updatedAt: Date.now() });
			});
		},

		async list({ cwd }: ListSessionsRequest): Promise<ListSessionsResult> {
			const rows = cwd ? await sessions.where("cwd").equals(cwd).toArray() : await sessions.toArray();
			rows.sort((a, b) => b.updatedAt - a.updatedAt);

			const list = await Promise.all(
				rows.map(async (r) => {
					const sessionEntries = await entries.where({ sessionId: r.id }).toArray();
					const messageCount = sessionEntries.filter((e) => e.entry.type === "message").length;
					return {
						sessionId: r.id,
						cwd: r.cwd,
						createdAt: r.createdAt,
						updatedAt: r.updatedAt,
						messageCount,
					};
				}),
			);

			return { sessions: list };
		},

		async delete(sessionId) {
			await db.transaction("rw", sessions, entries, async () => {
				await entries.where({ sessionId }).delete();
				await sessions.delete(sessionId);
			});
		},
	};
}
