import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import { detectLineEnding, normalizeToLF, restoreLineEndings, stripBom } from "./_text-encoding.js";
import { withFileMutationQueue } from "./file-mutation-queue.js";
import { resolvePath, type ToolDeps } from "./index.js";

const replaceSchema = Type.Object(
	{
		oldText: Type.String({
			description:
				"Exact text to replace. Must appear in the file exactly once and not overlap with any other edit in the same call.",
		}),
		newText: Type.String({ description: "Replacement text." }),
	},
	{ additionalProperties: false },
);

const editSchema = Type.Object(
	{
		path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
		edits: Type.Array(replaceSchema, {
			description:
				"One or more targeted replacements. Each oldText is matched against the original file (not after earlier edits). Merge nearby changes into a single edit; do not emit overlapping edits.",
		}),
	},
	{ additionalProperties: false },
);

type EditInput = Static<typeof editSchema>;

export function createEditTool(deps: ToolDeps): AgentTool<typeof editSchema> {
	return {
		name: "edit",
		label: "edit",
		description:
			"Edit a file using exact text replacement. Each edits[].oldText must appear exactly once in the original file. Use multiple entries in one call when changing several disjoint regions.",
		parameters: editSchema,
		async execute(_toolCallId: string, { path: filePath, edits }: EditInput) {
			if (!Array.isArray(edits) || edits.length === 0) {
				throw new Error("edit: edits[] must contain at least one replacement");
			}
			const absolutePath = resolvePath(deps.cwd, filePath);
			return withFileMutationQueue(absolutePath, async () => {
				const raw = await deps.filesystem.readTextFile(absolutePath);
				const { bom, text: stripped } = stripBom(raw);
				const originalEnding = detectLineEnding(stripped);
				let working = normalizeToLF(stripped);

				for (let i = 0; i < edits.length; i++) {
					const { oldText, newText } = edits[i];
					const firstIdx = working.indexOf(oldText);
					if (firstIdx < 0) {
						throw new Error(`edit #${i + 1}: oldText not found in ${filePath}`);
					}
					const secondIdx = working.indexOf(oldText, firstIdx + 1);
					if (secondIdx >= 0) {
						throw new Error(
							`edit #${i + 1}: oldText is not unique in ${filePath} (found at offsets ${firstIdx} and ${secondIdx}). Make oldText more specific.`,
						);
					}
					working = working.slice(0, firstIdx) + newText + working.slice(firstIdx + oldText.length);
				}

				const final = bom + restoreLineEndings(working, originalEnding);
				await deps.filesystem.writeTextFile(absolutePath, final);
				return {
					content: [{ type: "text", text: `Applied ${edits.length} edit(s) to ${filePath}` }],
					details: undefined,
				};
			});
		},
	};
}
