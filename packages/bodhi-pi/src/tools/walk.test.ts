import { describe, expect, test } from "vitest";
import { createInMemoryFilesystem } from "@/filesystem/in-memory-filesystem.js";
import { walk } from "./walk.js";

async function collect(gen: AsyncIterable<{ absolutePath: string }>): Promise<string[]> {
	const out: string[] = [];
	for await (const e of gen) out.push(e.absolutePath);
	return out;
}

describe("walk", () => {
	test("yields all files in a flat directory", async () => {
		const fs = createInMemoryFilesystem();
		await fs.writeTextFile("/a.txt", "a");
		await fs.writeTextFile("/b.txt", "b");
		await fs.writeTextFile("/c.txt", "c");

		const seen = await collect(walk(fs, "/"));
		expect(seen.sort()).toEqual(["/a.txt", "/b.txt", "/c.txt"]);
	});

	test("recurses into nested directories", async () => {
		const fs = createInMemoryFilesystem();
		await fs.mkdir("/sub", { recursive: true });
		await fs.writeTextFile("/sub/inner.txt", "x");
		await fs.writeTextFile("/top.txt", "y");

		const seen = await collect(walk(fs, "/"));
		expect(seen).toContain("/top.txt");
		expect(seen).toContain("/sub");
		expect(seen).toContain("/sub/inner.txt");
	});

	test("default skip-list excludes .git and node_modules", async () => {
		const fs = createInMemoryFilesystem();
		await fs.mkdir("/.git", { recursive: true });
		await fs.writeTextFile("/.git/config", "[core]");
		await fs.mkdir("/node_modules/pkg", { recursive: true });
		await fs.writeTextFile("/node_modules/pkg/index.js", "x");
		await fs.writeTextFile("/main.ts", "y");

		const seen = await collect(walk(fs, "/"));
		expect(seen).not.toContain("/.git/config");
		expect(seen).not.toContain("/node_modules/pkg/index.js");
		expect(seen).toContain("/main.ts");
	});

	test("custom skipDir predicate is honoured", async () => {
		const fs = createInMemoryFilesystem();
		await fs.mkdir("/skipme", { recursive: true });
		await fs.writeTextFile("/skipme/secret.txt", "x");
		await fs.writeTextFile("/keep.txt", "y");

		const seen = await collect(walk(fs, "/", { skipDir: (p) => p === "/skipme" }));
		expect(seen).not.toContain("/skipme/secret.txt");
		expect(seen).toContain("/keep.txt");
	});

	test("maxEntries caps yielded entries", async () => {
		const fs = createInMemoryFilesystem();
		for (let i = 0; i < 20; i++) await fs.writeTextFile(`/f${i}.txt`, "x");

		const seen = await collect(walk(fs, "/", { maxEntries: 5 }));
		expect(seen).toHaveLength(5);
	});

	test("AbortSignal stops iteration before the next directory pop", async () => {
		const fs = createInMemoryFilesystem();
		await fs.writeTextFile("/a.txt", "x");
		await fs.writeTextFile("/b.txt", "x");

		const ctrl = new AbortController();
		ctrl.abort();
		const seen = await collect(walk(fs, "/", { signal: ctrl.signal }));
		expect(seen).toHaveLength(0);
	});

	test("empty directory yields nothing", async () => {
		const fs = createInMemoryFilesystem();
		await fs.mkdir("/empty");

		const seen = await collect(walk(fs, "/empty"));
		expect(seen).toEqual([]);
	});

	test("missing root throws — distinguishes 'unreadable root' from 'empty tree'", async () => {
		const fs = createInMemoryFilesystem();
		await expect(collect(walk(fs, "/does-not-exist"))).rejects.toThrow();
	});

	test("subdirectory failure is tolerated; root succeeds", async () => {
		// list() throws on the bad subpath but not on root; walk should swallow the
		// subdir failure and continue, yielding root entries.
		const real = createInMemoryFilesystem();
		await real.writeTextFile("/keep.txt", "x");
		await real.mkdir("/sub", { recursive: true });
		await real.writeTextFile("/sub/inner.txt", "y");
		const wrapped = {
			...real,
			list: async (p: string) => {
				if (p === "/sub") throw new Error("simulated subdir failure");
				return real.list(p);
			},
		};
		const seen = await collect(walk(wrapped as typeof real, "/"));
		expect(seen).toContain("/keep.txt");
		expect(seen).toContain("/sub");
		expect(seen).not.toContain("/sub/inner.txt");
	});
});
