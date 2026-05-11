import path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Filesystem } from "@/filesystem/filesystem.js";
import type { ScriptExecutor } from "@/script-executor/script-executor.js";
import { createEditTool } from "./edit.js";
import { createFindTool } from "./find.js";
import { createGrepTool } from "./grep.js";
import { createLsTool } from "./ls.js";
import { createReadTool } from "./read.js";
import { createRunScriptTool } from "./run-script.js";
import { createWriteTool } from "./write.js";

export interface ToolDeps {
	filesystem: Filesystem;
	cwd: string;
	scriptExecutor?: ScriptExecutor;
}

export function createBuiltinTools(deps: ToolDeps): AgentTool[] {
	const tools: AgentTool[] = [
		createReadTool(deps),
		createWriteTool(deps),
		createEditTool(deps),
		createLsTool(deps),
		createFindTool(deps),
		createGrepTool(deps),
	];
	if (deps.scriptExecutor) {
		tools.push(createRunScriptTool(deps));
	}
	return tools;
}

/**
 * One-line tool descriptions for the built-in tools, keyed by registered name.
 * Used by `buildSystemPrompt` to render the "Available tools:" section.
 * Each entry mirrors what the model needs to know without dumping full schema.
 */
export const BUILTIN_TOOL_SNIPPETS: Record<string, string> = {
	read: "Read a UTF-8 text file; supports offset/limit for large files",
	write: "Overwrite or create a UTF-8 text file at the given path",
	edit: "Replace exact text in a file (oldText must occur exactly once unless replaceAll=true)",
	ls: "List entries in a directory (returns name/type/size per line)",
	find: "Find files matching a glob pattern under a directory",
	grep: "Search file contents for a regex (or literal string) under a directory",
	run_script: "Execute a JavaScript file at PATH with positional ARGS; returns stdout/stderr and exit code",
};

/**
 * Normalise a user-supplied path to an absolute path under `cwd`.
 * No `..` traversal guard — hosts that need sandboxing wrap their `Filesystem`.
 */
export function resolvePath(cwd: string, userPath: string): string {
	if (path.posix.isAbsolute(userPath)) return path.posix.normalize(userPath);
	return path.posix.normalize(path.posix.join(cwd, userPath));
}

export function toolKindFor(name: string): "read" | "edit" | "search" | "execute" | "other" {
	switch (name) {
		case "read":
			return "read";
		case "write":
		case "edit":
			return "edit";
		case "ls":
		case "find":
		case "grep":
			return "search";
		case "run_script":
			return "execute";
		default:
			return "other";
	}
}
