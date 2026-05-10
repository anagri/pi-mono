import type {
	AvailableCommand,
	ContentBlock,
	SessionNotification,
	ToolCallContent,
	ToolCallStatus,
} from "@agentclientprotocol/sdk";
import type { ChatState, ToolCallStatus as ChatToolCallStatus } from "../store/chatStore";

/**
 * Maps ACP `sessionUpdate` notifications onto chat-store actions. Tool calls
 * land in dedicated card rows so e2e can assert on `[data-testid="tool-call"]`
 * with `data-tool-name`/`data-tool-status`. Text chunks land as peer messages.
 */

function extractContentText(content: Array<ToolCallContent> | null | undefined): string {
	if (!content) return "";
	return content
		.filter((b): b is Extract<ToolCallContent, { type: "content" }> => b.type === "content")
		.map((b) => (b.content.type === "text" ? b.content.text : ""))
		.join("");
}

function extractTextChunk(content: ContentBlock): string {
	return content.type === "text" ? content.text : "";
}

function deriveToolName(title: string, kind: string | undefined): string {
	if (title.length > 0) {
		const first = title.trim().split(/\s+/)[0];
		if (first) return first;
	}
	return kind ?? "tool";
}

function mapStatus(s: ToolCallStatus | undefined | null): ChatToolCallStatus {
	if (s === "completed") return "completed";
	if (s === "failed") return "failed";
	return "running";
}

export interface RenderActions {
	appendChunk: ChatState["appendChunk"];
	addMessage: ChatState["addMessage"];
	addSystemMessage: ChatState["addSystemMessage"];
	addToolCall: ChatState["addToolCall"];
	updateToolCall: ChatState["updateToolCall"];
	setAvailableCommands?: (commands: AvailableCommand[]) => void;
}

export function dispatchNotification(notif: SessionNotification, actions: RenderActions): void {
	const update = notif.update;

	switch (update.sessionUpdate) {
		case "agent_message_chunk": {
			const text = extractTextChunk(update.content);
			if (text) actions.appendChunk("assistant", text);
			return;
		}
		case "user_message_chunk": {
			// Emitted during loadSession history replay (bodhi-pi M2.1).
			const text = extractTextChunk(update.content);
			if (text) actions.appendChunk("user", text);
			return;
		}
		case "available_commands_update": {
			actions.setAvailableCommands?.(update.availableCommands);
			return;
		}
		case "tool_call": {
			actions.addToolCall({
				toolCallId: update.toolCallId,
				name: deriveToolName(update.title, update.kind),
				title: update.title,
				...(update.kind !== undefined ? { kind: update.kind } : {}),
				status: mapStatus(update.status),
			});
			return;
		}
		case "tool_call_update": {
			const preview = extractContentText(update.content).slice(0, 400);
			actions.updateToolCall(update.toolCallId, {
				status: mapStatus(update.status),
				...(preview ? { preview } : {}),
			});
			return;
		}
	}
}
