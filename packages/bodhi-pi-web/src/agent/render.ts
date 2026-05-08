import type { AvailableCommand, SessionNotification } from "@agentclientprotocol/sdk";
import type { ChatState, ToolCallStatus } from "../store/chatStore";

/**
 * Maps ACP `sessionUpdate` notifications onto chat-store actions. Tool calls
 * land in dedicated card rows so e2e can assert on `[data-testid="tool-call"]`
 * with `data-tool-name`/`data-tool-status`. Text chunks land as peer messages.
 */

interface ToolCallContent {
	type: string;
	content?: { type: string; text?: string };
}

function extractContentText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return (content as ToolCallContent[])
		.filter((b) => b.type === "content" && b.content?.type === "text")
		.map((b) => b.content?.text ?? "")
		.join("");
}

function deriveToolName(title: string | undefined, kind: string | undefined): string {
	if (title && title.length > 0) {
		const first = title.trim().split(/\s+/)[0];
		if (first) return first;
	}
	return kind ?? "tool";
}

function mapStatus(s: string | undefined): ToolCallStatus {
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
	const update = notif.update as Record<string, unknown>;
	const kind = update.sessionUpdate as string;

	if (kind === "agent_message_chunk") {
		const content = update.content as { type: string; text?: string } | undefined;
		if (content?.type === "text" && content.text) {
			actions.appendChunk("assistant", content.text);
		}
		return;
	}

	if (kind === "user_message_chunk") {
		// Emitted during loadSession history replay (bodhi-pi M2.1).
		const content = update.content as { type: string; text?: string } | undefined;
		if (content?.type === "text" && content.text) {
			actions.appendChunk("user", content.text);
		}
		return;
	}

	if (kind === "available_commands_update") {
		const commands = (update.availableCommands as AvailableCommand[] | undefined) ?? [];
		actions.setAvailableCommands?.(commands);
		return;
	}

	if (kind === "tool_call") {
		const toolCallId = update.toolCallId as string | undefined;
		if (!toolCallId) return;
		const title = (update.title as string | undefined) ?? "tool call";
		const toolKind = update.kind as string | undefined;
		const status = mapStatus(update.status as string | undefined);
		actions.addToolCall({
			toolCallId,
			name: deriveToolName(title, toolKind),
			title,
			...(toolKind !== undefined ? { kind: toolKind } : {}),
			status,
		});
		return;
	}

	if (kind === "tool_call_update") {
		const toolCallId = update.toolCallId as string | undefined;
		if (!toolCallId) return;
		const status = mapStatus(update.status as string | undefined);
		const preview = extractContentText(update.content).slice(0, 400);
		actions.updateToolCall(toolCallId, {
			status,
			...(preview ? { preview } : {}),
		});
		return;
	}
}
