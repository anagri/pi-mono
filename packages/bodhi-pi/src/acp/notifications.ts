import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, ImageContent, TextContent, ToolResultMessage } from "@mariozechner/pi-ai";

/** Type guard: is this `AgentMessage` a pi-ai `ToolResultMessage`? */
export function isToolResultMessage(msg: AgentMessage): msg is ToolResultMessage {
	return (msg as { role?: unknown }).role === "toolResult";
}

/** Type guard: is this `AgentMessage` a pi-ai `AssistantMessage`? */
export function isAssistantMessage(msg: AgentMessage): msg is AssistantMessage {
	return (msg as { role?: unknown }).role === "assistant";
}

/** ACP `tool_call.content` block — wraps a content block under the "content" discriminator. */
export interface ToolCallContentBlock {
	type: "content";
	content: { type: "text"; text: string };
}

/** Pull plain-text payload from an `AgentMessage` for ACP replay chunks. */
export function extractText(message: AgentMessage): string {
	const role = (message as { role?: unknown }).role;
	if (role === "user") {
		const content = (message as { content?: string | Array<TextContent | ImageContent> }).content;
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";
		return content
			.filter((c): c is TextContent => c.type === "text")
			.map((c) => c.text)
			.join("");
	}
	if (role === "assistant") {
		const content = (message as AssistantMessage).content;
		if (!Array.isArray(content)) return "";
		return content
			.filter((c): c is TextContent => c.type === "text")
			.map((c) => c.text)
			.join("");
	}
	return "";
}

/** Tool-call block extracted from an assistant message's content. */
export interface ExtractedToolCall {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

/** Pull tool-call blocks from an assistant `AgentMessage`. */
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

/** Convert a pi-ai `ToolResultMessage.content` array into an ACP `ToolCallContent` array. */
export function toolResultContentForAcp(result: ToolResultMessage): ToolCallContentBlock[] {
	return agentToolContentForAcp(result.content);
}

/**
 * Flatten pi-ai's `(TextContent | ImageContent)[]` into the single text-content
 * block ACP `tool_call_update` notifications consume. Image blocks are dropped
 * (image input lands later as a separate milestone).
 */
export function agentToolContentForAcp(blocks: Array<TextContent | ImageContent>): ToolCallContentBlock[] {
	const text = blocks
		.filter((b): b is TextContent => b.type === "text")
		.map((b) => b.text)
		.join("");
	if (!text) return [];
	return [{ type: "content", content: { type: "text", text } }];
}

/** Heuristic: pull a "path" string out of validated tool args for the ACP `title` hint. */
export function formatLocationHint(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const path = (args as { path?: unknown }).path;
	return typeof path === "string" ? path : "";
}

/** ACP `stopReason` values (subset narrowed for our use). */
export type AcpStopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";

/** pi-ai `StopReason` values. */
type PiStopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

/**
 * Map pi-agent-core's `StopReason` to ACP's `stopReason` enum.
 *
 *   - `"aborted"` → `"cancelled"`
 *   - `"length"` → `"max_tokens"`
 *   - `"stop"` / `"toolUse"` → `"end_turn"`
 *   - `"error"` is handled separately by the caller (throws `RequestError`).
 *   - undefined falls back to `"end_turn"`.
 */
export function mapStopReason(sr: PiStopReason | undefined): AcpStopReason {
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
