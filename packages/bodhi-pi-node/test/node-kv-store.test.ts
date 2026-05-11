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

test("set + get + remove round-trip", async () => {
	const kv = createNodeKvStore({ dir });
	await kv.set("auth/openai", "sk-1");
	expect(await kv.get("auth/openai")).toBe("sk-1");
	await kv.remove("auth/openai");
	expect(await kv.get("auth/openai")).toBeUndefined();
});

test("list returns prefix-filtered keys", async () => {
	const kv = createNodeKvStore({ dir });
	await kv.set("auth/openai", "a");
	await kv.set("auth/anthropic", "b");
	await kv.set("other/key", "c");
	expect((await kv.list("auth/")).sort()).toEqual(["auth/anthropic", "auth/openai"]);
});

test("listWithMeta carries the secret flag", async () => {
	const kv = createNodeKvStore({ dir });
	await kv.set("auth/openai", "sk-1", { secret: true });
	await kv.set("public/k", "value", { secret: false });
	const all = await kv.listWithMeta();
	const byKey = Object.fromEntries(all.map((e: { key: string; secret: boolean }) => [e.key, e]));
	expect(byKey["auth/openai"]?.secret).toBe(true);
	expect(byKey["public/k"]?.secret).toBe(false);
});

test("secret writes chmod the file to 0o600", async () => {
	const kv = createNodeKvStore({ dir });
	await kv.set("auth/openai", "sk-1", { secret: true });
	const files = await readdir(dir);
	const target = files.find((f) => f.startsWith("auth%2Fopenai"));
	expect(target).toBeDefined();
	const st = await stat(path.join(dir, target as string));
	expect((st.mode & 0o777).toString(8)).toBe("600");
});

test("forward-slash in key encodes safely", async () => {
	const kv = createNodeKvStore({ dir });
	await kv.set("auth/openai", "sk-1");
	const files = await readdir(dir);
	expect(files.some((f) => f.includes("%2F"))).toBe(true);
	// Round-trip preserves the original key.
	const all = await kv.list();
	expect(all).toContain("auth/openai");
});

test("get on missing key returns undefined", async () => {
	const kv = createNodeKvStore({ dir });
	expect(await kv.get("missing")).toBeUndefined();
	expect(await kv.getWithMeta("missing")).toBeUndefined();
});

test("remove on missing key is a no-op", async () => {
	const kv = createNodeKvStore({ dir });
	await expect(kv.remove("missing")).resolves.toBeUndefined();
});
