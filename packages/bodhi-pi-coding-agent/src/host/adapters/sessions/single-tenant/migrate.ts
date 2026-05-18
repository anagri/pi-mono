import type Database from "better-sqlite3";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
	id TEXT PRIMARY KEY NOT NULL,
	cwd TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	leaf_id TEXT,
	parent_session_id TEXT,
	subagent_profile TEXT
);

CREATE INDEX IF NOT EXISTS sessions_cwd_updated_id_idx ON sessions (cwd, updated_at, id);

CREATE TABLE IF NOT EXISTS session_entries (
	session_id TEXT NOT NULL,
	ordinal INTEGER NOT NULL,
	entry_id TEXT NOT NULL,
	type TEXT NOT NULL,
	timestamp INTEGER NOT NULL,
	payload TEXT NOT NULL,
	PRIMARY KEY (session_id, ordinal),
	FOREIGN KEY (session_id) REFERENCES sessions (id) ON UPDATE NO ACTION ON DELETE CASCADE
);
`;

export function runMigrations(sqlite: Database.Database): void {
	sqlite.exec(SCHEMA_SQL);
}
