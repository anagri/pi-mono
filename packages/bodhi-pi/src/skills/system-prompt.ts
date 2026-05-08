import type { Skill } from "./skill.js";

/**
 * Build the `<available_skills>` block for the system prompt. Skills with
 * `disableModelInvocation: true` are excluded so the model never tries to
 * call them unsolicited; they remain user-invocable via `/skill:`.
 *
 * Returns "" when no skill is eligible. Caller decides how to compose with
 * the host's base systemPrompt.
 */
export function formatSkillsForPrompt(skills: Skill[]): string {
	const visible = skills.filter((s) => !s.disableModelInvocation);
	if (visible.length === 0) return "";
	const entries = visible
		.map(
			(s) =>
				`  <skill>\n    <name>${s.name}</name>\n    <description>${s.description}</description>\n    <location>${s.filePath}</location>\n  </skill>`,
		)
		.join("\n");
	return `<available_skills>\n${entries}\n</available_skills>`;
}

export function composeSystemPrompt(base: string | undefined, skills: Skill[]): string | undefined {
	const block = formatSkillsForPrompt(skills);
	if (!block) return base;
	return base ? `${base}\n\n${block}` : block;
}
