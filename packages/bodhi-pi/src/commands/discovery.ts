import { join } from "pathe";
import { discoveryDirWarn, discoveryWarn } from "@/_internal/discovery-warn.js";
import { parseFrontmatter } from "@/_internal/frontmatter.js";
import { byName } from "@/_internal/sort.js";
import type { BodhiPiLogger } from "@/acp/agent.js";
import type { Filesystem } from "@/filesystem/filesystem.js";
import type { PromptTemplate } from "./prompt-templates.js";

export const COMMANDS_SUBDIR = ".bodhi-pi/commands";

const DESCRIPTION_TRUNCATE = 60;

export interface LoadProjectCommandsOptions {
	logger?: BodhiPiLogger;
}

interface CommandFrontmatter {
	description?: string;
	"argument-hint"?: string;
}

type LoadTemplateResult = { template: PromptTemplate } | { reason: string };

function loadTemplate(filePath: string, raw: string): LoadTemplateResult {
	let frontmatter: CommandFrontmatter;
	let body: string;
	try {
		({ frontmatter, body } = parseFrontmatter<CommandFrontmatter>(raw));
	} catch (err) {
		return { reason: `parse error: ${err instanceof Error ? err.message : String(err)}` };
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
		template: {
			name,
			description,
			...(argumentHint ? { argumentHint } : {}),
			content: body,
			filePath,
		},
	};
}

export async function loadProjectCommands(
	fs: Filesystem,
	cwd: string,
	options: LoadProjectCommandsOptions = {},
): Promise<PromptTemplate[]> {
	const { logger } = options;
	const dir = join(cwd, COMMANDS_SUBDIR);
	if (!(await fs.exists(dir))) return [];

	let entries: Awaited<ReturnType<Filesystem["list"]>>;
	try {
		entries = await fs.list(dir);
	} catch (err) {
		discoveryDirWarn(logger, "command", dir, err instanceof Error ? err.message : String(err));
		return [];
	}

	const out: PromptTemplate[] = [];
	for (const entry of entries) {
		if (!entry.isFile || !entry.name.endsWith(".md")) continue;
		const filePath = join(dir, entry.name);
		let raw: string;
		try {
			raw = await fs.readTextFile(filePath);
		} catch (err) {
			discoveryWarn(logger, "command", filePath, `read error: ${err instanceof Error ? err.message : String(err)}`);
			continue;
		}
		const result = loadTemplate(filePath, raw);
		if ("reason" in result) {
			discoveryWarn(logger, "command", filePath, result.reason);
			continue;
		}
		out.push(result.template);
	}

	out.sort(byName);
	return out;
}
