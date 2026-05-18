import { expect, test } from "vitest";
import { createInMemoryFilesystem } from "@/index.js";
import { loadProjectSubagents } from "@/subagents/discovery.js";
import { seedSubagent } from "./helpers/filesystem.js";

test("loadProjectSubagents accepts context: fork in frontmatter", async () => {
	const fs = createInMemoryFilesystem();
	await seedSubagent(
		fs,
		"/proj",
		"reviewer",
		"---\ndescription: review the parent's diff\ncontext: fork\n---\nYou are a reviewer.\n",
	);
	const profiles = await loadProjectSubagents(fs, "/proj");
	expect(profiles).toHaveLength(1);
	expect(profiles[0]?.context).toBe("fork");
});

test("loadProjectSubagents defaults context to fresh when frontmatter omits it", async () => {
	const fs = createInMemoryFilesystem();
	await seedSubagent(fs, "/proj", "explorer", "---\ndescription: explore\n---\nYou explore.\n");
	const profiles = await loadProjectSubagents(fs, "/proj");
	expect(profiles).toHaveLength(1);
	expect(profiles[0]?.context).toBe("fresh");
});

test("loadProjectSubagents accepts context: fresh explicitly", async () => {
	const fs = createInMemoryFilesystem();
	await seedSubagent(fs, "/proj", "explorer", "---\ndescription: explore\ncontext: fresh\n---\nYou explore.\n");
	const profiles = await loadProjectSubagents(fs, "/proj");
	expect(profiles).toHaveLength(1);
	expect(profiles[0]?.context).toBe("fresh");
});

test("loadProjectSubagents drops profiles with an unknown context value", async () => {
	const fs = createInMemoryFilesystem();
	await seedSubagent(fs, "/proj", "weird", "---\ndescription: bad\ncontext: cosmic\n---\nYou are weird.\n");
	await seedSubagent(fs, "/proj", "good", "---\ndescription: ok\ncontext: fork\n---\nYou are good.\n");
	const profiles = await loadProjectSubagents(fs, "/proj");
	expect(profiles.map((p) => p.name)).toEqual(["good"]);
});
