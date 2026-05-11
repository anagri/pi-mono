import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent, ToolResultMessage } from "@earendil-works/pi-ai";

export function isToolResultMessage(msg: AgentMessage): msg is ToolResultMessage {
	return msg.role === "toolResult";
}

export function isAssistantMessage(msg: AgentMessage): msg is Extract<AgentMessage, { role: "assistant" }> {
	return msg.role === "assistant";
}

export interface ToolCallContentBlock {
	type: "content";
	content: { type: "text"; text: string };
}

export function extractText(message: AgentMessage): string {
	if (message.role === "user") {
		const content = message.content;
		if (typeof content === "string") return content;
		return content
			.filter((c): c is TextContent => c.type === "text")
			.map((c) => c.text)
			.join("");
	}
	if (message.role === "assistant") {
		return message.content
			.filter((c): c is TextContent => c.type === "text")
			.map((c) => c.text)
			.join("");
	}
	return "";
}

export interface ExtractedToolCall {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

export function extractToolCalls(message: AgentMessage): ExtractedToolCall[] {
	if (!isAssistantMessage(message)) return [];
	const out: ExtractedToolCall[] = [];
	for (const block of message.content) {
		if (block.type !== "toolCall") continue;
		out.push({
			id: block.id,
			name: block.name,
			arguments: (block.arguments ?? {}) as Record<string, unknown>,
		});
	}
	return out;
}

export function toolResultContentForAcp(result: ToolResultMessage): ToolCallContentBlock[] {
	return agentToolContentForAcp(result.content);
}

// Image blocks are dropped (image input is deferred).
export function agentToolContentForAcp(blocks: Array<TextContent | ImageContent>): ToolCallContentBlock[] {
	const text = blocks
		.filter((b): b is TextContent => b.type === "text")
		.map((b) => b.text)
		.join("");
	if (!text) return [];
	return [{ type: "content", content: { type: "text", text } }];
}

export function formatLocationHint(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const path = (args as { path?: unknown }).path;
	return typeof path === "string" ? path : "";
}

export type AcpStopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";

type PiStopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

// `"error"` is excluded from the param: the caller throws `RequestError`
// before reaching here, so it can't silently regress to `end_turn`.
export function mapStopReason(sr: Exclude<PiStopReason, "error"> | undefined): AcpStopReason {
	switch (sr) {
		case "aborted":
			return "cancelled";
		case "length":
			return "max_tokens";
		case "stop":
		case "toolUse":
			return "end_turn";
		default:
			return "end_turn";
	}
}
