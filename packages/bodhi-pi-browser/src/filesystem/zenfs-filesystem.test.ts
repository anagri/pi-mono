import { configure, InMemory, mount, fs as zenFs } from "@zenfs/core";
import { describe, expect, test } from "vitest";
import { createZenfsFilesystem } from "./zenfs-filesystem.js";

// ZenFS keeps a process-global mount table; each `mountName` we use here must
// be unique within the file to avoid "already mounted" errors across tests.
let mountCounter = 0;
const nextMount = () => `m${++mountCounter}-${Date.now()}`;

let zenfsConfigured = false;
async function ensureZenfs(): Promise<void> {
	if (zenfsConfigured) return;
	await configure({ mounts: {} });
	zenfsConfigured = true;
}

/**
 * Test-local in-memory mount helper. Lives here (not in the publishable
 * `bodhi-pi-browser` surface) per the "test fixtures stay out of the
 * publishable surface" rule. Inlines what `mountInMemorySeed` used to do.
 */
async function mountInMemoryFixture(opts: { mountName: string; files?: Record<string, string> }): Promise<{
	rootPath: string;
}> {
	await ensureZenfs();
	const rootPath = `/mnt/${opts.mountName}`;
	mount(rootPath, InMemory.create({ label: opts.mountName }));
	const files = opts.files ?? {};
	for (const rel of Object.keys(files).sort()) {
		const absolute = rel.startsWith("/") ? `${rootPath}${rel}` : `${rootPath}/${rel}`;
		const slash = absolute.lastIndexOf("/");
		if (slash > rootPath.length) {
			try {
				await zenFs.promises.mkdir(absolute.slice(0, slash), { recursive: true });
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			}
		}
		await zenFs.promises.writeFile(absolute, files[rel] ?? "", { encoding: "utf-8" });
	}
	return { rootPath };
}

describe("createZenfsFilesystem (over InMemory mount)", () => {
	test("read returns content seeded at mount time", async () => {
		const name = nextMount();
		const { rootPath } = await mountInMemoryFixture({ mountName: name, files: { "/hello.txt": "world" } });
		const fs = createZenfsFilesystem();
		expect(await fs.readTextFile(`${rootPath}/hello.txt`)).toBe("world");
	});

	test("writeTextFile + readTextFile round-trip", async () => {
		const name = nextMount();
		const { rootPath } = await mountInMemoryFixture({ mountName: name });
		const fs = createZenfsFilesystem();
		await fs.writeTextFile(`${rootPath}/poem.txt`, "roses are red");
		expect(await fs.readTextFile(`${rootPath}/poem.txt`)).toBe("roses are red");
	});

	test("list returns DirEntry shape with isFile/isDirectory", async () => {
		const name = nextMount();
		const { rootPath } = await mountInMemoryFixture({
			mountName: name,
			files: { "/a.md": "A", "/sub/b.md": "B" },
		});
		const fs = createZenfsFilesystem();
		const top = await fs.list(rootPath);
		const names = top.map((e) => e.name).sort();
		expect(names).toEqual(["a.md", "sub"]);
		const a = top.find((e) => e.name === "a.md");
		const sub = top.find((e) => e.name === "sub");
		expect(a?.isFile).toBe(true);
		expect(sub?.isDirectory).toBe(true);
	});

	test("stat returns isFile/isDirectory + size", async () => {
		const name = nextMount();
		const { rootPath } = await mountInMemoryFixture({ mountName: name, files: { "/file.txt": "abcdef" } });
		const fs = createZenfsFilesystem();
		const s = await fs.stat(`${rootPath}/file.txt`);
		expect(s.isFile).toBe(true);
		expect(s.isDirectory).toBe(false);
		expect(s.size).toBeGreaterThan(0);
	});

	test("exists returns true for present, false for absent (never throws)", async () => {
		const name = nextMount();
		const { rootPath } = await mountInMemoryFixture({ mountName: name, files: { "/here.txt": "x" } });
		const fs = createZenfsFilesystem();
		expect(await fs.exists(`${rootPath}/here.txt`)).toBe(true);
		expect(await fs.exists(`${rootPath}/missing.txt`)).toBe(false);
	});

	test("mkdir recursive is idempotent", async () => {
		const name = nextMount();
		const { rootPath } = await mountInMemoryFixture({ mountName: name });
		const fs = createZenfsFilesystem();
		await fs.mkdir(`${rootPath}/a/b/c`, { recursive: true });
		await fs.mkdir(`${rootPath}/a/b/c`, { recursive: true });
		expect(await fs.exists(`${rootPath}/a/b/c`)).toBe(true);
	});

	test("remove recursive deletes a non-empty dir", async () => {
		const name = nextMount();
		const { rootPath } = await mountInMemoryFixture({
			mountName: name,
			files: { "/sub/x": "1", "/sub/y": "2" },
		});
		const fs = createZenfsFilesystem();
		await fs.remove(`${rootPath}/sub`, { recursive: true });
		expect(await fs.exists(`${rootPath}/sub`)).toBe(false);
	});
});
