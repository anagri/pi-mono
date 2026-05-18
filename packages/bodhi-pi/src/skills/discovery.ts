import { join } from "pathe";
import { discoveryDirWarn, discoveryWarn } from "@/_internal/discovery-warn.js";
import { parseFrontmatter } from "@/_internal/frontmatter.js";
import { byName } from "@/_internal/sort.js";
import type { BodhiPiLogger } from "@/acp/agent.js";
import type { Filesystem } from "@/filesystem/filesystem.js";
import type { Skill, SkillFrontmatter } from "./skill.js";

export const SKILLS_SUBDIR = ".bodhi-pi/skills";

const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;

export interface LoadProjectSkillsOptions {
	logger?: BodhiPiLogger;
}

type LoadSkillResult = { skill: Skill } | { reason: string };

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

function loadSkill(filePath: string, baseDir: string, folderName: string, raw: string): LoadSkillResult {
	let frontmatter: SkillFrontmatter;
	let body: string;
	try {
		({ frontmatter, body } = parseFrontmatter<SkillFrontmatter>(raw));
	} catch (err) {
		return { reason: `parse error: ${err instanceof Error ? err.message : String(err)}` };
	}
	const description = frontmatter.description?.trim();
	if (!description) return { reason: "missing description" };
	if (description.length > MAX_DESCRIPTION_LENGTH) {
		return { reason: `description exceeds ${MAX_DESCRIPTION_LENGTH} chars` };
	}
	const name = frontmatter.name?.trim() || folderName;
	if (!validateName(name)) return { reason: `invalid name "${name}"` };
	return {
		skill: {
			name,
			description,
			disableModelInvocation: frontmatter["disable-model-invocation"] === true,
			...(frontmatter["allowed-tools"] ? { allowedTools: frontmatter["allowed-tools"] } : {}),
			baseDir,
			filePath,
			body,
		},
	};
}

export async function loadProjectSkills(
	fs: Filesystem,
	cwd: string,
	options: LoadProjectSkillsOptions = {},
): Promise<Skill[]> {
	const { logger } = options;
	const dir = join(cwd, SKILLS_SUBDIR);
	if (!(await fs.exists(dir))) return [];

	let entries: Awaited<ReturnType<Filesystem["list"]>>;
	try {
		entries = await fs.list(dir);
	} catch (err) {
		discoveryDirWarn(logger, "skill", dir, err instanceof Error ? err.message : String(err));
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
		} catch (err) {
			discoveryWarn(logger, "skill", filePath, `read error: ${err instanceof Error ? err.message : String(err)}`);
			continue;
		}
		const result = loadSkill(filePath, baseDir, entry.name, raw);
		if ("reason" in result) {
			discoveryWarn(logger, "skill", filePath, result.reason);
			continue;
		}
		out.push(result.skill);
	}

	out.sort(byName);
	return out;
}
