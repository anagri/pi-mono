import path from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "typebox";
import { resolvePath, type ToolDeps } from "./index.js";
import { LS_MAX_BYTES, LS_MAX_ENTRIES } from "./limits.js";

const lsSchema = Type.Object({
	path: Type.String({ description: "Directory path to list (relative or absolute)" }),
	limit: Type.Optional(Type.Number({ description: "Maximum entries to return" })),
});

type LsInput = Static<typeof lsSchema>;

export function createLsTool(deps: ToolDeps): AgentTool<typeof lsSchema> {
	return {
		name: "ls",
		label: "ls",
		description: `List entries in a directory. Default limit ${LS_MAX_ENTRIES}; output capped at ${Math.floor(LS_MAX_BYTES / 1024)}KB. Each line: "<name>\\t<type>\\t<size>".`,
		parameters: lsSchema,
		async execute(_toolCallId: string, { path: dirPath, limit }: LsInput) {
			const absoluteDir = resolvePath(deps.cwd, dirPath);
			const children = await deps.filesystem.list(absoluteDir);
			const cap = Math.min(limit ?? LS_MAX_ENTRIES, LS_MAX_ENTRIES);

			const lines: string[] = [];
			let bytes = 0;
			let truncatedByEntries = false;
			let truncatedByBytes = false;
			for (let i = 0; i < children.length; i++) {
				if (i >= cap) {
					truncatedByEntries = true;
					break;
				}
				const child = children[i];
				const childPath = path.posix.join(absoluteDir, child.name);
				let size = 0;
				try {
					const stat = await deps.filesystem.stat(childPath);
					size = stat.size;
				} catch {
					// stat may fail for permission/race; show 0.
				}
				const type = child.isDirectory ? "dir" : "file";
				const line = `${child.name}\t${type}\t${size}`;
				if (bytes + line.length + 1 > LS_MAX_BYTES) {
					truncatedByBytes = true;
					break;
				}
				lines.push(line);
				bytes += line.length + 1;
			}

			let output = lines.join("\n");
			if (truncatedByEntries) {
				output += `\n\n[Truncated: showing ${lines.length} of ${children.length} entries (${cap}-entry limit).]`;
			} else if (truncatedByBytes) {
				output += `\n\n[Truncated by ${Math.floor(LS_MAX_BYTES / 1024)}KB limit.]`;
			}
			return { content: [{ type: "text", text: output }], details: undefined };
		},
	};
}
