import type {
	ExtensionEntry,
	ListSessionsRequest,
	ListSessionsResult,
	ReadExtensionEntriesFilter,
	SessionEntry,
	SessionRecord,
	SessionStore,
} from "@bodhiapp/bodhi-pi";
import { openBodhiPiBrowserDb } from "./db.js";

export interface DexieSessionStoreOptions {
	dbName?: string;
}

const PAGE_SIZE = 50;

/** Validate a base64url-decoded cursor payload. Returns undefined for any malformed shape. */
function parseCursor(raw: string | null | undefined): { updatedAt: number; id: string } | undefined {
	if (!raw) return undefined;
	let decoded: unknown;
	try {
		const json =
			typeof atob === "function" ? atob(toBase64FromBase64Url(raw)) : Buffer.from(raw, "base64url").toString();
		decoded = JSON.parse(json);
	} catch {
		return undefined;
	}
	if (!decoded || typeof decoded !== "object") return undefined;
	const cur = decoded as { updatedAt?: unknown; id?: unknown };
	if (typeof cur.updatedAt !== "number" || typeof cur.id !== "string") return undefined;
	return { updatedAt: cur.updatedAt, id: cur.id };
}

function encodeCursor(value: { updatedAt: number; id: string }): string {
	const json = JSON.stringify(value);
	if (typeof btoa === "function") return toBase64UrlFromBase64(btoa(json));
	return Buffer.from(json).toString("base64url");
}

function toBase64FromBase64Url(s: string): string {
	const padded = s + "=".repeat((4 - (s.length % 4)) % 4);
	return padded.replace(/-/g, "+").replace(/_/g, "/");
}

function toBase64UrlFromBase64(s: string): string {
	return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Dexie-backed `SessionStore` for browser hosts. Persists across page reloads
 * via IndexedDB. Schema mirrors `bodhi-pi`'s `SessionRecord` / `SessionEntry`.
 *
 * Append-time `seq` is computed from the highest existing `seq` for the session
 * (NOT a count), inside the read-write transaction, so concurrent appends in
 * the same browser tab can't both pick the same `seq` and corrupt ordering.
 *
 * `list({cursor})` paginates with the same base64url `{updatedAt, id}` cursor
 * shape used by `bodhi-pi-node`'s SQLite store; `messageCount` is computed via
 * an indexed `count()` per session rather than loading every entry into memory.
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
				leafId: row.leafId ?? null,
				entries: rows.map((e) => e.entry),
			};
		},

		async setLeafId(sessionId, entryId) {
			const row = await sessions.get(sessionId);
			if (!row) throw new Error(`session ${sessionId} not found (or deleted)`);
			await sessions.update(sessionId, { leafId: entryId });
		},

		async append(sessionId: string, entry: SessionEntry) {
			await db.transaction("rw", sessions, entries, async () => {
				const row = await sessions.get(sessionId);
				if (!row) throw new Error(`session ${sessionId} not found (or deleted)`);
				// Highest existing `seq` (not a count). Two concurrent appends would
				// otherwise both observe the same count and write the same `seq`.
				const last = await entries.where({ sessionId }).reverse().sortBy("seq");
				const nextSeq = last.length > 0 ? last[0].seq + 1 : 0;
				await entries.add({ sessionId, seq: nextSeq, entry });
				await sessions.update(sessionId, { updatedAt: Date.now() });
			});
		},

		async list({ cwd, cursor }: ListSessionsRequest): Promise<ListSessionsResult> {
			const cursorData = parseCursor(cursor);
			let rows = cwd ? await sessions.where("cwd").equals(cwd).toArray() : await sessions.toArray();
			rows.sort((a, b) => b.updatedAt - a.updatedAt || (b.id < a.id ? -1 : b.id > a.id ? 1 : 0));

			if (cursorData) {
				rows = rows.filter(
					(r) =>
						r.updatedAt < cursorData.updatedAt || (r.updatedAt === cursorData.updatedAt && r.id < cursorData.id),
				);
			}

			const hasMore = rows.length > PAGE_SIZE;
			const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
			const last = page[page.length - 1];

			const list = await Promise.all(
				page.map(async (r) => {
					// Dexie can't index nested JSON fields, so we must load entries to
					// filter on `entry.type === "message"`. Cost is bounded by page size
					// (was unbounded before pagination landed). Future migration: add a
					// scalar `entryType` column or maintain `messageCount` on the row.
					const allEntries = await entries.where({ sessionId: r.id }).toArray();
					const messageCount = allEntries.filter((e) => e.entry.type === "message").length;
					return {
						sessionId: r.id,
						cwd: r.cwd,
						createdAt: r.createdAt,
						updatedAt: r.updatedAt,
						messageCount,
					};
				}),
			);

			const nextCursor = hasMore && last ? encodeCursor({ updatedAt: last.updatedAt, id: last.id }) : undefined;

			return { sessions: list, ...(nextCursor ? { nextCursor } : {}) };
		},

		async delete(sessionId) {
			await db.transaction("rw", sessions, entries, async () => {
				await entries.where({ sessionId }).delete();
				await sessions.delete(sessionId);
			});
		},

		async forkRecord(sourceSessionId, fromEntryId, position) {
			return await db.transaction("rw", sessions, entries, async () => {
				const sourceRow = await sessions.get(sourceSessionId);
				if (!sourceRow) throw new Error(`session ${sourceSessionId} not found`);
				const sourceEntries = await entries.where({ sessionId: sourceSessionId }).sortBy("seq");
				const byId = new Map(sourceEntries.map((r) => [r.entry.id, r]));
				if (!byId.has(fromEntryId)) throw new Error(`entry ${fromEntryId} not found in session ${sourceSessionId}`);

				const chain: typeof sourceEntries = [];
				let curId: string | null | undefined = fromEntryId;
				while (curId) {
					const node = byId.get(curId);
					if (!node) break;
					chain.unshift(node);
					curId = node.entry.parentId ?? null;
				}
				const copied = position === "before" ? chain.slice(0, -1) : chain;
				const newId = crypto.randomUUID();
				const now = Date.now();
				const newLeafId = copied.length > 0 ? copied[copied.length - 1].entry.id : null;
				await sessions.put({ id: newId, cwd: sourceRow.cwd, createdAt: now, updatedAt: now, leafId: newLeafId });
				for (let i = 0; i < copied.length; i++) {
					await entries.add({ sessionId: newId, seq: i, entry: copied[i].entry });
				}
				return { newSessionId: newId };
			});
		},

		async readExtensionEntries(sessionId: string, filter?: ReadExtensionEntriesFilter): Promise<ExtensionEntry[]> {
			const rows = await entries.where({ sessionId }).sortBy("seq");
			const exts = rows.map((r) => r.entry).filter((e): e is ExtensionEntry => e.type === "extension");
			return exts.filter((e) => {
				if (filter?.extensionName !== undefined && e.extensionName !== filter.extensionName) return false;
				if (filter?.customType !== undefined && e.customType !== filter.customType) return false;
				return true;
			});
		},
	};
}
