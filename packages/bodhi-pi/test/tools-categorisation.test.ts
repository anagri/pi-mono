import { expect, test } from "vitest";
import { toolKindFor } from "@/tools/index.js";

test("read-family tools categorise as 'read'", () => {
	expect(toolKindFor("read")).toBe("read");
});

test("write/edit categorise as 'edit'", () => {
	expect(toolKindFor("write")).toBe("edit");
	expect(toolKindFor("edit")).toBe("edit");
});

test("ls/find/grep categorise as 'search'", () => {
	expect(toolKindFor("ls")).toBe("search");
	expect(toolKindFor("find")).toBe("search");
	expect(toolKindFor("grep")).toBe("search");
});

test("run_script + bash categorise as 'execute'", () => {
	expect(toolKindFor("run_script")).toBe("execute");
	expect(toolKindFor("bash")).toBe("execute");
});

test("subagent categorises as its own category", () => {
	expect(toolKindFor("subagent")).toBe("subagent");
});

test("MCP-namespaced tool names categorise as 'mcp'", () => {
	expect(toolKindFor("filesystem__list_dir")).toBe("mcp");
	expect(toolKindFor("github__create_issue")).toBe("mcp");
});

test("unknown plain tool names fall through to 'other'", () => {
	expect(toolKindFor("totally-unknown-tool")).toBe("other");
});
