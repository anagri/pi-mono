import type { SubagentProfile } from "./types.js";

export interface ComposeSubagentSystemPromptOptions {
	profile: SubagentProfile;
	selectedTools: string[];
	toolSnippets: Record<string, string>;
	cwd: string;
}

export function composeSubagentSystemPrompt(opts: ComposeSubagentSystemPromptOptions): string {
	const promptCwd = opts.cwd.replace(/\\/g, "/");
	const now = new Date();
	const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
	const visible = opts.selectedTools.filter((n) => !!opts.toolSnippets[n]);
	const toolsList = visible.length > 0 ? visible.map((n) => `- ${n}: ${opts.toolSnippets[n]}`).join("\n") : "(none)";

	return [
		opts.profile.body.trimEnd(),
		"",
		"Available tools:",
		toolsList,
		"",
		`Current date: ${date}`,
		`Current working directory: ${promptCwd}`,
	].join("\n");
}
