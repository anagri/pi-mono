import "fake-indexeddb/auto";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createDexieSessionStore } from "./dexie-session-store.js";

// fake-indexeddb persists across tests by default; reset by deleting the DB.
async function reset(dbName: string) {
	await new Promise<void>((resolve) => {
		const req = indexedDB.deleteDatabase(dbName);
		req.onsuccess = () => resolve();
		req.onerror = () => resolve();
		req.onblocked = () => resolve();
	});
}

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
});
