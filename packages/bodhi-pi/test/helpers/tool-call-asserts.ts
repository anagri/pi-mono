import type { SessionNotification } from "@agentclientprotocol/sdk";

export interface ToolCallNotification {
	sessionUpdate: "tool_call";
	toolCallId: string;
	title: string;
	kind: string;
	status: string;
	rawInput: Record<string, unknown>;
}

export interface ToolCallUpdateNotification {
	sessionUpdate: "tool_call_update";
	toolCallId: string;
	status: string;
	content?: Array<{ type: string; content?: { type: string; text?: string } }>;
}

/** Filter `tool_call` (start) notifications out of the captured update stream. */
export function toolCallStarts(updates: SessionNotification[]): ToolCallNotification[] {
	return updates
		.map((u) => u.update as { sessionUpdate?: string })
		.filter((u): u is ToolCallNotification => u.sessionUpdate === "tool_call");
}

/** Filter `tool_call_update` (completion) notifications out of the captured update stream. */
export function toolCallUpdates(updates: SessionNotification[]): ToolCallUpdateNotification[] {
	return updates
		.map((u) => u.update as { sessionUpdate?: string })
		.filter((u): u is ToolCallUpdateNotification => u.sessionUpdate === "tool_call_update");
}

/** Concatenate every text block carried in a `tool_call_update.content` array. */
export function toolUpdateText(u: ToolCallUpdateNotification): string {
	const blocks = u.content ?? [];
	return blocks
		.map((b) => (b.type === "content" && b.content?.type === "text" ? (b.content.text ?? "") : ""))
		.join("");
}
