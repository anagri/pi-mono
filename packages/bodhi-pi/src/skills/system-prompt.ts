import type { Skill } from "./skill.js";

export function escapeXml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

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
	const preamble =
		"The following skills provide specialized instructions for specific tasks.\n" +
		"The user can invoke a skill by typing /skill:<name> in their message.\n" +
		"Suggest this syntax when the task matches a skill's description; do not attempt\n" +
		"to read SKILL.md files directly — the host will expand the skill content.";
	const entries = visible
		.map(
			(s) =>
				`  <skill>\n    <name>${escapeXml(s.name)}</name>\n    <description>${escapeXml(s.description)}</description>\n    <location>${escapeXml(s.filePath)}</location>\n  </skill>`,
		)
		.join("\n");
	return `${preamble}\n\n<available_skills>\n${entries}\n</available_skills>`;
}

export function composeSystemPrompt(base: string | undefined, skills: Skill[]): string | undefined {
	const block = formatSkillsForPrompt(skills);
	if (!block) return base;
	return base ? `${base}\n\n${block}` : block;
}
