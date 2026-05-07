import type { SessionNotification } from "@agentclientprotocol/sdk";

/** Concatenate every `agent_message_chunk` notification's text. */
export function chunkedAgentText(updates: SessionNotification[]): string {
	return updates
		.filter((u) => u.update.sessionUpdate === "agent_message_chunk")
		.map((u) => {
			const content = (u.update as { content: { type: string; text?: string } }).content;
			return content.type === "text" ? (content.text ?? "") : "";
		})
		.join("");
}

/** Concatenate every `user_message_chunk` notification's text (used in load-replay tests). */
export function userChunkText(updates: SessionNotification[]): string {
	return updates
		.filter((u) => u.update.sessionUpdate === "user_message_chunk")
		.map((u) => {
			const content = (u.update as { content: { type: string; text?: string } }).content;
			return content.type === "text" ? (content.text ?? "") : "";
		})
		.join("");
}
