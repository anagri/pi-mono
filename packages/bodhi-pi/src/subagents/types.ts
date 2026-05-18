export type SubagentSource = "project" | "extension" | "builtin";

export type SubagentContextMode = "fresh" | "fork";

export interface SubagentProfile {
	name: string;
	description: string;
	model?: string;
	context: SubagentContextMode;
	tools?: string[];
	maxTurns: number;
	body: string;
	filePath: string;
	source: SubagentSource;
	disabled?: boolean;
}

export interface SubagentFrontmatter {
	name?: string;
	description?: string;
	model?: string;
	context?: SubagentContextMode;
	tools?: string[];
	"max-turns"?: number;
	disabled?: boolean;
}

export interface SubagentProfileSummary {
	name: string;
	description: string;
	model?: string;
	context: SubagentContextMode;
	tools?: string[];
	maxTurns: number;
	source: SubagentSource;
}

export function profileToSummary(profile: SubagentProfile): SubagentProfileSummary {
	return {
		name: profile.name,
		description: profile.description,
		...(profile.model !== undefined ? { model: profile.model } : {}),
		context: profile.context,
		...(profile.tools !== undefined ? { tools: profile.tools } : {}),
		maxTurns: profile.maxTurns,
		source: profile.source,
	};
}
