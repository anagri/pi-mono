import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { resetDb } from "../sessions/_test-helpers/reset-db.js";
import { createDexieKvStore } from "./dexie-kv-store.js";

const dbName = "bodhi-pi-kv-test";

describe("createDexieKvStore", () => {
	beforeEach(async () => {
		await resetDb(dbName);
	});
	afterEach(async () => {
		await resetDb(dbName);
	});

	test("set + get round-trip", async () => {
		const kv = createDexieKvStore({ dbName });
		await kv.set("auth/openai", "sk-1");
		expect(await kv.get("auth/openai")).toBe("sk-1");
	});

	test("secret entries land in kv_secret table; meta reflects this", async () => {
		const kv = createDexieKvStore({ dbName });
		await kv.set("auth/openai", "sk-1", { secret: true });
		await kv.set("public/k", "value", { secret: false });
		const meta = await kv.getWithMeta("auth/openai");
		expect(meta).toEqual({ value: "sk-1", secret: true });
		const pubMeta = await kv.getWithMeta("public/k");
		expect(pubMeta).toEqual({ value: "value", secret: false });
	});

	test("re-setting an existing key migrates between tables", async () => {
		const kv = createDexieKvStore({ dbName });
		await kv.set("foo", "v1", { secret: false });
		await kv.set("foo", "v2", { secret: true });
		const meta = await kv.getWithMeta("foo");
		expect(meta).toEqual({ value: "v2", secret: true });
		// Only one entry should be observable.
		const all = await kv.listWithMeta();
		expect(all.filter((e: { key: string }) => e.key === "foo")).toHaveLength(1);
	});

	test("listWithMeta with prefix filters across both tables", async () => {
		const kv = createDexieKvStore({ dbName });
		await kv.set("auth/openai", "a", { secret: true });
		await kv.set("auth/anthropic", "b", { secret: true });
		await kv.set("other/k", "c");
		const auth = await kv.listWithMeta("auth/");
		expect(auth.map((e: { key: string }) => e.key).sort()).toEqual(["auth/anthropic", "auth/openai"]);
		expect(auth.every((e: { secret: boolean }) => e.secret)).toBe(true);
	});

	test("remove clears both tables", async () => {
		const kv = createDexieKvStore({ dbName });
		await kv.set("foo", "v1", { secret: true });
		await kv.remove("foo");
		expect(await kv.get("foo")).toBeUndefined();
	});

	test("get on missing key returns undefined", async () => {
		const kv = createDexieKvStore({ dbName });
		expect(await kv.get("missing")).toBeUndefined();
		expect(await kv.getWithMeta("missing")).toBeUndefined();
	});
});
