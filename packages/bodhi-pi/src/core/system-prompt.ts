import type { Skill } from "@/skills/skill.js";
import { formatSkillsForPrompt } from "@/skills/system-prompt.js";

export interface BuildSystemPromptOptions {
	/** Host-supplied prompt that replaces the default boilerplate. Tool descriptions are not injected. */
	customPrompt?: string;
	/** Tool names to include in the "Available tools" list. A name appears only when a snippet is provided. */
	selectedTools?: string[];
	/** Per-tool one-line descriptions, keyed by tool name. */
	toolSnippets?: Record<string, string>;
	/** Extra guideline bullets appended to the default prompt's guidelines. */
	promptGuidelines?: string[];
	/** Text appended after the base prompt (and after the custom prompt, if any). */
	appendSystemPrompt?: string;
	/** Session working directory; rendered as the trailing `Current working directory` line. */
	cwd: string;
	/** Already-loaded project context files (e.g., AGENTS.md / CLAUDE.md). */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Already-loaded skills. */
	skills?: Skill[];
}

export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
	const {
		customPrompt,
		selectedTools,
		toolSnippets,
		promptGuidelines,
		appendSystemPrompt,
		cwd,
		contextFiles: providedContextFiles,
		skills: providedSkills,
	} = options;

	const promptCwd = cwd.replace(/\\/g, "/");
	const now = new Date();
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	const date = `${year}-${month}-${day}`;

	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";
	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];

	if (customPrompt) {
		let prompt = customPrompt;
		if (appendSection) prompt += appendSection;
		if (contextFiles.length > 0) {
			prompt += "\n\n# Project Context\n\nProject-specific instructions and guidelines:\n\n";
			for (const { path: filePath, content } of contextFiles) {
				prompt += `## ${filePath}\n\n${content}\n\n`;
			}
		}
		const customHasRead = !selectedTools || selectedTools.includes("read");
		if (customHasRead && skills.length > 0) {
			const skillsBlock = formatSkillsForPrompt(skills);
			if (skillsBlock) prompt += `\n\n${skillsBlock}`;
		}
		prompt += `\nCurrent date: ${date}`;
		prompt += `\nCurrent working directory: ${promptCwd}`;
		return prompt;
	}

	const tools = selectedTools ?? [];
	const visibleTools = tools.filter((name) => !!toolSnippets?.[name]);
	const toolsList =
		visibleTools.length > 0 ? visibleTools.map((name) => `- ${name}: ${toolSnippets![name]}`).join("\n") : "(none)";

	const guidelinesList: string[] = [];
	const guidelinesSet = new Set<string>();
	const addGuideline = (g: string): void => {
		if (guidelinesSet.has(g)) return;
		guidelinesSet.add(g);
		guidelinesList.push(g);
	};

	for (const g of promptGuidelines ?? []) {
		const trimmed = g.trim();
		if (trimmed.length > 0) addGuideline(trimmed);
	}
	addGuideline("Be concise in your responses");
	addGuideline("Show file paths clearly when working with files");

	const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");

	let prompt = `You are an expert coding assistant operating inside bodhi-pi, a host-mediated coding agent. You help users by reading files, executing scripts, editing code, and writing new files.

Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
${guidelines}`;

	if (appendSection) prompt += appendSection;

	if (contextFiles.length > 0) {
		prompt += "\n\n# Project Context\n\nProject-specific instructions and guidelines:\n\n";
		for (const { path: filePath, content } of contextFiles) {
			prompt += `## ${filePath}\n\n${content}\n\n`;
		}
	}

	if (tools.includes("read") && skills.length > 0) {
		const skillsBlock = formatSkillsForPrompt(skills);
		if (skillsBlock) prompt += `\n\n${skillsBlock}`;
	}

	prompt += `\nCurrent date: ${date}`;
	prompt += `\nCurrent working directory: ${promptCwd}`;

	return prompt;
}
