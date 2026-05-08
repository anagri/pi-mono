import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SessionEntry } from "@bodhiapp/bodhi-pi";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSqliteSessionStore } from "../src/sessions/sqlite-session-store.js";

let dbPath: string;
let store: ReturnType<typeof createSqliteSessionStore>;

beforeEach(() => {
	dbPath = path.join(os.tmpdir(), `bodhi-pi-cli-sessions-${Date.now()}.db`);
	store = createSqliteSessionStore(dbPath);
});

afterEach(() => {
	try {
		fs.unlinkSync(dbPath);
		fs.unlinkSync(`${dbPath}-wal`);
		fs.unlinkSync(`${dbPath}-shm`);
	} catch {
		// ignore missing files
	}
});

function makeEntry(id: string): SessionEntry {
	return {
		type: "message",
		id,
		timestamp: Date.now(),
		message: { role: "user", content: `msg-${id}` } as any,
	};
}

describe("create / load round-trip", () => {
	it("creates a session and loads it back with no entries", async () => {
		const { id, cwd } = await store.create({ cwd: "/test/cwd" });
		const record = await store.load(id);
		expect(record).toBeDefined();
		expect(record!.id).toBe(id);
		expect(record!.cwd).toBe(cwd);
		expect(record!.entries).toHaveLength(0);
	});

	it("returns undefined for unknown sessionId", async () => {
		const result = await store.load("does-not-exist");
		expect(result).toBeUndefined();
	});
});

describe("append", () => {
	it("appends entries in order and loads them back", async () => {
		const { id } = await store.create({ cwd: "/cwd" });
		const e1 = makeEntry("e1");
		const e2 = makeEntry("e2");
		await store.append(id, e1);
		await store.append(id, e2);

		const record = await store.load(id);
		expect(record!.entries).toHaveLength(2);
		expect(record!.entries[0].id).toBe("e1");
		expect(record!.entries[1].id).toBe("e2");
	});

	it("bumps updatedAt on append", async () => {
		const record = await store.create({ cwd: "/cwd" });
		const beforeAppend = record.updatedAt;
		await new Promise((r) => setTimeout(r, 2));
		await store.append(record.id, makeEntry("x"));
		const loaded = await store.load(record.id);
		expect(loaded!.updatedAt).toBeGreaterThan(beforeAppend);
	});

	it("throws for unknown sessionId", async () => {
		await expect(store.append("ghost", makeEntry("e1"))).rejects.toThrow("not found");
	});
});

describe("list", () => {
	it("returns sessions for the specified cwd", async () => {
		const a = await store.create({ cwd: "/project/a" });
		const b = await store.create({ cwd: "/project/b" });
		await store.append(a.id, makeEntry("m1"));

		const resultA = await store.list({ cwd: "/project/a" });
		expect(resultA.sessions).toHaveLength(1);
		expect(resultA.sessions[0].sessionId).toBe(a.id);
		expect(resultA.sessions[0].messageCount).toBe(1);

		const resultB = await store.list({ cwd: "/project/b" });
		expect(resultB.sessions).toHaveLength(1);
		expect(resultB.sessions[0].sessionId).toBe(b.id);
	});

	it("returns all sessions when cwd is not specified", async () => {
		await store.create({ cwd: "/x" });
		await store.create({ cwd: "/y" });
		const result = await store.list({});
		expect(result.sessions.length).toBeGreaterThanOrEqual(2);
	});

	it("paginates with cursor across 60 rows", async () => {
		const cwd = "/paginate";
		// Create 60 sessions with different updatedAt values
		for (let i = 0; i < 60; i++) {
			await store.create({ cwd });
		}

		const page1 = await store.list({ cwd });
		expect(page1.sessions).toHaveLength(50);
		expect(page1.nextCursor).toBeDefined();

		const page2 = await store.list({ cwd, cursor: page1.nextCursor });
		expect(page2.sessions).toHaveLength(10);
		expect(page2.nextCursor).toBeUndefined();

		// No overlap between pages
		const ids1 = new Set(page1.sessions.map((s) => s.sessionId));
		for (const s of page2.sessions) {
			expect(ids1.has(s.sessionId)).toBe(false);
		}
	});
});

describe("delete", () => {
	it("removes the session and its entries (cascade)", async () => {
		const { id } = await store.create({ cwd: "/cwd" });
		await store.append(id, makeEntry("e1"));
		await store.delete(id);
		const result = await store.load(id);
		expect(result).toBeUndefined();
	});

	it("is idempotent for non-existent sessionId", async () => {
		await expect(store.delete("ghost")).resolves.toBeUndefined();
	});
});
