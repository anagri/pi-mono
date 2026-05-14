import type { ImageContent, TextContent, ToolResultMessage } from "@earendil-works/pi-ai";

interface ToolCallContentBlock {
	type: "content";
	content: { type: "text"; text: string };
}

export function toolResultContentForAcp(result: ToolResultMessage): ToolCallContentBlock[] {
	return agentToolContentForAcp(result.content);
}

export function agentToolContentForAcp(blocks: Array<TextContent | ImageContent>): ToolCallContentBlock[] {
	const text = blocks
		.filter((b): b is TextContent => b.type === "text")
		.map((b) => b.text)
		.join("");
	if (!text) return [];
	return [{ type: "content", content: { type: "text", text } }];
}

type AcpStopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";
type PiStopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

// `"error"` is excluded — the caller throws `RequestError` before reaching here.
// Exhaustive switch: a new pi-ai stop reason fails type-check at every call site.
export function mapStopReason(sr: Exclude<PiStopReason, "error"> | undefined): AcpStopReason {
	switch (sr) {
		case "aborted":
			return "cancelled";
		case "length":
			return "max_tokens";
		case "stop":
		case "toolUse":
			return "end_turn";
		case undefined:
			return "end_turn";
	}
}
