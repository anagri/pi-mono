import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const sessions = sqliteTable(
	"sessions",
	{
		id: text("id").primaryKey(),
		cwd: text("cwd").notNull(),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
		leafId: text("leaf_id"),
	},
	// Cursor pagination tie-breaks on `id` after `updatedAt`; include `id` in
	// the index so the secondary order is index-served, not a scan within ties.
	(t) => [index("sessions_cwd_updated_id_idx").on(t.cwd, t.updatedAt, t.id)],
);

export const sessionEntries = sqliteTable(
	"session_entries",
	{
		sessionId: text("session_id")
			.notNull()
			.references(() => sessions.id, { onDelete: "cascade" }),
		ordinal: integer("ordinal").notNull(),
		entryId: text("entry_id").notNull(),
		type: text("type").notNull(),
		timestamp: integer("timestamp").notNull(),
		payload: text("payload").notNull(),
	},
	(t) => [primaryKey({ columns: [t.sessionId, t.ordinal] })],
);
