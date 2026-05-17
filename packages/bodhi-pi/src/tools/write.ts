import type { AgentTool } from "@earendil-works/pi-agent-core";
import { dirname } from "pathe";
import { type Static, Type } from "typebox";
import { byteLengthUtf8 } from "@/_internal/utf8.js";
import { withFileMutationQueue } from "./file-mutation-queue.js";
import { resolvePath, type ToolDeps } from "./index.js";

const writeSchema = Type.Object({
	path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
	content: Type.String({ description: "Content to write to the file" }),
});

type WriteInput = Static<typeof writeSchema>;

export function createWriteTool(deps: ToolDeps): AgentTool<typeof writeSchema> {
	return {
		name: "write",
		label: "write",
		description:
			"Create or overwrite a UTF-8 text file. Automatically creates parent directories. Returns the byte count on success.",
		parameters: writeSchema,
		async execute(_toolCallId: string, { path: filePath, content }: WriteInput) {
			const absolutePath = resolvePath(deps.cwd, filePath);
			return withFileMutationQueue(absolutePath, async () => {
				const parent = dirname(absolutePath);
				await deps.filesystem.mkdir(parent, { recursive: true });
				await deps.filesystem.writeTextFile(absolutePath, content);
				const bytes = byteLengthUtf8(content);
				return {
					content: [{ type: "text", text: `Wrote ${bytes} bytes to ${filePath}` }],
					details: undefined,
				};
			});
		},
	};
}
