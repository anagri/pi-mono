import path from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { Filesystem } from "../filesystem/filesystem.js";
import { createEditTool } from "./edit.js";
import { createFindTool } from "./find.js";
import { createGrepTool } from "./grep.js";
import { createLsTool } from "./ls.js";
import { createReadTool } from "./read.js";
import { createWriteTool } from "./write.js";

export interface ToolDeps {
	filesystem: Filesystem;
	cwd: string;
}

/** Returns the array passed into pi-agent-core's `Agent.state.tools`. */
export function createBuiltinTools(deps: ToolDeps): AgentTool[] {
	return [
		createReadTool(deps),
		createWriteTool(deps),
		createEditTool(deps),
		createLsTool(deps),
		createFindTool(deps),
		createGrepTool(deps),
	];
}

/**
 * Normalise a user-supplied path to an absolute path under `cwd`.
 *
 * Mirrors coding-agent's `path-utils.ts:54-60` — no `..` traversal guard.
 * Hosts that need sandboxing wrap their `Filesystem` impl.
 */
export function resolvePath(cwd: string, userPath: string): string {
	if (path.isAbsolute(userPath)) return path.posix.normalize(userPath);
	return path.posix.normalize(path.posix.join(cwd, userPath));
}

/** Map a built-in tool name to ACP `ToolKind` for `tool_call` notifications. */
export function toolKindFor(name: string): "read" | "edit" | "search" | "other" {
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
		default:
			return "other";
	}
}
