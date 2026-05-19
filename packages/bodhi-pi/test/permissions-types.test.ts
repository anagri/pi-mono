import { expect, test } from "vitest";
import {
	ALL_AGENT_MODES,
	ALL_TOOL_CATEGORIES,
	DEFAULT_AGENT_MODE,
	isAgentMode,
	MODE_DISPLAY,
	MODES_BY_PERMISSIVENESS,
} from "@/index.js";

test("AgentMode union enumerates ask | plan | edit | allow-all", () => {
	expect([...ALL_AGENT_MODES]).toEqual(["ask", "plan", "edit", "allow-all"]);
});

test("MODES_BY_PERMISSIVENESS orders ascending: plan < ask < edit < allow-all", () => {
	expect([...MODES_BY_PERMISSIVENESS]).toEqual(["plan", "ask", "edit", "allow-all"]);
});

test("DEFAULT_AGENT_MODE is 'ask' (principle of least privilege)", () => {
	expect(DEFAULT_AGENT_MODE).toBe("ask");
});

test("MODE_DISPLAY has a name + description for every mode", () => {
	for (const mode of ALL_AGENT_MODES) {
		expect(MODE_DISPLAY[mode].name.length).toBeGreaterThan(0);
		expect(MODE_DISPLAY[mode].description.length).toBeGreaterThan(0);
	}
});

test("ALL_TOOL_CATEGORIES enumerates 7 categories including mcp + subagent", () => {
	expect([...ALL_TOOL_CATEGORIES]).toEqual(["read", "edit", "search", "execute", "mcp", "subagent", "other"]);
});

test("isAgentMode is a type-guard that rejects unknown strings", () => {
	expect(isAgentMode("ask")).toBe(true);
	expect(isAgentMode("plan")).toBe(true);
	expect(isAgentMode("edit")).toBe(true);
	expect(isAgentMode("allow-all")).toBe(true);
	expect(isAgentMode("bogus")).toBe(false);
	expect(isAgentMode(null)).toBe(false);
	expect(isAgentMode(undefined)).toBe(false);
	expect(isAgentMode(42)).toBe(false);
});
