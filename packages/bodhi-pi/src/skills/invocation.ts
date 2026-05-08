import type { Skill } from "./skill.js";

const PREFIX = "/skill:";

/**
 * Expand `/skill:<name> args` into a `<skill>` XML block injected into the
 * user message. Args are appended as a separate paragraph (NOT $1-substituted
 * — that's the slash-command grammar). Unknown name passes through verbatim.
 */
export function expandSkillCommand(text: string, skills: Skill[]): string {
	if (!text.startsWith(PREFIX)) return text;

	const after = text.slice(PREFIX.length);
	const spaceIdx = after.indexOf(" ");
	const name = spaceIdx === -1 ? after : after.slice(0, spaceIdx);
	const args = spaceIdx === -1 ? "" : after.slice(spaceIdx + 1).trim();

	const skill = skills.find((s) => s.name === name);
	if (!skill) return text;

	const block = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${skill.body}\n</skill>`;
	return args ? `${block}\n\n${args}` : block;
}
