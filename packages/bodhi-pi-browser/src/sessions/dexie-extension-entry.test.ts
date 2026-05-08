import "fake-indexeddb/auto";
import type { ExtensionEntry, SessionEntry } from "@bodhiapp/bodhi-pi";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createDexieSessionStore } from "./dexie-session-store.js";

const dbName = "bodhi-pi-browser-ext-entry-test";

async function reset(): Promise<void> {
	await new Promise<void>((resolve) => {
		const req = indexedDB.deleteDatabase(dbName);
		req.onsuccess = () => resolve();
		req.onerror = () => resolve();
		req.onblocked = () => resolve();
	});
}

beforeEach(reset);
afterEach(reset);

function makeExt(opts: { id: string; extensionName: string; customType: string; data: unknown }): ExtensionEntry {
	return {
		type: "extension",
		id: opts.id,
		timestamp: Date.now(),
		extensionName: opts.extensionName,
		customType: opts.customType,
		data: opts.data,
	};
}

test("ExtensionEntry round-trips through Dexie via append + load", async () => {
	const store = createDexieSessionStore({ dbName });
	const { id: sessionId } = await store.create({ cwd: "/proj" });
	await store.append(
		sessionId,
		makeExt({ id: "e1", extensionName: "todo", customType: "todo-list", data: { items: ["a"] } }) as SessionEntry,
	);

	const record = await store.load(sessionId);
	expect(record?.entries).toHaveLength(1);
	const restored = record?.entries[0] as ExtensionEntry;
	expect(restored.type).toBe("extension");
	expect(restored.extensionName).toBe("todo");
	expect(restored.data).toEqual({ items: ["a"] });
});

test("readExtensionEntries filters by extensionName + customType", async () => {
	const store = createDexieSessionStore({ dbName });
	const { id: sid } = await store.create({ cwd: "/proj" });
	await store.append(sid, makeExt({ id: "e1", extensionName: "alpha", customType: "audit", data: 1 }) as SessionEntry);
	await store.append(sid, makeExt({ id: "e2", extensionName: "alpha", customType: "todo", data: 2 }) as SessionEntry);
	await store.append(sid, makeExt({ id: "e3", extensionName: "beta", customType: "audit", data: 3 }) as SessionEntry);
	await store.append(sid, {
		type: "message",
		id: "m1",
		timestamp: Date.now(),
		message: { role: "user", content: "hi" } as never,
	});

	const all = await store.readExtensionEntries(sid);
	expect(all).toHaveLength(3);

	const alpha = await store.readExtensionEntries(sid, { extensionName: "alpha" });
	expect(alpha.map((e) => e.id)).toEqual(["e1", "e2"]);

	const audits = await store.readExtensionEntries(sid, { customType: "audit" });
	expect(audits.map((e) => e.id)).toEqual(["e1", "e3"]);

	const both = await store.readExtensionEntries(sid, { extensionName: "beta", customType: "audit" });
	expect(both.map((e) => e.id)).toEqual(["e3"]);

	const empty = await store.readExtensionEntries(sid, { extensionName: "missing" });
	expect(empty).toHaveLength(0);
});
