import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SessionEntry, SessionRecord, SessionStore } from "@bodhiapp/bodhi-pi";
import Database from "better-sqlite3";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { runMigrations } from "./migrate.js";
import { sessionEntries, sessions } from "./schema.js";

const PAGE_SIZE = 50;

export function createSqliteSessionStore(dbPath: string): SessionStore {
	const dir = path.dirname(dbPath);
	fs.mkdirSync(dir, { recursive: true });

	const sqlite = new Database(dbPath);
	sqlite.pragma("journal_mode = WAL");
	sqlite.pragma("foreign_keys = ON");

	const db = drizzle(sqlite);
	runMigrations(db);

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
				entries: entryRows.map((r) => JSON.parse(r.payload) as SessionEntry),
			};
			return Promise.resolve(record);
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
			let cursorData: { updatedAt: number; id: string } | undefined;
			if (cursor) {
				try {
					cursorData = JSON.parse(Buffer.from(cursor, "base64url").toString());
				} catch {
					// malformed cursor — ignore, start from beginning
				}
			}

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
	};
}

export function defaultDbPath(): string {
	return path.join(os.homedir(), ".bodhi-pi-cli", "sessions.db");
}
