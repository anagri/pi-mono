import { join } from "pathe";
import { discoveryDirWarn, discoveryWarn } from "@/_internal/discovery-warn.js";
import { parseFrontmatter } from "@/_internal/frontmatter.js";
import { byName } from "@/_internal/sort.js";
import type { BodhiPiLogger } from "@/acp/agent.js";
import type { Filesystem } from "@/filesystem/filesystem.js";
import { validateAndNormalizeProfile } from "./_validate.js";
import type { SubagentFrontmatter, SubagentProfile } from "./types.js";

export const AGENTS_SUBDIR = ".bodhi-pi/agents";

export interface LoadProjectSubagentsOptions {
	logger?: BodhiPiLogger;
}

type LoadProfileResult = { profile: SubagentProfile } | { reason: string };

function loadProfile(filePath: string, fileBase: string, raw: string): LoadProfileResult {
	let frontmatter: SubagentFrontmatter;
	let body: string;
	try {
		({ frontmatter, body } = parseFrontmatter<SubagentFrontmatter>(raw));
	} catch (err) {
		return { reason: `parse error: ${err instanceof Error ? err.message : String(err)}` };
	}
	return validateAndNormalizeProfile({
		frontmatter,
		body,
		defaultName: fileBase,
		source: "project",
		filePath,
	});
}

export async function loadProjectSubagents(
	fs: Filesystem,
	cwd: string,
	options: LoadProjectSubagentsOptions = {},
): Promise<SubagentProfile[]> {
	const { logger } = options;
	const dir = join(cwd, AGENTS_SUBDIR);
	if (!(await fs.exists(dir))) return [];

	let entries: Awaited<ReturnType<Filesystem["list"]>>;
	try {
		entries = await fs.list(dir);
	} catch (err) {
		discoveryDirWarn(logger, "subagent", dir, err instanceof Error ? err.message : String(err));
		return [];
	}

	const out: SubagentProfile[] = [];
	const seen = new Set<string>();
	for (const entry of entries) {
		if (!entry.isFile || !entry.name.endsWith(".md")) continue;
		const filePath = join(dir, entry.name);
		let raw: string;
		try {
			raw = await fs.readTextFile(filePath);
		} catch (err) {
			discoveryWarn(logger, "subagent", filePath, `read error: ${err instanceof Error ? err.message : String(err)}`);
			continue;
		}
		const fileBase = entry.name.replace(/\.md$/, "");
		const result = loadProfile(filePath, fileBase, raw);
		if ("reason" in result) {
			discoveryWarn(logger, "subagent", filePath, result.reason);
			continue;
		}
		const profile = result.profile;
		if (seen.has(profile.name)) {
			discoveryWarn(logger, "subagent", filePath, `duplicate name "${profile.name}"`);
			continue;
		}
		seen.add(profile.name);
		out.push(profile);
	}

	out.sort(byName);
	return out;
}
