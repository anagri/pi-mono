import { describe, expect, test } from "vitest";
import { resolvePath, toolKindFor } from "./index.js";

describe("resolvePath", () => {
	test("relative path is resolved under cwd", () => {
		expect(resolvePath("/cwd", "rel/file.txt")).toBe("/cwd/rel/file.txt");
	});

	test("absolute path ignores cwd", () => {
		expect(resolvePath("/cwd", "/abs/file.txt")).toBe("/abs/file.txt");
	});

	test("relative .. normalises (no traversal guard, by design)", () => {
		expect(resolvePath("/cwd", "../escape")).toBe("/escape");
	});

	test("absolute .. normalises", () => {
		expect(resolvePath("/cwd", "/sub/../other.txt")).toBe("/other.txt");
	});

	test("root edge case", () => {
		expect(resolvePath("/", "")).toBe("/");
	});

	test("relative dot is resolved to cwd itself", () => {
		expect(resolvePath("/cwd", ".")).toBe("/cwd");
	});
});

describe("toolKindFor", () => {
	test("read tool maps to ACP 'read'", () => {
		expect(toolKindFor("read")).toBe("read");
	});

	test("write and edit tools map to ACP 'edit'", () => {
		expect(toolKindFor("write")).toBe("edit");
		expect(toolKindFor("edit")).toBe("edit");
	});

	test("ls / find / grep tools map to ACP 'search'", () => {
		expect(toolKindFor("ls")).toBe("search");
		expect(toolKindFor("find")).toBe("search");
		expect(toolKindFor("grep")).toBe("search");
	});

	test("unknown tool name maps to ACP 'other'", () => {
		expect(toolKindFor("unknown")).toBe("other");
		expect(toolKindFor("")).toBe("other");
	});
});
