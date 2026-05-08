import type { SessionNotification } from "@agentclientprotocol/sdk";
import type { ChatState } from "../store/chatStore";

/**
 * Maps ACP `sessionUpdate` notifications onto chat-store actions. Ported
 * from `bodhi-pi-cli/src/repl/render.ts` — same parsing logic, different sink.
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

export interface RenderActions {
	appendChunk: ChatState["appendChunk"];
	addMessage: ChatState["addMessage"];
	addSystemMessage: ChatState["addSystemMessage"];
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

	if (kind === "tool_call") {
		const title = (update.title as string | undefined) ?? "tool call";
		actions.addSystemMessage(`⚒ ${title}`);
		return;
	}

	if (kind === "tool_call_update") {
		const status = update.status as string | undefined;
		const preview = extractContentText(update.content).slice(0, 400);
		if (status === "completed" && preview) {
			actions.addSystemMessage(`  → ${preview}`);
		} else if (status === "failed") {
			actions.addSystemMessage(`  ✗ ${preview || "failed"}`);
		}
		return;
	}
}
