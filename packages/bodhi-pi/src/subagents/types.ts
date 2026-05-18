export interface SubagentProfile {
	name: string;
	description: string;
	model?: string;
	context: "fresh";
	tools?: string[];
	maxTurns: number;
	body: string;
	filePath: string;
}

export interface SubagentFrontmatter {
	name?: string;
	description?: string;
	model?: string;
	context?: "fresh";
	tools?: string[];
	"max-turns"?: number;
}

export interface SubagentProfileSummary {
	name: string;
	description: string;
	model?: string;
	context: "fresh";
	tools?: string[];
	maxTurns: number;
}

export function profileToSummary(profile: SubagentProfile): SubagentProfileSummary {
	return {
		name: profile.name,
		description: profile.description,
		...(profile.model !== undefined ? { model: profile.model } : {}),
		context: profile.context,
		...(profile.tools !== undefined ? { tools: profile.tools } : {}),
		maxTurns: profile.maxTurns,
	};
}
