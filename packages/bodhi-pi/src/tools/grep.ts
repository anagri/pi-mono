import path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import picomatch from "picomatch";
import { type Static, Type } from "typebox";
import { accumulateBounded, truncationFooter } from "./_accumulate.js";
import { resolvePath, type ToolDeps } from "./index.js";
import { GREP_MAX_CHARS, GREP_MAX_LINE_LENGTH, GREP_MAX_MATCHES, WALK_MAX_ENTRIES } from "./limits.js";
import { walk } from "./walk.js";

const grepSchema = Type.Object({
	pattern: Type.String({ description: "Regex (or literal string when literal=true) to search for in file contents." }),
	path: Type.String({ description: "Directory to search (relative or absolute)" }),
	glob: Type.Optional(Type.String({ description: 'Optional file glob filter, e.g. "**/*.ts".' })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive match" })),
	literal: Type.Optional(Type.Boolean({ description: "Treat pattern as a literal string instead of regex" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of matching lines to return" })),
});

type GrepInput = Static<typeof grepSchema>;

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isLikelyBinary(content: string): boolean {
	const sample = content.length > 512 ? content.slice(0, 512) : content;
	for (let i = 0; i < sample.length; i++) {
		if (sample.charCodeAt(i) === 0) return true;
	}
	return false;
}

function truncateLine(line: string): string {
	if (line.length <= GREP_MAX_LINE_LENGTH) return line;
	return `${line.slice(0, GREP_MAX_LINE_LENGTH)}... [truncated]`;
}

export function createGrepTool(deps: ToolDeps): AgentTool<typeof grepSchema> {
	return {
		name: "grep",
		label: "grep",
		description: `Search file contents for a regex (or literal string). Default limit ${GREP_MAX_MATCHES} matches; line text truncated at ${GREP_MAX_LINE_LENGTH} chars; output cap ${Math.floor(GREP_MAX_CHARS / 1000)}K chars. Skips files containing NUL bytes.`,
		parameters: grepSchema,
		async execute(_toolCallId: string, { pattern, path: dirPath, glob, ignoreCase, literal, limit }: GrepInput) {
			const root = resolvePath(deps.cwd, dirPath);
			const cap = Math.min(limit ?? GREP_MAX_MATCHES, GREP_MAX_MATCHES);
			const flags = ignoreCase ? "i" : "";
			const re = new RegExp(literal ? escapeRegex(pattern) : pattern, flags);
			const globMatcher = glob ? picomatch(glob, { dot: true }) : undefined;

			async function* matches(): AsyncGenerator<string> {
				for await (const entry of walk(deps.filesystem, root, { maxEntries: WALK_MAX_ENTRIES })) {
					if (!entry.isFile) continue;
					const rel = path.posix.relative(root, entry.absolutePath);
					if (globMatcher && !globMatcher(rel) && !globMatcher(entry.absolutePath)) continue;
					let content: string;
					try {
						content = await deps.filesystem.readTextFile(entry.absolutePath);
					} catch {
						continue;
					}
					if (isLikelyBinary(content)) continue;
					const lines = content.split("\n");
					for (let i = 0; i < lines.length; i++) {
						if (!re.test(lines[i])) continue;
						yield `${entry.absolutePath}:${i + 1}:${truncateLine(lines[i])}`;
					}
				}
			}
			const { lines, stopped } = await accumulateBounded(matches(), { maxItems: cap, maxChars: GREP_MAX_CHARS });

			let output = lines.join("\n");
			if (lines.length === 0) {
				output = `No matches for ${pattern} under ${dirPath}${glob ? ` (glob: ${glob})` : ""}.`;
			} else if (stopped !== null) {
				output += `\n\n${truncationFooter({
					shown: lines.length,
					stopped,
					item: "matches",
					maxChars: GREP_MAX_CHARS,
					maxItems: cap,
				})}`;
			}
			return { content: [{ type: "text", text: output }], details: undefined };
		},
	};
}
