import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

export function runMigrations(db: BetterSQLite3Database): void {
	const here = path.dirname(fileURLToPath(import.meta.url));
	// dist/sessions/migrate.js → two levels up → package root → drizzle/
	const migrationsFolder = path.resolve(here, "../../drizzle");
	migrate(db, { migrationsFolder });
}
