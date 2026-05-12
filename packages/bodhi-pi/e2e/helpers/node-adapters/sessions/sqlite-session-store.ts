import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { ExtensionEntry, ReadExtensionEntriesFilter, SessionEntry, SessionRecord, SessionStore } from "@/index.js";
import { runMigrations } from "./migrate.js";
import { sessionEntries, sessions } from "./schema.js";

const PAGE_SIZE = 50;

function parseSessionEntry(payload: string): SessionEntry {
	const parsed: unknown = JSON.parse(payload);
	if (!parsed || typeof parsed !== "object" || typeof (parsed as { type?: unknown }).type !== "string") {
		throw new Error(`SessionEntry payload missing discriminator field 'type'`);
	}
	return parsed as SessionEntry;
}

function parseExtensionEntry(payload: string): ExtensionEntry {
	const parsed: unknown = JSON.parse(payload);
	if (!parsed || typeof parsed !== "object") {
		throw new Error(`ExtensionEntry payload is not an object`);
	}
	const obj = parsed as { type?: unknown; extensionName?: unknown; customType?: unknown };
	if (obj.type !== "extension" || typeof obj.extensionName !== "string" || typeof obj.customType !== "string") {
		throw new Error(`ExtensionEntry payload missing 'extensionName' or 'customType'`);
	}
	return parsed as ExtensionEntry;
}

function parseCursor(raw: string | undefined): { updatedAt: number; id: string } | undefined {
	if (!raw) return undefined;
	let decoded: unknown;
	try {
		decoded = JSON.parse(Buffer.from(raw, "base64url").toString());
	} catch {
		return undefined;
	}
	if (!decoded || typeof decoded !== "object") return undefined;
	const cur = decoded as { updatedAt?: unknown; id?: unknown };
	if (typeof cur.updatedAt !== "number" || typeof cur.id !== "string") return undefined;
	return { updatedAt: cur.updatedAt, id: cur.id };
}

export interface SqliteSessionStoreOptions {
	dbPath: string;
}

export function createSqliteSessionStore(opts: SqliteSessionStoreOptions): SessionStore {
	const { dbPath } = opts;
	const dir = path.dirname(dbPath);
	fs.mkdirSync(dir, { recursive: true });

	const sqlite = new Database(dbPath);
	sqlite.pragma("journal_mode = WAL");
	sqlite.pragma("foreign_keys = ON");

	runMigrations(sqlite);

	const db = drizzle(sqlite);

	return {
		create({ cwd }) {
			const now = Date.now();
			const id = crypto.randomUUID();
			db.insert(sessions).values({ id, cwd, createdAt: now, updatedAt: now }).run();
			return Promise.resolve({ id, cwd, createdAt: now, updatedAt: now, entries: [] });
		},

		load(sessionId) {
			const row = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
			if (!row) return Promise.resolve(undefined);

			const entryRows = db
				.select()
				.from(sessionEntries)
				.where(eq(sessionEntries.sessionId, sessionId))
				.orderBy(sessionEntries.ordinal)
				.all();

			const record: SessionRecord = {
				id: row.id,
				cwd: row.cwd,
				createdAt: row.createdAt,
				updatedAt: row.updatedAt,
				leafId: row.leafId ?? null,
				entries: entryRows.map((r) => parseSessionEntry(r.payload)),
			};
			return Promise.resolve(record);
		},

		setLeafId(sessionId, entryId) {
			db.update(sessions).set({ leafId: entryId }).where(eq(sessions.id, sessionId)).run();
			return Promise.resolve();
		},

		append(sessionId, entry) {
			try {
				db.transaction((tx) => {
					const sessionRow = tx.select({ id: sessions.id }).from(sessions).where(eq(sessions.id, sessionId)).get();
					if (!sessionRow) throw new Error(`session ${sessionId} not found (or deleted)`);

					const maxResult = tx
						.select({ maxOrdinal: sql<number>`max(${sessionEntries.ordinal})` })
						.from(sessionEntries)
						.where(eq(sessionEntries.sessionId, sessionId))
						.get();

					const nextOrdinal = (maxResult?.maxOrdinal ?? -1) + 1;
					const now = Date.now();

					tx.insert(sessionEntries)
						.values({
							sessionId,
							ordinal: nextOrdinal,
							entryId: entry.id,
							type: entry.type,
							timestamp: entry.timestamp,
							payload: JSON.stringify(entry),
						})
						.run();

					tx.update(sessions).set({ updatedAt: now }).where(eq(sessions.id, sessionId)).run();
				});
				return Promise.resolve();
			} catch (err) {
				return Promise.reject(err as Error);
			}
		},

		list({ cwd, cursor }) {
			const cursorData = parseCursor(cursor ?? undefined);

			const rows = db
				.select({
					id: sessions.id,
					cwd: sessions.cwd,
					createdAt: sessions.createdAt,
					updatedAt: sessions.updatedAt,
					messageCount: sql<number>`count(case when ${sessionEntries.type} = 'message' then 1 end)`,
				})
				.from(sessions)
				.leftJoin(sessionEntries, eq(sessions.id, sessionEntries.sessionId))
				.where(
					and(
						cwd ? eq(sessions.cwd, cwd) : undefined,
						cursorData
							? or(
									lt(sessions.updatedAt, cursorData.updatedAt),
									and(eq(sessions.updatedAt, cursorData.updatedAt), lt(sessions.id, cursorData.id)),
								)
							: undefined,
					),
				)
				.groupBy(sessions.id)
				.orderBy(desc(sessions.updatedAt), desc(sessions.id))
				.limit(PAGE_SIZE + 1)
				.all();

			const hasMore = rows.length > PAGE_SIZE;
			const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
			const last = page[page.length - 1];
			const nextCursor =
				hasMore && last
					? Buffer.from(JSON.stringify({ updatedAt: last.updatedAt, id: last.id })).toString("base64url")
					: undefined;

			return Promise.resolve({
				sessions: page.map((r) => ({
					sessionId: r.id,
					cwd: r.cwd,
					createdAt: r.createdAt,
					updatedAt: r.updatedAt,
					messageCount: r.messageCount ?? 0,
				})),
				...(nextCursor ? { nextCursor } : {}),
			});
		},

		delete(sessionId) {
			db.delete(sessions).where(eq(sessions.id, sessionId)).run();
			return Promise.resolve();
		},

		forkRecord(sourceSessionId, fromEntryId, position) {
			try {
				const sourceRow = db.select().from(sessions).where(eq(sessions.id, sourceSessionId)).get();
				if (!sourceRow) throw new Error(`session ${sourceSessionId} not found`);
				const entryRows = db
					.select()
					.from(sessionEntries)
					.where(eq(sessionEntries.sessionId, sourceSessionId))
					.orderBy(sessionEntries.ordinal)
					.all();
				const parsed = entryRows.map((r) => ({ row: r, entry: parseSessionEntry(r.payload) }));
				const byId = new Map(parsed.map((p) => [p.entry.id, p]));
				if (!byId.has(fromEntryId)) throw new Error(`entry ${fromEntryId} not found in session ${sourceSessionId}`);

				const chain: typeof parsed = [];
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
				db.transaction((tx) => {
					tx.insert(sessions)
						.values({ id: newId, cwd: sourceRow.cwd, createdAt: now, updatedAt: now, leafId: newLeafId })
						.run();
					for (let i = 0; i < copied.length; i++) {
						const node = copied[i];
						tx.insert(sessionEntries)
							.values({
								sessionId: newId,
								ordinal: i,
								entryId: node.entry.id,
								type: node.row.type,
								timestamp: node.row.timestamp,
								payload: node.row.payload,
							})
							.run();
					}
				});
				return Promise.resolve({ newSessionId: newId });
			} catch (err) {
				return Promise.reject(err as Error);
			}
		},

		readExtensionEntries(sessionId: string, filter?: ReadExtensionEntriesFilter): Promise<ExtensionEntry[]> {
			const rows = db
				.select()
				.from(sessionEntries)
				.where(and(eq(sessionEntries.sessionId, sessionId), eq(sessionEntries.type, "extension")))
				.orderBy(sessionEntries.ordinal)
				.all();
			const entries = rows.map((r) => parseExtensionEntry(r.payload));
			const matched = entries.filter((e) => {
				if (filter?.extensionName !== undefined && e.extensionName !== filter.extensionName) return false;
				if (filter?.customType !== undefined && e.customType !== filter.customType) return false;
				return true;
			});
			return Promise.resolve(matched);
		},
	};
}
