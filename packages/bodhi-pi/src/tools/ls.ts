import type { AgentTool } from "@earendil-works/pi-agent-core";
import { join } from "pathe";
import { type Static, Type } from "typebox";
import { accumulateBounded, truncationFooter } from "./_accumulate.js";
import { resolvePath, type ToolDeps } from "./index.js";
import { LS_MAX_CHARS, LS_MAX_ENTRIES } from "./limits.js";

const lsSchema = Type.Object({
	path: Type.String({ description: "Directory path to list (relative or absolute)" }),
	limit: Type.Optional(Type.Number({ description: "Maximum entries to return" })),
});

type LsInput = Static<typeof lsSchema>;

export function createLsTool(deps: ToolDeps): AgentTool<typeof lsSchema> {
	return {
		name: "ls",
		label: "ls",
		description: `List entries in a directory. Default limit ${LS_MAX_ENTRIES}; output capped at ${Math.floor(LS_MAX_CHARS / 1000)}K chars. Each line: "<name>\\t<type>\\t<size>".`,
		parameters: lsSchema,
		async execute(_toolCallId: string, { path: dirPath, limit }: LsInput) {
			const absoluteDir = resolvePath(deps.cwd, dirPath);
			const children = await deps.filesystem.list(absoluteDir);
			const cap = Math.min(limit ?? LS_MAX_ENTRIES, LS_MAX_ENTRIES);

			const fs = deps.filesystem;
			async function* entries(): AsyncGenerator<string> {
				for (const child of children) {
					const childPath = join(absoluteDir, child.name);
					let size = 0;
					try {
						const stat = await fs.stat(childPath);
						size = stat.size;
					} catch {
						// stat may fail (race / permission); show 0.
					}
					const type = child.isDirectory ? "dir" : "file";
					yield `${child.name}\t${type}\t${size}`;
				}
			}
			const { lines, stopped } = await accumulateBounded(entries(), { maxItems: cap, maxChars: LS_MAX_CHARS });

			let output = lines.join("\n");
			if (stopped !== null) {
				output += `\n\n${truncationFooter({
					shown: lines.length,
					total: children.length,
					stopped,
					item: "entries",
					maxChars: LS_MAX_CHARS,
					maxItems: cap,
				})}`;
			}
			return { content: [{ type: "text", text: output }], details: undefined };
		},
	};
}
