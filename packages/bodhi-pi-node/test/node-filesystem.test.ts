import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeFilesystem } from "@/filesystem/node-filesystem.js";

let root: string;
let filesystem: ReturnType<typeof createNodeFilesystem>;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "bodhi-pi-cli-fs-"));
	filesystem = createNodeFilesystem({ rootCwd: root });
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

describe("readTextFile / writeTextFile", () => {
	it("round-trips text", async () => {
		await filesystem.writeTextFile(path.join(root, "hello.txt"), "world");
		expect(await filesystem.readTextFile(path.join(root, "hello.txt"))).toBe("world");
	});

	it("throws ENOENT for missing file", async () => {
		await expect(filesystem.readTextFile(path.join(root, "nope.txt"))).rejects.toMatchObject({ code: "ENOENT" });
	});
});

describe("list", () => {
	it("returns direct children sorted by fs order", async () => {
		await fs.writeFile(path.join(root, "a.txt"), "");
		await fs.mkdir(path.join(root, "dir1"));
		await fs.writeFile(path.join(root, "b.txt"), "");

		const entries = await filesystem.list(root);
		const names = entries.map((e) => e.name);
		expect(names).toContain("a.txt");
		expect(names).toContain("b.txt");
		expect(names).toContain("dir1");

		const dir1 = entries.find((e) => e.name === "dir1")!;
		expect(dir1.isDirectory).toBe(true);
		expect(dir1.isFile).toBe(false);
	});

	it("throws ENOENT for missing directory", async () => {
		await expect(filesystem.list(path.join(root, "nope"))).rejects.toMatchObject({ code: "ENOENT" });
	});
});

describe("stat", () => {
	it("returns file stat", async () => {
		await fs.writeFile(path.join(root, "f.txt"), "abc");
		const s = await filesystem.stat(path.join(root, "f.txt"));
		expect(s.isFile).toBe(true);
		expect(s.isDirectory).toBe(false);
		expect(s.size).toBeGreaterThan(0);
		expect(s.mtimeMs).toBeGreaterThan(0);
	});

	it("throws ENOENT for missing path", async () => {
		await expect(filesystem.stat(path.join(root, "ghost"))).rejects.toMatchObject({ code: "ENOENT" });
	});
});

describe("exists", () => {
	it("returns true for existing file", async () => {
		await fs.writeFile(path.join(root, "x.txt"), "");
		expect(await filesystem.exists(path.join(root, "x.txt"))).toBe(true);
	});

	it("returns false for missing path", async () => {
		expect(await filesystem.exists(path.join(root, "missing"))).toBe(false);
	});
});

describe("mkdir", () => {
	it("creates a directory", async () => {
		await filesystem.mkdir(path.join(root, "newdir"));
		const s = await fs.stat(path.join(root, "newdir"));
		expect(s.isDirectory()).toBe(true);
	});

	it("recursive creates nested dirs", async () => {
		await filesystem.mkdir(path.join(root, "a", "b", "c"), { recursive: true });
		const s = await fs.stat(path.join(root, "a", "b", "c"));
		expect(s.isDirectory()).toBe(true);
	});
});

describe("remove", () => {
	it("removes a file", async () => {
		await fs.writeFile(path.join(root, "del.txt"), "");
		await filesystem.remove(path.join(root, "del.txt"));
		expect(await filesystem.exists(path.join(root, "del.txt"))).toBe(false);
	});

	it("removes a directory recursively", async () => {
		await fs.mkdir(path.join(root, "subdir"));
		await fs.writeFile(path.join(root, "subdir", "file.txt"), "");
		await filesystem.remove(path.join(root, "subdir"), { recursive: true });
		expect(await filesystem.exists(path.join(root, "subdir"))).toBe(false);
	});
});

describe("jail", () => {
	it("rejects paths that escape the root", async () => {
		const outside = path.join(root, "..", "outside.txt");
		await expect(filesystem.readTextFile(outside)).rejects.toMatchObject({ code: "EACCES" });
	});

	it("rejects absolute paths outside root", async () => {
		await expect(filesystem.readTextFile("/etc/passwd")).rejects.toMatchObject({ code: "EACCES" });
	});
});

describe("factory signature parity", () => {
	it("only the options-object form compiles (positional rootCwd was removed)", () => {
		// Compile-time enforcement: this test exists to document the public contract.
		// `createNodeFilesystem({ rootCwd })` is the only call shape that type-checks.
		// `createNodeFilesystem(rootCwd)` (positional) would be a parity violation
		// against `bodhi-pi-browser` factories — see both packages' CLAUDE.md.
		const fsHandle = createNodeFilesystem({ rootCwd: root });
		expect(typeof fsHandle.readTextFile).toBe("function");
		// @ts-expect-error positional string is not assignable to `NodeFilesystemOptions`
		const _shouldNotCompile = createNodeFilesystem(root);
		expect(_shouldNotCompile).toBeDefined(); // runtime is permissive; the TS error is what we assert
	});
});
