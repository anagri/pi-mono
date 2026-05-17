import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import { byteLengthUtf8 } from "@/_internal/utf8.js";
import { resolvePath, type ToolDeps } from "./index.js";
import { READ_MAX_BYTES, READ_MAX_LINES } from "./limits.js";

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "1-indexed line number to start reading from" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

type ReadInput = Static<typeof readSchema>;

// Cuts at line boundaries only — never mid-multibyte, even when `maxBytes` lands
// in the middle of a UTF-8 sequence.
function takeBoundedLines(lines: string[], maxLines: number, maxBytes: number): { joined: string; count: number } {
	let bytes = 0;
	let count = 0;
	for (let i = 0; i < lines.length && i < maxLines; i++) {
		const line = lines[i];
		const lineBytes = byteLengthUtf8(line);
		const sepBytes = i === 0 ? 0 : 1;
		if (bytes + sepBytes + lineBytes > maxBytes) break;
		bytes += sepBytes + lineBytes;
		count++;
	}
	return { joined: lines.slice(0, count).join("\n"), count };
}

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
			const requestedEnd = limit !== undefined ? Math.min(startLine + limit, total) : total;
			const requestedLines = allLines.slice(startLine, requestedEnd);

			const { joined, count } = takeBoundedLines(requestedLines, READ_MAX_LINES, READ_MAX_BYTES);
			const truncated = count < requestedLines.length;
			const truncatedBy: "lines" | "bytes" | undefined = !truncated
				? undefined
				: count >= READ_MAX_LINES
					? "lines"
					: "bytes";

			let output = joined;
			if (truncated) {
				const lastShown = startLine + count;
				const reason =
					truncatedBy === "lines"
						? `${READ_MAX_LINES}-line limit`
						: `${Math.floor(READ_MAX_BYTES / 1024)}KB limit`;
				output += `\n\n[Truncated by ${reason}. Showing lines ${startLine + 1}-${lastShown} of ${total}. Use offset=${lastShown + 1} to continue.]`;
			} else if (limit !== undefined && requestedEnd < total) {
				const remaining = total - requestedEnd;
				output += `\n\n[${remaining} more lines in file. Use offset=${requestedEnd + 1} to continue.]`;
			}

			return {
				content: [{ type: "text", text: output }],
				details: undefined,
			};
		},
	};
}
