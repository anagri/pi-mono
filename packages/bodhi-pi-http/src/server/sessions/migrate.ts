import type Database from "better-sqlite3";

// Schema v2: drop-and-recreate so `sessions.leaf_id` lands. PoC-acceptable
// destructive migration; existing dev sessions are wiped on next boot.
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
	id INTEGER PRIMARY KEY,
	email TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	last_seen_at INTEGER NOT NULL
);

DROP TABLE IF EXISTS session_entries;
DROP TABLE IF EXISTS sessions;

CREATE TABLE sessions (
	id TEXT PRIMARY KEY,
	user_id INTEGER NOT NULL REFERENCES users(id),
	cwd TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	leaf_id TEXT
);

CREATE INDEX IF NOT EXISTS sessions_user_updated_idx
	ON sessions(user_id, updated_at, id);

CREATE TABLE session_entries (
	session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
	ordinal INTEGER NOT NULL,
	entry_id TEXT NOT NULL,
	type TEXT NOT NULL,
	timestamp INTEGER NOT NULL,
	payload TEXT NOT NULL,
	PRIMARY KEY (session_id, ordinal)
);
`;

/** Idempotent schema apply. Mirrors bodhi-pi-ws-server's migrate.ts. */
export function runMigrations(sqlite: Database.Database): void {
	sqlite.exec(SCHEMA_SQL);
}
