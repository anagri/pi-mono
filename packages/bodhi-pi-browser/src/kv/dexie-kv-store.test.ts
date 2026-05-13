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

	test("set + get round-trip for plain string", async () => {
		const kv = createDexieKvStore({ dbName });
		await kv.set("auth/openai", "sk-1");
		expect(await kv.get("auth/openai")).toBe("sk-1");
	});

	test("set + get round-trip for JSON object with secret marker", async () => {
		const kv = createDexieKvStore({ dbName });
		await kv.set("auth/openai", { api_key: { value: "sk-1", secret: true }, base_url: "http://h" });
		expect(await kv.get("auth/openai")).toEqual({
			api_key: { value: "sk-1", secret: true },
			base_url: "http://h",
		});
	});

	test("re-setting an existing key overwrites", async () => {
		const kv = createDexieKvStore({ dbName });
		await kv.set("foo", "v1");
		await kv.set("foo", { x: 1 });
		expect(await kv.get("foo")).toEqual({ x: 1 });
		const all = await kv.list();
		expect(all.filter((e) => e.key === "foo")).toHaveLength(1);
	});

	test("list with prefix filters", async () => {
		const kv = createDexieKvStore({ dbName });
		await kv.set("auth/openai", { api_key: { value: "a", secret: true } });
		await kv.set("auth/anthropic", { api_key: { value: "b", secret: true } });
		await kv.set("other/k", "c");
		const auth = await kv.list("auth/");
		expect(auth.map((e) => e.key).sort()).toEqual(["auth/anthropic", "auth/openai"]);
		const byKey = Object.fromEntries(auth.map((e) => [e.key, e.value]));
		expect(byKey["auth/openai"]).toEqual({ api_key: { value: "a", secret: true } });
	});

	test("remove clears the entry", async () => {
		const kv = createDexieKvStore({ dbName });
		await kv.set("foo", { v: 1 });
		await kv.remove("foo");
		expect(await kv.get("foo")).toBeUndefined();
	});

	test("get on missing key returns undefined", async () => {
		const kv = createDexieKvStore({ dbName });
		expect(await kv.get("missing")).toBeUndefined();
	});
});
