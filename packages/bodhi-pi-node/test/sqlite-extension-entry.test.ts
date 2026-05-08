import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionEntry, SessionEntry } from "@bodhiapp/bodhi-pi";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createSqliteSessionStore } from "@/sessions/sqlite-session-store.js";

let dbPath: string;
let store: ReturnType<typeof createSqliteSessionStore>;

beforeEach(() => {
	dbPath = path.join(os.tmpdir(), `bodhi-pi-ext-entry-${Date.now()}.db`);
	store = createSqliteSessionStore(dbPath);
});

afterEach(() => {
	try {
		fs.unlinkSync(dbPath);
		fs.unlinkSync(`${dbPath}-wal`);
		fs.unlinkSync(`${dbPath}-shm`);
	} catch {
		// ignore
	}
});

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

test("ExtensionEntry round-trips through SQLite via append + load", async () => {
	const { id: sessionId } = await store.create({ cwd: "/proj" });
	const entry = makeExt({ id: "e1", extensionName: "todo", customType: "todo-list", data: { items: ["a", "b"] } });
	await store.append(sessionId, entry as SessionEntry);

	const record = await store.load(sessionId);
	expect(record).toBeDefined();
	expect(record!.entries).toHaveLength(1);
	const restored = record!.entries[0] as ExtensionEntry;
	expect(restored.type).toBe("extension");
	expect(restored.extensionName).toBe("todo");
	expect(restored.customType).toBe("todo-list");
	expect(restored.data).toEqual({ items: ["a", "b"] });
});

test("readExtensionEntries returns only extension entries, filtered by extensionName + customType", async () => {
	const { id: sessionId } = await store.create({ cwd: "/proj" });
	await store.append(
		sessionId,
		makeExt({ id: "e1", extensionName: "alpha", customType: "audit", data: 1 }) as SessionEntry,
	);
	await store.append(
		sessionId,
		makeExt({ id: "e2", extensionName: "alpha", customType: "todo", data: 2 }) as SessionEntry,
	);
	await store.append(
		sessionId,
		makeExt({ id: "e3", extensionName: "beta", customType: "audit", data: 3 }) as SessionEntry,
	);
	await store.append(sessionId, {
		type: "message",
		id: "m1",
		timestamp: Date.now(),
		message: { role: "user", content: "hi" } as never,
	});

	const all = await store.readExtensionEntries(sessionId);
	expect(all).toHaveLength(3);

	const alpha = await store.readExtensionEntries(sessionId, { extensionName: "alpha" });
	expect(alpha.map((e) => e.id)).toEqual(["e1", "e2"]);

	const audits = await store.readExtensionEntries(sessionId, { customType: "audit" });
	expect(audits.map((e) => e.id)).toEqual(["e1", "e3"]);

	const both = await store.readExtensionEntries(sessionId, { extensionName: "beta", customType: "audit" });
	expect(both.map((e) => e.id)).toEqual(["e3"]);

	const empty = await store.readExtensionEntries(sessionId, { extensionName: "missing" });
	expect(empty).toHaveLength(0);
});
