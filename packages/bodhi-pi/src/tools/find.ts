import type { AgentTool } from "@earendil-works/pi-agent-core";
import { relative } from "pathe";
import picomatch from "picomatch";
import { type Static, Type } from "typebox";
import { accumulateBounded, truncationFooter } from "./_accumulate.js";
import { resolvePath, type ToolDeps } from "./index.js";
import { FIND_MAX_CHARS, FIND_MAX_MATCHES, WALK_MAX_ENTRIES } from "./limits.js";
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
		description: `Find files matching a glob (default limit ${FIND_MAX_MATCHES}, output cap ${Math.floor(FIND_MAX_CHARS / 1000)}K chars). Pure JS — works against any host-injected Filesystem.`,
		parameters: findSchema,
		async execute(_toolCallId: string, { pattern, path: dirPath, limit }: FindInput) {
			const root = resolvePath(deps.cwd, dirPath);
			const cap = Math.min(limit ?? FIND_MAX_MATCHES, FIND_MAX_MATCHES);
			const matcher = picomatch(pattern, { dot: true });

			let totalScanned = 0;
			async function* matches(): AsyncGenerator<string> {
				for await (const entry of walk(deps.filesystem, root, { maxEntries: WALK_MAX_ENTRIES })) {
					if (!entry.isFile) continue;
					totalScanned++;
					const rel = relative(root, entry.absolutePath);
					if (!matcher(rel) && !matcher(entry.absolutePath)) continue;
					yield entry.absolutePath;
				}
			}
			const { lines, stopped } = await accumulateBounded(matches(), { maxItems: cap, maxChars: FIND_MAX_CHARS });

			let output = lines.join("\n");
			if (lines.length === 0) {
				output = `No files match ${pattern} under ${dirPath} (${totalScanned} scanned).`;
			} else if (stopped !== null) {
				output += `\n\n${truncationFooter({
					shown: lines.length,
					stopped,
					item: "matches",
					maxChars: FIND_MAX_CHARS,
					maxItems: cap,
				})}`;
			}
			return { content: [{ type: "text", text: output }], details: undefined };
		},
	};
}
