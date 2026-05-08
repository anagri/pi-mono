import { describe, expect, test } from "vitest";
import { expandSkillCommand } from "./invocation.js";
import type { Skill } from "./skill.js";

const skills: Skill[] = [
	{
		name: "greet",
		description: "Greet someone",
		disableModelInvocation: false,
		baseDir: "/proj/.bodhi-pi/skills/greet",
		filePath: "/proj/.bodhi-pi/skills/greet/SKILL.md",
		body: "Say hello.",
	},
];

describe("expandSkillCommand", () => {
	test("text without /skill: prefix is unchanged", () => {
		expect(expandSkillCommand("hello", skills)).toBe("hello");
	});

	test("/skill:unknown is passed through verbatim", () => {
		expect(expandSkillCommand("/skill:unknown args", skills)).toBe("/skill:unknown args");
	});

	test("known skill no args wraps body in XML", () => {
		const out = expandSkillCommand("/skill:greet", skills);
		expect(out).toContain('<skill name="greet" location="/proj/.bodhi-pi/skills/greet/SKILL.md">');
		expect(out).toContain("References are relative to /proj/.bodhi-pi/skills/greet.");
		expect(out).toContain("Say hello.");
		expect(out).toContain("</skill>");
		expect(out.endsWith("</skill>")).toBe(true);
	});

	test("known skill with args appends args as separate paragraph", () => {
		const out = expandSkillCommand("/skill:greet world", skills);
		expect(out.endsWith("</skill>\n\nworld")).toBe(true);
	});

	test("multi-word args preserved", () => {
		const out = expandSkillCommand("/skill:greet hello world", skills);
		expect(out.endsWith("</skill>\n\nhello world")).toBe(true);
	});

	test("trailing whitespace in args is trimmed", () => {
		const out = expandSkillCommand("/skill:greet world   ", skills);
		expect(out.endsWith("</skill>\n\nworld")).toBe(true);
	});
});
