import { describe, expect, test } from "vitest";
import { createInMemoryFilesystem } from "../filesystem/in-memory-filesystem.js";
import { loadProjectCommands } from "./discovery.js";

const CWD = "/proj";
const DIR = "/proj/.bodhi-pi/commands";

async function setup(files: Record<string, string>) {
	const fs = createInMemoryFilesystem();
	if (Object.keys(files).length > 0) {
		await fs.mkdir(DIR, { recursive: true });
		for (const [name, content] of Object.entries(files)) {
			await fs.writeTextFile(`${DIR}/${name}`, content);
		}
	}
	return fs;
}

describe("loadProjectCommands", () => {
	test("missing directory returns empty list", async () => {
		const fs = createInMemoryFilesystem();
		expect(await loadProjectCommands(fs, CWD)).toEqual([]);
	});

	test("empty directory returns empty list", async () => {
		const fs = createInMemoryFilesystem();
		await fs.mkdir(DIR, { recursive: true });
		expect(await loadProjectCommands(fs, CWD)).toEqual([]);
	});

	test("single file with full frontmatter", async () => {
		const fs = await setup({
			"greet.md": "---\ndescription: Greet someone\nargument-hint: <name>\n---\nSay hello to $1.\n",
		});
		const cmds = await loadProjectCommands(fs, CWD);
		expect(cmds).toHaveLength(1);
		expect(cmds[0]).toEqual({
			name: "greet",
			description: "Greet someone",
			argumentHint: "<name>",
			content: "Say hello to $1.\n",
			filePath: `${DIR}/greet.md`,
		});
	});

	test("file without frontmatter — description from first body line", async () => {
		const fs = await setup({
			"plain.md": "Reply with foo.\nMore.\n",
		});
		const cmds = await loadProjectCommands(fs, CWD);
		expect(cmds).toHaveLength(1);
		expect(cmds[0].description).toBe("Reply with foo.");
		expect(cmds[0].argumentHint).toBeUndefined();
	});

	test("description truncated to 60 chars with ellipsis", async () => {
		const longLine = "x".repeat(100);
		const fs = await setup({ "long.md": `${longLine}\n` });
		const cmds = await loadProjectCommands(fs, CWD);
		expect(cmds[0].description).toBe(`${"x".repeat(60)}…`);
	});

	test("malformed YAML — file silently skipped, siblings still loaded", async () => {
		const fs = await setup({
			"bad.md": "---\ndescription: [broken\n---\nbody\n",
			"good.md": "---\ndescription: ok\n---\nbody\n",
		});
		const cmds = await loadProjectCommands(fs, CWD);
		expect(cmds.map((c) => c.name)).toEqual(["good"]);
	});

	test("non-.md files ignored", async () => {
		const fs = await setup({
			"keep.md": "body\n",
			"skip.txt": "body\n",
			README: "body\n",
		});
		const cmds = await loadProjectCommands(fs, CWD);
		expect(cmds.map((c) => c.name)).toEqual(["keep"]);
	});

	test("subdirectories are not recursed", async () => {
		const fs = createInMemoryFilesystem();
		await fs.mkdir(`${DIR}/nested`, { recursive: true });
		await fs.writeTextFile(`${DIR}/nested/inner.md`, "body\n");
		await fs.writeTextFile(`${DIR}/top.md`, "top body\n");
		const cmds = await loadProjectCommands(fs, CWD);
		expect(cmds.map((c) => c.name)).toEqual(["top"]);
	});

	test("results sorted by name", async () => {
		const fs = await setup({
			"charlie.md": "c\n",
			"alpha.md": "a\n",
			"bravo.md": "b\n",
		});
		const cmds = await loadProjectCommands(fs, CWD);
		expect(cmds.map((c) => c.name)).toEqual(["alpha", "bravo", "charlie"]);
	});
});
