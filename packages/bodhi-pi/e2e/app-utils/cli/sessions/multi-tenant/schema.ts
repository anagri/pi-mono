import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
	id: integer("id").primaryKey(),
	email: text("email").notNull(),
	createdAt: integer("created_at").notNull(),
	lastSeenAt: integer("last_seen_at").notNull(),
});

export const sessions = sqliteTable(
	"sessions",
	{
		id: text("id").primaryKey(),
		userId: integer("user_id").notNull(),
		cwd: text("cwd").notNull(),
		createdAt: integer("created_at").notNull(),
		updatedAt: integer("updated_at").notNull(),
		leafId: text("leaf_id"),
	},
	(t) => [index("sessions_user_updated_idx").on(t.userId, t.updatedAt, t.id)],
);

export const sessionEntries = sqliteTable(
	"session_entries",
	{
		sessionId: text("session_id").notNull(),
		ordinal: integer("ordinal").notNull(),
		entryId: text("entry_id").notNull(),
		type: text("type").notNull(),
		timestamp: integer("timestamp").notNull(),
		payload: text("payload").notNull(),
	},
	(t) => [primaryKey({ columns: [t.sessionId, t.ordinal] })],
);
