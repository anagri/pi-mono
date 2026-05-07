import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "typebox";
import { resolvePath, type ToolDeps } from "./index.js";
import { READ_MAX_BYTES, READ_MAX_LINES } from "./limits.js";

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "1-indexed line number to start reading from" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

type ReadInput = Static<typeof readSchema>;

export function createReadTool(deps: ToolDeps): AgentTool<typeof readSchema> {
	return {
		name: "read",
		label: "read",
		description: `Read a UTF-8 text file. Output is truncated to ${READ_MAX_LINES} lines or ${Math.floor(READ_MAX_BYTES / 1024)}KB (whichever first). Use offset/limit for large files.`,
		parameters: readSchema,
		async execute(_toolCallId: string, { path: filePath, offset, limit }: ReadInput) {
			const absolutePath = resolvePath(deps.cwd, filePath);
			const text = await deps.filesystem.readTextFile(absolutePath);
			const allLines = text.split("\n");
			const total = allLines.length;
			const startLine = offset ? Math.max(0, offset - 1) : 0;
			if (startLine >= total) {
				throw new Error(`Offset ${offset} is beyond end of file (${total} lines)`);
			}
			const endLine = limit !== undefined ? Math.min(startLine + limit, total) : total;
			let selected = allLines.slice(startLine, endLine).join("\n");

			let truncated = false;
			let truncatedBy: "lines" | "bytes" | undefined;
			let outputLines = endLine - startLine;
			if (outputLines > READ_MAX_LINES) {
				selected = allLines.slice(startLine, startLine + READ_MAX_LINES).join("\n");
				outputLines = READ_MAX_LINES;
				truncated = true;
				truncatedBy = "lines";
			}
			const bytes = Buffer.byteLength(selected, "utf-8");
			if (bytes > READ_MAX_BYTES) {
				const trimmed = Buffer.from(selected, "utf-8").subarray(0, READ_MAX_BYTES).toString("utf-8");
				selected = trimmed;
				outputLines = trimmed.split("\n").length;
				truncated = true;
				truncatedBy = "bytes";
			}

			let output = selected;
			if (truncated) {
				const lastShown = startLine + outputLines;
				const reason =
					truncatedBy === "lines"
						? `${READ_MAX_LINES}-line limit`
						: `${Math.floor(READ_MAX_BYTES / 1024)}KB limit`;
				output += `\n\n[Truncated by ${reason}. Showing lines ${startLine + 1}-${lastShown} of ${total}. Use offset=${lastShown + 1} to continue.]`;
			} else if (limit !== undefined && endLine < total) {
				const remaining = total - endLine;
				output += `\n\n[${remaining} more lines in file. Use offset=${endLine + 1} to continue.]`;
			}

			return {
				content: [{ type: "text", text: output }],
				details: undefined,
			};
		},
	};
}
