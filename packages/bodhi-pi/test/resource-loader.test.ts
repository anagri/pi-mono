import { describe, expect, test } from "vitest";
import { createInMemoryFilesystem } from "@/index.js";
import { loadProjectContextFiles } from "@/sessions/resource-loader.js";

async function seed(fs: ReturnType<typeof createInMemoryFilesystem>, abspath: string, content: string) {
	const dir = abspath.slice(0, abspath.lastIndexOf("/"));
	if (dir) await fs.mkdir(dir, { recursive: true });
	await fs.writeTextFile(abspath, content);
}

describe("loadProjectContextFiles", () => {
	test("returns empty when no candidate files exist", async () => {
		const fs = createInMemoryFilesystem();
		await fs.mkdir("/proj", { recursive: true });
		const out = await loadProjectContextFiles(fs, "/proj");
		expect(out).toEqual([]);
	});

	test("picks AGENTS.md at cwd", async () => {
		const fs = createInMemoryFilesystem();
		await seed(fs, "/proj/AGENTS.md", "alpha-instructions");
		const out = await loadProjectContextFiles(fs, "/proj");
		expect(out).toEqual([{ path: "/proj/AGENTS.md", content: "alpha-instructions" }]);
	});

	test("walks ancestors, root-first ordering", async () => {
		const fs = createInMemoryFilesystem();
		await seed(fs, "/AGENTS.md", "root-text");
		await seed(fs, "/proj/AGENTS.md", "proj-text");
		await seed(fs, "/proj/sub/AGENTS.md", "sub-text");
		const out = await loadProjectContextFiles(fs, "/proj/sub");
		expect(out.map((f) => f.path)).toEqual(["/AGENTS.md", "/proj/AGENTS.md", "/proj/sub/AGENTS.md"]);
		expect(out.map((f) => f.content)).toEqual(["root-text", "proj-text", "sub-text"]);
	});

	test("AGENTS.md takes precedence over CLAUDE.md in the same directory", async () => {
		const fs = createInMemoryFilesystem();
		await seed(fs, "/proj/AGENTS.md", "agents");
		await seed(fs, "/proj/CLAUDE.md", "claude");
		const out = await loadProjectContextFiles(fs, "/proj");
		expect(out).toEqual([{ path: "/proj/AGENTS.md", content: "agents" }]);
	});

	test("CLAUDE.md falls back when AGENTS.md is absent", async () => {
		const fs = createInMemoryFilesystem();
		await seed(fs, "/proj/CLAUDE.md", "claude-text");
		const out = await loadProjectContextFiles(fs, "/proj");
		expect(out).toEqual([{ path: "/proj/CLAUDE.md", content: "claude-text" }]);
	});

	test("AGENTS.MD uppercase variant resolves", async () => {
		const fs = createInMemoryFilesystem();
		await seed(fs, "/proj/AGENTS.MD", "upper-text");
		const out = await loadProjectContextFiles(fs, "/proj");
		expect(out).toEqual([{ path: "/proj/AGENTS.MD", content: "upper-text" }]);
	});
});
