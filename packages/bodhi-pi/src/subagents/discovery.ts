import { join } from "pathe";
import { parseFrontmatter } from "@/_internal/frontmatter.js";
import { byName } from "@/_internal/sort.js";
import type { Filesystem } from "@/filesystem/filesystem.js";
import { validateAndNormalizeProfile } from "./_validate.js";
import type { SubagentFrontmatter, SubagentProfile } from "./types.js";

export const AGENTS_SUBDIR = ".bodhi-pi/agents";

function loadProfile(filePath: string, fileBase: string, raw: string): SubagentProfile | null {
	let frontmatter: SubagentFrontmatter;
	let body: string;
	try {
		({ frontmatter, body } = parseFrontmatter<SubagentFrontmatter>(raw));
	} catch {
		return null;
	}
	return validateAndNormalizeProfile({
		frontmatter,
		body,
		defaultName: fileBase,
		source: "project",
		filePath,
	});
}

export async function loadProjectSubagents(fs: Filesystem, cwd: string): Promise<SubagentProfile[]> {
	const dir = join(cwd, AGENTS_SUBDIR);
	if (!(await fs.exists(dir))) return [];

	let entries: Awaited<ReturnType<Filesystem["list"]>>;
	try {
		entries = await fs.list(dir);
	} catch {
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
		} catch {
			continue;
		}
		const fileBase = entry.name.replace(/\.md$/, "");
		const profile = loadProfile(filePath, fileBase, raw);
		if (!profile) continue;
		if (seen.has(profile.name)) continue;
		seen.add(profile.name);
		out.push(profile);
	}

	out.sort(byName);
	return out;
}
