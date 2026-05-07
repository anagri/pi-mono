import path from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import picomatch from "picomatch";
import { type Static, Type } from "typebox";
import { resolvePath, type ToolDeps } from "./index.js";
import { FIND_MAX_BYTES, FIND_MAX_RESULTS } from "./limits.js";
import { walk } from "./walk.js";

const findSchema = Type.Object({
	pattern: Type.String({
		description: 'Glob pattern (e.g., "**/*.ts" or "src/**/index.ts"). Matched against the absolute path.',
	}),
	path: Type.String({ description: "Directory to search (relative or absolute)" }),
	limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return" })),
});

type FindInput = Static<typeof findSchema>;

export function createFindTool(deps: ToolDeps): AgentTool<typeof findSchema> {
	return {
		name: "find",
		label: "find",
		description: `Find files matching a glob (default limit ${FIND_MAX_RESULTS}, output cap ${Math.floor(FIND_MAX_BYTES / 1024)}KB). Pure JS — works against any host-injected Filesystem.`,
		parameters: findSchema,
		async execute(_toolCallId: string, { pattern, path: dirPath, limit }: FindInput) {
			const root = resolvePath(deps.cwd, dirPath);
			const cap = Math.min(limit ?? FIND_MAX_RESULTS, FIND_MAX_RESULTS);
			const matcher = picomatch(pattern, { dot: true });

			const matches: string[] = [];
			let bytes = 0;
			let truncatedByBytes = false;
			let truncatedByLimit = false;
			let totalScanned = 0;

			for await (const entry of walk(deps.filesystem, root, { maxEntries: 50_000 })) {
				if (!entry.isFile) continue;
				totalScanned++;
				const rel = path.posix.relative(root, entry.absolutePath);
				if (!matcher(rel) && !matcher(entry.absolutePath)) continue;
				if (matches.length >= cap) {
					truncatedByLimit = true;
					break;
				}
				const line = entry.absolutePath;
				if (bytes + line.length + 1 > FIND_MAX_BYTES) {
					truncatedByBytes = true;
					break;
				}
				matches.push(line);
				bytes += line.length + 1;
			}

			let output = matches.join("\n");
			if (matches.length === 0) {
				output = `No files match ${pattern} under ${dirPath} (${totalScanned} scanned).`;
			} else if (truncatedByLimit) {
				output += `\n\n[Truncated at ${cap}-result limit. Refine the pattern for fewer matches.]`;
			} else if (truncatedByBytes) {
				output += `\n\n[Truncated by ${Math.floor(FIND_MAX_BYTES / 1024)}KB output limit.]`;
			}
			return { content: [{ type: "text", text: output }], details: undefined };
		},
	};
}
