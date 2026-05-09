import type { ClientSideConnection, SessionNotification } from "@agentclientprotocol/sdk";
import { useCallback, useRef, useState } from "react";

export interface ChatMessage {
	role: "user" | "assistant";
	text: string;
}

export type ChatStatus = "idle" | "streaming";

interface UseChatArgs {
	conn: ClientSideConnection | null;
	cwd: string;
}

export function useChat({ conn, cwd }: UseChatArgs) {
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [status, setStatus] = useState<ChatStatus>("idle");
	const [error, setError] = useState<string>("");
	const sessionIdRef = useRef<string | null>(null);

	const handleNotification = useCallback((n: SessionNotification) => {
		const update = n.update as { sessionUpdate?: string; content?: { type?: string; text?: string } };
		if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text" && update.content.text) {
			const chunk = update.content.text;
			setMessages((prev) => {
				const last = prev[prev.length - 1];
				if (last?.role === "assistant") {
					return [...prev.slice(0, -1), { ...last, text: last.text + chunk }];
				}
				return [...prev, { role: "assistant", text: chunk }];
			});
		}
	}, []);

	const send = useCallback(
		async (text: string) => {
			if (!conn) {
				setError("not connected");
				return;
			}
			setError("");
			setStatus("streaming");
			setMessages((prev) => [...prev, { role: "user", text }]);
			try {
				if (!sessionIdRef.current) {
					const ns = await conn.newSession({ cwd, mcpServers: [] });
					sessionIdRef.current = ns.sessionId;
				}
				const result = await conn.prompt({
					sessionId: sessionIdRef.current,
					prompt: [{ type: "text", text }],
				});
				if (result.stopReason !== "end_turn" && result.stopReason !== "max_tokens") {
					setError(`prompt ended with stop_reason=${result.stopReason}`);
				}
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				setStatus("idle");
			}
		},
		[conn, cwd],
	);

	const reset = useCallback(() => {
		setMessages([]);
		setError("");
		setStatus("idle");
		sessionIdRef.current = null;
	}, []);

	return { messages, status, error, send, handleNotification, reset };
}
