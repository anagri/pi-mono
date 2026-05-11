import "fake-indexeddb/auto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { resetDb as reset } from "./_test-helpers/reset-db.js";
import { createDexieSessionStore } from "./dexie-session-store.js";

const userMessage: AgentMessage = { role: "user", content: "hello" } as unknown as AgentMessage;
const assistantMessage: AgentMessage = {
	role: "assistant",
	content: [{ type: "text", text: "hi" }],
	stopReason: "stop",
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		total: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	provider: "openai",
	model: "gpt-4o-mini",
} as unknown as AgentMessage;

describe("createDexieSessionStore", () => {
	const dbName = "bodhi-pi-browser-test";

	beforeEach(async () => {
		await reset(dbName);
	});
	afterEach(async () => {
		await reset(dbName);
	});

	test("create then load round-trip", async () => {
		const store = createDexieSessionStore({ dbName });
		const created = await store.create({ cwd: "/work" });
		expect(created.cwd).toBe("/work");
		expect(created.entries).toEqual([]);
		const loaded = await store.load(created.id);
		expect(loaded?.id).toBe(created.id);
		expect(loaded?.cwd).toBe("/work");
		expect(loaded?.entries).toEqual([]);
	});

	test("load returns undefined for unknown session", async () => {
		const store = createDexieSessionStore({ dbName });
		expect(await store.load("does-not-exist")).toBeUndefined();
	});

	test("append persists entries in order and bumps updatedAt", async () => {
		const store = createDexieSessionStore({ dbName });
		const created = await store.create({ cwd: "/work" });
		const before = created.updatedAt;
		await new Promise((r) => setTimeout(r, 5));

		await store.append(created.id, { type: "message", id: "m1", timestamp: 1, message: userMessage });
		await store.append(created.id, { type: "message", id: "m2", timestamp: 2, message: assistantMessage });
		await store.append(created.id, {
			type: "model_change",
			id: "c1",
			timestamp: 3,
			provider: "openai",
			modelId: "gpt-4o",
		});

		const loaded = await store.load(created.id);
		expect(loaded?.entries.map((e) => e.id)).toEqual(["m1", "m2", "c1"]);
		expect((loaded?.updatedAt ?? 0) > before).toBe(true);
	});

	test("append rejects on unknown session", async () => {
		const store = createDexieSessionStore({ dbName });
		await expect(
			store.append("not-a-session", { type: "message", id: "x", timestamp: 0, message: userMessage }),
		).rejects.toThrow(/not found/i);
	});

	test("list filters by cwd and sorts by updatedAt desc", async () => {
		const store = createDexieSessionStore({ dbName });
		const a = await store.create({ cwd: "/a" });
		await new Promise((r) => setTimeout(r, 2));
		const b = await store.create({ cwd: "/b" });
		await new Promise((r) => setTimeout(r, 2));
		const a2 = await store.create({ cwd: "/a" });

		const inA = await store.list({ cwd: "/a" });
		expect(inA.sessions.map((s) => s.sessionId)).toEqual([a2.id, a.id]);

		const all = await store.list({});
		expect(all.sessions.map((s) => s.sessionId).sort()).toEqual([a.id, a2.id, b.id].sort());
	});

	test("messageCount counts only message entries", async () => {
		const store = createDexieSessionStore({ dbName });
		const s = await store.create({ cwd: "/work" });
		await store.append(s.id, { type: "message", id: "m1", timestamp: 1, message: userMessage });
		await store.append(s.id, { type: "model_change", id: "c1", timestamp: 2, provider: "openai", modelId: "gpt-4o" });
		await store.append(s.id, { type: "message", id: "m2", timestamp: 3, message: assistantMessage });

		const list = await store.list({ cwd: "/work" });
		expect(list.sessions[0]?.messageCount).toBe(2);
	});

	test("delete cascades entries", async () => {
		const store = createDexieSessionStore({ dbName });
		const s = await store.create({ cwd: "/work" });
		await store.append(s.id, { type: "message", id: "m1", timestamp: 1, message: userMessage });
		await store.delete(s.id);
		expect(await store.load(s.id)).toBeUndefined();
		const list = await store.list({});
		expect(list.sessions).toEqual([]);
	});

	test("create + reopen new store instance preserves data", async () => {
		// First instance writes
		const a = createDexieSessionStore({ dbName });
		const s = await a.create({ cwd: "/persist" });
		await a.append(s.id, { type: "message", id: "m1", timestamp: 1, message: userMessage });

		// Second instance against the same DB name reads it
		const b = createDexieSessionStore({ dbName });
		const loaded = await b.load(s.id);
		expect(loaded?.entries.map((e) => e.id)).toEqual(["m1"]);
	});

	test("paginates 120 sessions across two pages via cursor; pages are contiguous + non-overlapping", async () => {
		const store = createDexieSessionStore({ dbName });
		const cwd = "/paginate";
		// Create 120 sessions. Reuse the dbName so they all live in one DB.
		for (let i = 0; i < 120; i++) {
			await store.create({ cwd });
		}

		const page1 = await store.list({ cwd });
		expect(page1.sessions, "first page is exactly PAGE_SIZE = 50").toHaveLength(50);
		expect(page1.nextCursor, "nextCursor present when more rows remain").toBeDefined();

		const page2 = await store.list({ cwd, cursor: page1.nextCursor });
		expect(page2.sessions, "second page is exactly PAGE_SIZE = 50").toHaveLength(50);
		expect(page2.nextCursor, "nextCursor present after page 2 (still 20 left)").toBeDefined();

		const page3 = await store.list({ cwd, cursor: page2.nextCursor });
		expect(page3.sessions, "third page is the remaining 20").toHaveLength(20);
		expect(page3.nextCursor, "nextCursor absent on the last page").toBeUndefined();

		// No overlap between pages.
		const ids1 = new Set(page1.sessions.map((s) => s.sessionId));
		const ids2 = new Set(page2.sessions.map((s) => s.sessionId));
		const ids3 = new Set(page3.sessions.map((s) => s.sessionId));
		for (const id of ids2) expect(ids1.has(id), "page 2 must not overlap page 1").toBe(false);
		for (const id of ids3) {
			expect(ids1.has(id), "page 3 must not overlap page 1").toBe(false);
			expect(ids2.has(id), "page 3 must not overlap page 2").toBe(false);
		}
		// Total coverage of all 120 sessions.
		expect(ids1.size + ids2.size + ids3.size).toBe(120);
	});

	test("malformed cursor (parseable JSON, wrong shape) resets to first page", async () => {
		const store = createDexieSessionStore({ dbName });
		const cwd = "/bad-cursor";
		for (let i = 0; i < 3; i++) await store.create({ cwd });
		const badCursor = btoa(JSON.stringify({ foo: 1 }))
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, "");
		const result = await store.list({ cwd, cursor: badCursor });
		expect(result.sessions).toHaveLength(3);
	});
});
