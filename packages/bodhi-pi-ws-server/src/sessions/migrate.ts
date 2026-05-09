import type Database from "better-sqlite3";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
	id INTEGER PRIMARY KEY,
	email TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	last_seen_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
	id TEXT PRIMARY KEY,
	user_id INTEGER NOT NULL REFERENCES users(id),
	cwd TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_user_updated_idx
	ON sessions(user_id, updated_at, id);

CREATE TABLE IF NOT EXISTS session_entries (
	session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
	ordinal INTEGER NOT NULL,
	entry_id TEXT NOT NULL,
	type TEXT NOT NULL,
	timestamp INTEGER NOT NULL,
	payload TEXT NOT NULL,
	PRIMARY KEY (session_id, ordinal)
);
`;

/**
 * Apply schema to the SQLite database. Idempotent: every CREATE is IF NOT EXISTS.
 *
 * Migration approach is intentionally simple for the PoC — schema additions go in this
 * file. When we hit our first destructive change (rename/drop column), graduate to
 * versioned migrations via drizzle-kit.
 */
export function runMigrations(sqlite: Database.Database): void {
	sqlite.exec(SCHEMA_SQL);
}
