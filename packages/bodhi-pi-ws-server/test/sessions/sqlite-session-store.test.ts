import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSqliteSessionStore, openDb, upsertUser } from "../../src/sessions/sqlite-session-store.js";

describe("multi-tenant SqliteSessionStore", () => {
	let dataDir: string;
	let dbPath: string;
	let db: ReturnType<typeof openDb>["db"];
	let sqlite: ReturnType<typeof openDb>["sqlite"];

	beforeEach(() => {
		dataDir = mkdtempSync(path.join(os.tmpdir(), "bodhi-pi-ws-server-store-test-"));
		dbPath = path.join(dataDir, "sessions.db");
		const opened = openDb({ dbPath });
		db = opened.db;
		sqlite = opened.sqlite;
		upsertUser(db, { id: 1, email: "alice@example.com" });
		upsertUser(db, { id: 2, email: "bob@example.com" });
	});

	afterEach(() => {
		sqlite.close();
		rmSync(dataDir, { recursive: true, force: true });
	});

	it("scopes list() by userId", async () => {
		const alice = createSqliteSessionStore({ db, userId: 1 });
		const bob = createSqliteSessionStore({ db, userId: 2 });

		await alice.create({ cwd: "/work" });
		await alice.create({ cwd: "/work" });
		await bob.create({ cwd: "/work" });

		const aliceList = await alice.list({});
		const bobList = await bob.list({});
		expect(aliceList.sessions).toHaveLength(2);
		expect(bobList.sessions).toHaveLength(1);
	});

	it("returns undefined when loading another user's session", async () => {
		const alice = createSqliteSessionStore({ db, userId: 1 });
		const bob = createSqliteSessionStore({ db, userId: 2 });

		const created = await alice.create({ cwd: "/work" });
		const loaded = await bob.load(created.id);
		expect(loaded).toBeUndefined();
	});

	it("rejects append against another user's session", async () => {
		const alice = createSqliteSessionStore({ db, userId: 1 });
		const bob = createSqliteSessionStore({ db, userId: 2 });

		const aliceSession = await alice.create({ cwd: "/work" });
		await expect(
			bob.append(aliceSession.id, {
				type: "message",
				id: "e1",
				timestamp: Date.now(),
				message: { role: "user", content: "hi", timestamp: Date.now() },
			}),
		).rejects.toThrow(/not found/);
	});

	it("rejects delete of another user's session", async () => {
		const alice = createSqliteSessionStore({ db, userId: 1 });
		const bob = createSqliteSessionStore({ db, userId: 2 });

		const aliceSession = await alice.create({ cwd: "/work" });
		await expect(bob.delete(aliceSession.id)).rejects.toThrow(/not found/);

		// Alice can still delete it.
		await alice.delete(aliceSession.id);
		const after = await alice.list({});
		expect(after.sessions).toHaveLength(0);
	});

	it("persists and reloads a session's entries for the owner", async () => {
		const alice = createSqliteSessionStore({ db, userId: 1 });

		const created = await alice.create({ cwd: "/work" });
		const ts = Date.now();
		await alice.append(created.id, {
			type: "message",
			id: "e1",
			timestamp: ts,
			message: { role: "user", content: "hello", timestamp: ts },
		});
		await alice.append(created.id, {
			type: "model_change",
			id: "e2",
			timestamp: ts + 1,
			provider: "openai",
			modelId: "gpt-4o-mini",
		});

		const reloaded = await alice.load(created.id);
		expect(reloaded?.entries).toHaveLength(2);
		expect(reloaded?.entries[0].type).toBe("message");
		expect(reloaded?.entries[1].type).toBe("model_change");
	});
});
