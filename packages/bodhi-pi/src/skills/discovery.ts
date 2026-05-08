import { join } from "node:path";
import { parseFrontmatter } from "../_internal/frontmatter.js";
import type { Filesystem } from "../filesystem/filesystem.js";
import type { Skill, SkillFrontmatter } from "./skill.js";

export const SKILLS_SUBDIR = ".bodhi-pi/skills";

function loadSkill(filePath: string, baseDir: string, folderName: string, raw: string): Skill | null {
	let frontmatter: SkillFrontmatter;
	let body: string;
	try {
		({ frontmatter, body } = parseFrontmatter<SkillFrontmatter>(raw));
	} catch {
		return null;
	}
	const description = frontmatter.description?.trim();
	if (!description) return null;
	const name = frontmatter.name?.trim() || folderName;
	return {
		name,
		description,
		disableModelInvocation: frontmatter["disable-model-invocation"] === true,
		...(frontmatter["allowed-tools"] ? { allowedTools: frontmatter["allowed-tools"] } : {}),
		baseDir,
		filePath,
		body,
	};
}

export async function loadProjectSkills(fs: Filesystem, cwd: string): Promise<Skill[]> {
	const dir = join(cwd, SKILLS_SUBDIR);
	if (!(await fs.exists(dir))) return [];

	let entries: Awaited<ReturnType<Filesystem["list"]>>;
	try {
		entries = await fs.list(dir);
	} catch {
		return [];
	}

	const out: Skill[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory) continue;
		const baseDir = join(dir, entry.name);
		const filePath = join(baseDir, "SKILL.md");
		if (!(await fs.exists(filePath))) continue;
		let raw: string;
		try {
			raw = await fs.readTextFile(filePath);
		} catch {
			continue;
		}
		const skill = loadSkill(filePath, baseDir, entry.name, raw);
		if (skill) out.push(skill);
	}

	out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	return out;
}
