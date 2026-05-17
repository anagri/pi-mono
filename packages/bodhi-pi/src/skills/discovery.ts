import { join } from "pathe";
import { parseFrontmatter } from "@/_internal/frontmatter.js";
import { byName } from "@/_internal/sort.js";
import type { Filesystem } from "@/filesystem/filesystem.js";
import type { Skill, SkillFrontmatter } from "./skill.js";

export const SKILLS_SUBDIR = ".bodhi-pi/skills";

const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;

function validateName(name: string): boolean {
	return (
		name.length > 0 &&
		name.length <= MAX_NAME_LENGTH &&
		/^[a-z0-9-]+$/.test(name) &&
		!name.startsWith("-") &&
		!name.endsWith("-") &&
		!name.includes("--")
	);
}

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
	if (description.length > MAX_DESCRIPTION_LENGTH) return null;
	const name = frontmatter.name?.trim() || folderName;
	if (!validateName(name)) return null;
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

	out.sort(byName);
	return out;
}
