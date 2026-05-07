import { describe, expect, test } from "vitest";
import { createInMemoryFilesystem } from "./in-memory-filesystem.js";

describe("in-memory filesystem error contract", () => {
	test("readTextFile rejects with ENOENT for missing file", async () => {
		const fs = createInMemoryFilesystem();
		await expect(fs.readTextFile("/missing.txt")).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("readTextFile rejects with EISDIR for a directory path", async () => {
		const fs = createInMemoryFilesystem();
		await fs.mkdir("/dir");
		await expect(fs.readTextFile("/dir")).rejects.toMatchObject({ code: "EISDIR" });
	});

	test("list rejects with ENOENT for missing dir", async () => {
		const fs = createInMemoryFilesystem();
		await expect(fs.list("/nope")).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("list rejects with ENOTDIR when path is a file", async () => {
		const fs = createInMemoryFilesystem();
		await fs.writeTextFile("/file.txt", "x");
		await expect(fs.list("/file.txt")).rejects.toMatchObject({ code: "ENOTDIR" });
	});

	test("mkdir rejects with EEXIST when dir already exists (no recursive)", async () => {
		const fs = createInMemoryFilesystem();
		await fs.mkdir("/existing");
		await expect(fs.mkdir("/existing")).rejects.toMatchObject({ code: "EEXIST" });
	});

	test("mkdir rejects with ENOENT when parent missing (no recursive)", async () => {
		const fs = createInMemoryFilesystem();
		await expect(fs.mkdir("/a/b/c")).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("remove rejects with ENOTEMPTY on a non-empty dir without recursive", async () => {
		const fs = createInMemoryFilesystem();
		await fs.mkdir("/d");
		await fs.writeTextFile("/d/x.txt", "x");
		await expect(fs.remove("/d")).rejects.toMatchObject({ code: "ENOTEMPTY" });
	});

	test("remove on missing path is a no-op", async () => {
		const fs = createInMemoryFilesystem();
		await expect(fs.remove("/missing")).resolves.toBeUndefined();
	});
});

describe("in-memory filesystem happy paths", () => {
	test("write then read round-trips UTF-8 text", async () => {
		const fs = createInMemoryFilesystem();
		await fs.writeTextFile("/notes.txt", "héllo");
		expect(await fs.readTextFile("/notes.txt")).toBe("héllo");
	});

	test("mkdir({ recursive: true }) creates intermediate dirs and is idempotent", async () => {
		const fs = createInMemoryFilesystem();
		await fs.mkdir("/a/b/c", { recursive: true });
		expect(await fs.exists("/a")).toBe(true);
		expect(await fs.exists("/a/b")).toBe(true);
		expect(await fs.exists("/a/b/c")).toBe(true);
		await fs.mkdir("/a/b/c", { recursive: true });
		expect(await fs.exists("/a/b/c")).toBe(true);
	});

	test("remove({ recursive: true }) cascades through children", async () => {
		const fs = createInMemoryFilesystem();
		await fs.mkdir("/d");
		await fs.writeTextFile("/d/x.txt", "x");
		await fs.writeTextFile("/d/y.txt", "y");
		await fs.mkdir("/d/sub");
		await fs.writeTextFile("/d/sub/z.txt", "z");

		await fs.remove("/d", { recursive: true });
		expect(await fs.exists("/d")).toBe(false);
		expect(await fs.exists("/d/x.txt")).toBe(false);
		expect(await fs.exists("/d/sub/z.txt")).toBe(false);
	});

	test("exists never throws and returns boolean", async () => {
		const fs = createInMemoryFilesystem();
		expect(await fs.exists("/missing")).toBe(false);
		await fs.writeTextFile("/file.txt", "x");
		expect(await fs.exists("/file.txt")).toBe(true);
	});

	test("stat reports size + isFile/isDirectory", async () => {
		const fs = createInMemoryFilesystem();
		await fs.writeTextFile("/file.txt", "abcde");
		const fileStat = await fs.stat("/file.txt");
		expect(fileStat.isFile).toBe(true);
		expect(fileStat.isDirectory).toBe(false);
		expect(fileStat.size).toBe(5);
		expect(fileStat.mtimeMs).toBeGreaterThan(0);

		await fs.mkdir("/dir");
		const dirStat = await fs.stat("/dir");
		expect(dirStat.isDirectory).toBe(true);
		expect(dirStat.isFile).toBe(false);
	});

	test("list returns direct children only, sorted alphabetically", async () => {
		const fs = createInMemoryFilesystem();
		await fs.writeTextFile("/b.txt", "b");
		await fs.writeTextFile("/a.txt", "a");
		await fs.mkdir("/sub");
		await fs.writeTextFile("/sub/nested.txt", "should not show at root");

		const entries = await fs.list("/");
		expect(entries.map((e) => e.name)).toEqual(["a.txt", "b.txt", "sub"]);
		expect(entries.find((e) => e.name === "sub")?.isDirectory).toBe(true);
		expect(entries.find((e) => e.name === "a.txt")?.isFile).toBe(true);
	});
});
