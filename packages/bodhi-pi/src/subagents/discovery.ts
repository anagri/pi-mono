import { join } from "pathe";
import { parseFrontmatter } from "@/_internal/frontmatter.js";
import { byName } from "@/_internal/sort.js";
import type { Filesystem } from "@/filesystem/filesystem.js";
import type { SubagentFrontmatter, SubagentProfile } from "./types.js";

export const AGENTS_SUBDIR = ".bodhi-pi/agents";

const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const DEFAULT_MAX_TURNS = 50;

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

function loadProfile(filePath: string, fileBase: string, raw: string): SubagentProfile | null {
	let frontmatter: SubagentFrontmatter;
	let body: string;
	try {
		({ frontmatter, body } = parseFrontmatter<SubagentFrontmatter>(raw));
	} catch {
		return null;
	}
	const description = frontmatter.description?.trim();
	if (!description) return null;
	if (description.length > MAX_DESCRIPTION_LENGTH) return null;
	const name = frontmatter.name?.trim() || fileBase;
	if (!validateName(name)) return null;
	const trimmedBody = body.trim();
	if (!trimmedBody) return null;
	const maxTurns =
		typeof frontmatter["max-turns"] === "number" && frontmatter["max-turns"] > 0
			? frontmatter["max-turns"]
			: DEFAULT_MAX_TURNS;
	return {
		name,
		description,
		...(frontmatter.model ? { model: frontmatter.model } : {}),
		context: "fresh",
		...(Array.isArray(frontmatter.tools) ? { tools: frontmatter.tools } : {}),
		maxTurns,
		body: trimmedBody,
		filePath,
	};
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
