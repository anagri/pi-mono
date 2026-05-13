import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createNodeKvStore } from "@/kv/node-kv-store.js";

let dir = "";

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), "bodhi-pi-kv-"));
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

test("set + get + remove round-trip for plain string", async () => {
	const kv = createNodeKvStore({ dir });
	await kv.set("public/k", "value");
	expect(await kv.get("public/k")).toBe("value");
	await kv.remove("public/k");
	expect(await kv.get("public/k")).toBeUndefined();
});

test("set + get round-trip for JSON object with secret marker", async () => {
	const kv = createNodeKvStore({ dir });
	await kv.set("auth/openai", { api_key: { value: "sk-1", secret: true }, base_url: "http://h" });
	expect(await kv.get("auth/openai")).toEqual({
		api_key: { value: "sk-1", secret: true },
		base_url: "http://h",
	});
});

test("list returns prefix-filtered entries with full JSON values", async () => {
	const kv = createNodeKvStore({ dir });
	await kv.set("auth/openai", { api_key: { value: "a", secret: true } });
	await kv.set("auth/anthropic", { api_key: { value: "b", secret: true } });
	await kv.set("other/key", "c");
	const auth = await kv.list("auth/");
	expect(auth.map((e) => e.key).sort()).toEqual(["auth/anthropic", "auth/openai"]);
	const byKey = Object.fromEntries(auth.map((e) => [e.key, e.value]));
	expect(byKey["auth/openai"]).toEqual({ api_key: { value: "a", secret: true } });
});

test("entries containing a secret marker are chmod 0o600", async () => {
	const kv = createNodeKvStore({ dir });
	await kv.set("auth/openai", { api_key: { value: "sk-1", secret: true } });
	const files = await readdir(dir);
	const target = files.find((f) => f.startsWith("auth%2Fopenai"));
	expect(target).toBeDefined();
	const st = await stat(path.join(dir, target as string));
	expect((st.mode & 0o777).toString(8)).toBe("600");
});

test("non-secret entries are not chmod 0o600", async () => {
	const kv = createNodeKvStore({ dir });
	await kv.set("public/k", "value");
	const files = await readdir(dir);
	const target = files.find((f) => f.startsWith("public"));
	expect(target).toBeDefined();
	const st = await stat(path.join(dir, target as string));
	expect((st.mode & 0o777).toString(8)).not.toBe("600");
});

test("forward-slash in key encodes safely", async () => {
	const kv = createNodeKvStore({ dir });
	await kv.set("auth/openai", "v");
	const files = await readdir(dir);
	expect(files.some((f) => f.includes("%2F"))).toBe(true);
	const all = await kv.list();
	expect(all.map((e) => e.key)).toContain("auth/openai");
});

test("get on missing key returns undefined", async () => {
	const kv = createNodeKvStore({ dir });
	expect(await kv.get("missing")).toBeUndefined();
});

test("remove on missing key is a no-op", async () => {
	const kv = createNodeKvStore({ dir });
	await expect(kv.remove("missing")).resolves.toBeUndefined();
});
