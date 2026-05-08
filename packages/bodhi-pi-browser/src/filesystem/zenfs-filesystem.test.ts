import { describe, expect, test } from "vitest";
import { createZenfsFilesystem } from "./zenfs-filesystem.js";
import { mountInMemorySeed } from "./zenfs-mount.js";

// ZenFS keeps a process-global mount table; each `mountName` we use here must
// be unique within the file to avoid "already mounted" errors across tests.
let mountCounter = 0;
const nextMount = () => `m${++mountCounter}-${Date.now()}`;

describe("createZenfsFilesystem (over InMemory mount)", () => {
	test("read returns content seeded at mount time", async () => {
		const name = nextMount();
		const { rootPath } = await mountInMemorySeed({ mountName: name, files: { "/hello.txt": "world" } });
		const fs = createZenfsFilesystem();
		expect(await fs.readTextFile(`${rootPath}/hello.txt`)).toBe("world");
	});

	test("writeTextFile + readTextFile round-trip", async () => {
		const name = nextMount();
		const { rootPath } = await mountInMemorySeed({ mountName: name });
		const fs = createZenfsFilesystem();
		await fs.writeTextFile(`${rootPath}/poem.txt`, "roses are red");
		expect(await fs.readTextFile(`${rootPath}/poem.txt`)).toBe("roses are red");
	});

	test("list returns DirEntry shape with isFile/isDirectory", async () => {
		const name = nextMount();
		const { rootPath } = await mountInMemorySeed({
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
		const { rootPath } = await mountInMemorySeed({ mountName: name, files: { "/file.txt": "abcdef" } });
		const fs = createZenfsFilesystem();
		const s = await fs.stat(`${rootPath}/file.txt`);
		expect(s.isFile).toBe(true);
		expect(s.isDirectory).toBe(false);
		expect(s.size).toBeGreaterThan(0);
	});

	test("exists returns true for present, false for absent (never throws)", async () => {
		const name = nextMount();
		const { rootPath } = await mountInMemorySeed({ mountName: name, files: { "/here.txt": "x" } });
		const fs = createZenfsFilesystem();
		expect(await fs.exists(`${rootPath}/here.txt`)).toBe(true);
		expect(await fs.exists(`${rootPath}/missing.txt`)).toBe(false);
	});

	test("mkdir recursive is idempotent", async () => {
		const name = nextMount();
		const { rootPath } = await mountInMemorySeed({ mountName: name });
		const fs = createZenfsFilesystem();
		await fs.mkdir(`${rootPath}/a/b/c`, { recursive: true });
		await fs.mkdir(`${rootPath}/a/b/c`, { recursive: true });
		expect(await fs.exists(`${rootPath}/a/b/c`)).toBe(true);
	});

	test("remove recursive deletes a non-empty dir", async () => {
		const name = nextMount();
		const { rootPath } = await mountInMemorySeed({
			mountName: name,
			files: { "/sub/x": "1", "/sub/y": "2" },
		});
		const fs = createZenfsFilesystem();
		await fs.remove(`${rootPath}/sub`, { recursive: true });
		expect(await fs.exists(`${rootPath}/sub`)).toBe(false);
	});
});
