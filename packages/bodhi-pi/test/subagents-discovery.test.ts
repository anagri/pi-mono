import { expect, test } from "vitest";
import { createInMemoryFilesystem } from "@/index.js";
import { loadProjectSubagents } from "@/subagents/discovery.js";
import { seedSubagent } from "./helpers/filesystem.js";

test("loadProjectSubagents returns [] when .bodhi-pi/agents/ missing", async () => {
	const fs = createInMemoryFilesystem();
	const profiles = await loadProjectSubagents(fs, "/proj");
	expect(profiles).toEqual([]);
});

test("loadProjectSubagents parses a single profile with required fields", async () => {
	const fs = createInMemoryFilesystem();
	await seedSubagent(
		fs,
		"/proj",
		"extractor",
		"---\nname: extractor\ndescription: Read a file and summarize\ntools:\n  - read\n---\nYou are an extractor.\n",
	);

	const profiles = await loadProjectSubagents(fs, "/proj");
	expect(profiles).toHaveLength(1);
	expect(profiles[0]).toMatchObject({
		name: "extractor",
		description: "Read a file and summarize",
		context: "fresh",
		tools: ["read"],
		maxTurns: 50,
		body: "You are an extractor.",
	});
});

test("loadProjectSubagents derives name from filename when frontmatter omits it", async () => {
	const fs = createInMemoryFilesystem();
	await seedSubagent(fs, "/proj", "extractor", "---\ndescription: From filename\n---\nbody\n");
	const profiles = await loadProjectSubagents(fs, "/proj");
	expect(profiles[0]?.name).toBe("extractor");
});

test("loadProjectSubagents drops profiles with missing description", async () => {
	const fs = createInMemoryFilesystem();
	await seedSubagent(fs, "/proj", "draft", "---\nname: draft\n---\nbody\n");
	await seedSubagent(fs, "/proj", "ok", "---\nname: ok\ndescription: real\n---\nbody\n");
	const profiles = await loadProjectSubagents(fs, "/proj");
	expect(profiles.map((p) => p.name)).toEqual(["ok"]);
});

test("loadProjectSubagents drops profiles with empty body", async () => {
	const fs = createInMemoryFilesystem();
	await seedSubagent(fs, "/proj", "empty", "---\nname: empty\ndescription: desc\n---\n\n");
	const profiles = await loadProjectSubagents(fs, "/proj");
	expect(profiles).toEqual([]);
});

test("loadProjectSubagents rejects invalid names", async () => {
	const fs = createInMemoryFilesystem();
	await seedSubagent(fs, "/proj", "Bad_Name", "---\ndescription: x\n---\nbody\n");
	await seedSubagent(fs, "/proj", "-leading", "---\ndescription: x\n---\nbody\n");
	await seedSubagent(fs, "/proj", "good", "---\ndescription: x\n---\nbody\n");
	const profiles = await loadProjectSubagents(fs, "/proj");
	expect(profiles.map((p) => p.name)).toEqual(["good"]);
});

test("loadProjectSubagents sorts results by name", async () => {
	const fs = createInMemoryFilesystem();
	await seedSubagent(fs, "/proj", "zeta", "---\ndescription: z\n---\nbody\n");
	await seedSubagent(fs, "/proj", "alpha", "---\ndescription: a\n---\nbody\n");
	await seedSubagent(fs, "/proj", "mid", "---\ndescription: m\n---\nbody\n");
	const profiles = await loadProjectSubagents(fs, "/proj");
	expect(profiles.map((p) => p.name)).toEqual(["alpha", "mid", "zeta"]);
});

test("loadProjectSubagents respects max-turns frontmatter", async () => {
	const fs = createInMemoryFilesystem();
	await seedSubagent(fs, "/proj", "limited", "---\ndescription: desc\nmax-turns: 7\n---\nbody\n");
	const profiles = await loadProjectSubagents(fs, "/proj");
	expect(profiles[0]?.maxTurns).toBe(7);
});
