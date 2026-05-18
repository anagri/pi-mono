import type { SubagentContextMode, SubagentFrontmatter, SubagentProfile, SubagentSource } from "./types.js";

const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const DEFAULT_MAX_TURNS = 50;
const VALID_CONTEXT_MODES = new Set<SubagentContextMode>(["fresh", "fork"]);

export function validateSubagentName(name: string): boolean {
	return (
		name.length > 0 &&
		name.length <= MAX_NAME_LENGTH &&
		/^[a-z0-9-]+$/.test(name) &&
		!name.startsWith("-") &&
		!name.endsWith("-") &&
		!name.includes("--")
	);
}

export interface ValidateProfileInput {
	frontmatter: SubagentFrontmatter;
	body: string;
	defaultName?: string;
	source: SubagentSource;
	filePath: string;
}

export function validateAndNormalizeProfile(input: ValidateProfileInput): SubagentProfile | null {
	const { frontmatter, body, defaultName, source, filePath } = input;
	const description = frontmatter.description?.trim();
	if (!description) return null;
	if (description.length > MAX_DESCRIPTION_LENGTH) return null;
	const name = (frontmatter.name?.trim() || defaultName?.trim() || "").trim();
	if (!validateSubagentName(name)) return null;
	const trimmedBody = body.trim();
	if (!trimmedBody) return null;
	const maxTurns =
		typeof frontmatter["max-turns"] === "number" && frontmatter["max-turns"] > 0
			? frontmatter["max-turns"]
			: DEFAULT_MAX_TURNS;
	let context: SubagentContextMode;
	if (frontmatter.context === undefined) {
		context = "fresh";
	} else if (VALID_CONTEXT_MODES.has(frontmatter.context)) {
		context = frontmatter.context;
	} else {
		return null;
	}
	return {
		name,
		description,
		...(frontmatter.model ? { model: frontmatter.model } : {}),
		context,
		...(Array.isArray(frontmatter.tools) ? { tools: frontmatter.tools } : {}),
		maxTurns,
		body: trimmedBody,
		filePath,
		source,
		...(frontmatter.disabled === true ? { disabled: true } : {}),
	};
}
