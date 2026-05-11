import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { PromptTemplate } from "@/commands/prompt-templates.js";

/** Merge extension tools into the builtin set. Builtins win on name collision. */
export function mergeTools(builtins: AgentTool[], extensions: AgentTool[]): AgentTool[] {
	const builtinNames = new Set(builtins.map((t) => t.name));
	return [...builtins, ...extensions.filter((t) => !builtinNames.has(t.name))];
}

/** Merge extension commands into the project commands. Project commands win on name collision. */
export function mergeCommands(project: PromptTemplate[], extensions: PromptTemplate[]): PromptTemplate[] {
	const projectNames = new Set(project.map((c) => c.name));
	return [...project, ...extensions.filter((c) => !projectNames.has(c.name))];
}
