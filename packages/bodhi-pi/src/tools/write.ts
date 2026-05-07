import path from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "typebox";
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
			const parent = path.posix.dirname(absolutePath);
			await deps.filesystem.mkdir(parent, { recursive: true });
			await deps.filesystem.writeTextFile(absolutePath, content);
			const bytes = Buffer.byteLength(content, "utf-8");
			return {
				content: [{ type: "text", text: `Wrote ${bytes} bytes to ${filePath}` }],
				details: undefined,
			};
		},
	};
}
