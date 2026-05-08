import { describe, expect, test } from "vitest";
import { createInMemoryFilesystem } from "../filesystem/in-memory-filesystem.js";
import { loadProjectSkills } from "./discovery.js";

const CWD = "/proj";
const SKILLS = "/proj/.bodhi-pi/skills";

async function seed(files: Record<string, string>) {
	const fs = createInMemoryFilesystem();
	for (const [path, content] of Object.entries(files)) {
		const dir = path.substring(0, path.lastIndexOf("/"));
		await fs.mkdir(dir, { recursive: true });
		await fs.writeTextFile(path, content);
	}
	return fs;
}

describe("loadProjectSkills", () => {
	test("missing skills dir returns empty list", async () => {
		const fs = createInMemoryFilesystem();
		expect(await loadProjectSkills(fs, CWD)).toEqual([]);
	});

	test("empty skills dir returns empty list", async () => {
		const fs = createInMemoryFilesystem();
		await fs.mkdir(SKILLS, { recursive: true });
		expect(await loadProjectSkills(fs, CWD)).toEqual([]);
	});

	test("single skill folder with full frontmatter", async () => {
		const fs = await seed({
			[`${SKILLS}/greet/SKILL.md`]: "---\ndescription: Greet someone\n---\nSay hello.\n",
		});
		const skills = await loadProjectSkills(fs, CWD);
		expect(skills).toHaveLength(1);
		expect(skills[0]).toEqual({
			name: "greet",
			description: "Greet someone",
			disableModelInvocation: false,
			baseDir: `${SKILLS}/greet`,
			filePath: `${SKILLS}/greet/SKILL.md`,
			body: "Say hello.\n",
		});
	});

	test("name field overrides folder name", async () => {
		const fs = await seed({
			[`${SKILLS}/folder-name/SKILL.md`]: "---\nname: real-name\ndescription: x\n---\nbody\n",
		});
		const skills = await loadProjectSkills(fs, CWD);
		expect(skills[0].name).toBe("real-name");
	});

	test("missing description skips the skill", async () => {
		const fs = await seed({
			[`${SKILLS}/no-desc/SKILL.md`]: "---\nname: no-desc\n---\nbody\n",
			[`${SKILLS}/has-desc/SKILL.md`]: "---\ndescription: ok\n---\nbody\n",
		});
		const skills = await loadProjectSkills(fs, CWD);
		expect(skills.map((s) => s.name)).toEqual(["has-desc"]);
	});

	test("malformed YAML skips the skill but loads siblings", async () => {
		const fs = await seed({
			[`${SKILLS}/bad/SKILL.md`]: "---\ndescription: [unclosed\n---\nbody\n",
			[`${SKILLS}/good/SKILL.md`]: "---\ndescription: ok\n---\nbody\n",
		});
		const skills = await loadProjectSkills(fs, CWD);
		expect(skills.map((s) => s.name)).toEqual(["good"]);
	});

	test("entries that are not directories are ignored", async () => {
		const fs = createInMemoryFilesystem();
		await fs.mkdir(SKILLS, { recursive: true });
		await fs.writeTextFile(`${SKILLS}/loose.md`, "---\ndescription: x\n---\nbody\n");
		await fs.mkdir(`${SKILLS}/real`, { recursive: true });
		await fs.writeTextFile(`${SKILLS}/real/SKILL.md`, "---\ndescription: y\n---\nbody\n");
		const skills = await loadProjectSkills(fs, CWD);
		expect(skills.map((s) => s.name)).toEqual(["real"]);
	});

	test("folder without SKILL.md is ignored", async () => {
		const fs = createInMemoryFilesystem();
		await fs.mkdir(`${SKILLS}/empty`, { recursive: true });
		await fs.mkdir(`${SKILLS}/has-it`, { recursive: true });
		await fs.writeTextFile(`${SKILLS}/has-it/SKILL.md`, "---\ndescription: x\n---\nbody\n");
		const skills = await loadProjectSkills(fs, CWD);
		expect(skills.map((s) => s.name)).toEqual(["has-it"]);
	});

	test("disable-model-invocation flag is parsed", async () => {
		const fs = await seed({
			[`${SKILLS}/hidden/SKILL.md`]: "---\ndescription: hidden\ndisable-model-invocation: true\n---\nbody\n",
		});
		const skills = await loadProjectSkills(fs, CWD);
		expect(skills[0].disableModelInvocation).toBe(true);
	});

	test("allowed-tools field is captured but not enforced", async () => {
		const fs = await seed({
			[`${SKILLS}/restricted/SKILL.md`]: "---\ndescription: x\nallowed-tools:\n  - read\n  - write\n---\nbody\n",
		});
		const skills = await loadProjectSkills(fs, CWD);
		expect(skills[0].allowedTools).toEqual(["read", "write"]);
	});

	test("results are sorted by name", async () => {
		const fs = await seed({
			[`${SKILLS}/zeta/SKILL.md`]: "---\ndescription: z\n---\nz\n",
			[`${SKILLS}/alpha/SKILL.md`]: "---\ndescription: a\n---\na\n",
			[`${SKILLS}/mike/SKILL.md`]: "---\ndescription: m\n---\nm\n",
		});
		const skills = await loadProjectSkills(fs, CWD);
		expect(skills.map((s) => s.name)).toEqual(["alpha", "mike", "zeta"]);
	});

	test("skill with invalid name charset is skipped but siblings load", async () => {
		const fs = await seed({
			[`${SKILLS}/bad-name/SKILL.md`]: "---\nname: bad Name!\ndescription: x\n---\nbody\n",
			[`${SKILLS}/good/SKILL.md`]: "---\ndescription: ok\n---\nbody\n",
		});
		const skills = await loadProjectSkills(fs, CWD);
		expect(skills.map((s) => s.name)).toEqual(["good"]);
	});

	test("skill with description exceeding 1024 chars is skipped", async () => {
		const longDesc = "x".repeat(1025);
		const fs = await seed({
			[`${SKILLS}/toolong/SKILL.md`]: `---\ndescription: ${longDesc}\n---\nbody\n`,
			[`${SKILLS}/fine/SKILL.md`]: "---\ndescription: ok\n---\nbody\n",
		});
		const skills = await loadProjectSkills(fs, CWD);
		expect(skills.map((s) => s.name)).toEqual(["fine"]);
	});
});
