import type { AgentTool } from "@earendil-works/pi-agent-core";
import { byName } from "@/_internal/sort.js";
import type { PromptTemplate } from "@/commands/prompt-templates.js";
import type { SubagentProfile } from "@/subagents/types.js";

export function mergeTools(builtins: AgentTool[], extensions: AgentTool[]): AgentTool[] {
	const builtinNames = new Set(builtins.map((t) => t.name));
	return [...builtins, ...extensions.filter((t) => !builtinNames.has(t.name))];
}

export function mergeCommands(project: PromptTemplate[], extensions: PromptTemplate[]): PromptTemplate[] {
	const projectNames = new Set(project.map((c) => c.name));
	return [...project, ...extensions.filter((c) => !projectNames.has(c.name))];
}

export function mergeSubagentProfiles(project: SubagentProfile[], builtin: SubagentProfile[]): SubagentProfile[] {
	const seen = new Set<string>();
	const merged: SubagentProfile[] = [];
	for (const p of project) {
		if (seen.has(p.name)) continue;
		seen.add(p.name);
		merged.push(p);
	}
	for (const p of builtin) {
		if (seen.has(p.name)) continue;
		seen.add(p.name);
		merged.push(p);
	}
	return merged.filter((p) => p.disabled !== true).sort(byName);
}
