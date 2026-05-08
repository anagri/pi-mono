import { describe, expect, test } from "vitest";
import type { Skill } from "./skill.js";
import { composeSystemPrompt, formatSkillsForPrompt } from "./system-prompt.js";

function skill(overrides: Partial<Skill> = {}): Skill {
	return {
		name: "demo",
		description: "demo desc",
		disableModelInvocation: false,
		baseDir: "/proj/.bodhi-pi/skills/demo",
		filePath: "/proj/.bodhi-pi/skills/demo/SKILL.md",
		body: "body",
		...overrides,
	};
}

describe("formatSkillsForPrompt", () => {
	test("empty list returns empty string", () => {
		expect(formatSkillsForPrompt([])).toBe("");
	});

	test("only hidden skills returns empty string", () => {
		expect(formatSkillsForPrompt([skill({ disableModelInvocation: true })])).toBe("");
	});

	test("includes name, description, location for visible skills", () => {
		const out = formatSkillsForPrompt([skill({ name: "alpha", description: "a desc" })]);
		expect(out).toContain("<available_skills>");
		expect(out).toContain("<name>alpha</name>");
		expect(out).toContain("<description>a desc</description>");
		expect(out).toContain("<location>/proj/.bodhi-pi/skills/demo/SKILL.md</location>");
		expect(out).toContain("</available_skills>");
	});

	test("excludes hidden skills from the block", () => {
		const out = formatSkillsForPrompt([
			skill({ name: "visible" }),
			skill({ name: "hidden", disableModelInvocation: true }),
		]);
		expect(out).toContain("<name>visible</name>");
		expect(out).not.toContain("<name>hidden</name>");
	});
});

describe("composeSystemPrompt", () => {
	test("no skills + no base returns undefined", () => {
		expect(composeSystemPrompt(undefined, [])).toBeUndefined();
	});

	test("no skills + base returns base unchanged", () => {
		expect(composeSystemPrompt("be helpful", [])).toBe("be helpful");
	});

	test("only hidden skills + base returns base unchanged", () => {
		expect(composeSystemPrompt("be helpful", [skill({ disableModelInvocation: true })])).toBe("be helpful");
	});

	test("visible skills + no base returns the block alone", () => {
		const out = composeSystemPrompt(undefined, [skill({ name: "x" })]);
		expect(out).toContain("<available_skills>");
		expect(out?.startsWith("<available_skills>")).toBe(true);
	});

	test("visible skills + base appends with double newline", () => {
		const out = composeSystemPrompt("be helpful", [skill({ name: "x" })]);
		expect(out?.startsWith("be helpful\n\n<available_skills>")).toBe(true);
	});
});
