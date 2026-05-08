import { join } from "node:path";
import { parseFrontmatter } from "../_internal/frontmatter.js";
import type { Filesystem } from "../filesystem/filesystem.js";
import type { PromptTemplate } from "./prompt-templates.js";

export const COMMANDS_SUBDIR = ".bodhi-pi/commands";

const DESCRIPTION_TRUNCATE = 60;

interface CommandFrontmatter {
	description?: string;
	"argument-hint"?: string;
}

function loadTemplate(filePath: string, raw: string): PromptTemplate | null {
	let frontmatter: CommandFrontmatter;
	let body: string;
	try {
		({ frontmatter, body } = parseFrontmatter<CommandFrontmatter>(raw));
	} catch {
		return null;
	}

	const fileName = filePath.split("/").pop() ?? filePath;
	const name = fileName.replace(/\.md$/, "");

	let description = frontmatter.description ?? "";
	if (!description) {
		const firstLine = body.split("\n").find((line) => line.trim());
		if (firstLine) {
			description = firstLine.slice(0, DESCRIPTION_TRUNCATE);
			if (firstLine.length > DESCRIPTION_TRUNCATE) description += "…";
		}
	}

	const argumentHint = frontmatter["argument-hint"];

	return {
		name,
		description,
		...(argumentHint ? { argumentHint } : {}),
		content: body,
		filePath,
	};
}

export async function loadProjectCommands(fs: Filesystem, cwd: string): Promise<PromptTemplate[]> {
	const dir = join(cwd, COMMANDS_SUBDIR);
	if (!(await fs.exists(dir))) return [];

	let entries: Awaited<ReturnType<Filesystem["list"]>>;
	try {
		entries = await fs.list(dir);
	} catch {
		return [];
	}

	const out: PromptTemplate[] = [];
	for (const entry of entries) {
		if (!entry.isFile || !entry.name.endsWith(".md")) continue;
		const filePath = join(dir, entry.name);
		let raw: string;
		try {
			raw = await fs.readTextFile(filePath);
		} catch {
			continue;
		}
		const template = loadTemplate(filePath, raw);
		if (template) out.push(template);
	}

	out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	return out;
}
