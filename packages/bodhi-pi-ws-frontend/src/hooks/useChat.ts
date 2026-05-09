import type { ClientSideConnection, SessionNotification } from "@agentclientprotocol/sdk";
import { useCallback, useRef, useState } from "react";

export interface MessageItem {
	kind: "message";
	role: "user" | "assistant";
	text: string;
}

export type ToolCallStatus = "running" | "completed" | "failed";

export interface ToolCallItem {
	kind: "tool";
	toolCallId: string;
	name: string;
	title: string;
	status: ToolCallStatus;
}

export type ChatItem = MessageItem | ToolCallItem;

export type ChatStatus = "idle" | "streaming";

interface UseChatArgs {
	conn: ClientSideConnection | null;
}

function mapToolStatus(raw: string | undefined): ToolCallStatus {
	if (raw === "completed") return "completed";
	if (raw === "failed") return "failed";
	return "running";
}

function deriveToolName(title: string, kind?: string): string {
	if (kind && kind.length > 0) return kind;
	const first = title.split(/\s+/)[0] ?? "tool";
	return first.replace(/[^a-zA-Z0-9_-]/g, "");
}

export function useChat({ conn }: UseChatArgs) {
	const [items, setItems] = useState<ChatItem[]>([]);
	const [status, setStatus] = useState<ChatStatus>("idle");
	const [error, setError] = useState<string>("");
	const sessionIdRef = useRef<string | null>(null);

	const handleNotification = useCallback((n: SessionNotification) => {
		const update = n.update as Record<string, unknown>;
		const kind = update.sessionUpdate as string | undefined;

		if (kind === "agent_message_chunk" || kind === "user_message_chunk") {
			const content = update.content as { type?: string; text?: string } | undefined;
			if (content?.type !== "text" || !content.text) return;
			const role = kind === "user_message_chunk" ? "user" : "assistant";
			const chunk = content.text;
			setItems((prev) => {
				const last = prev[prev.length - 1];
				if (last?.kind === "message" && last.role === role) {
					return [...prev.slice(0, -1), { ...last, text: last.text + chunk }];
				}
				return [...prev, { kind: "message", role, text: chunk }];
			});
			return;
		}

		if (kind === "tool_call") {
			const toolCallId = update.toolCallId as string | undefined;
			if (!toolCallId) return;
			const title = (update.title as string | undefined) ?? "tool call";
			const toolKind = update.kind as string | undefined;
			const name = deriveToolName(title, toolKind);
			const status = mapToolStatus(update.status as string | undefined);
			setItems((prev) => {
				const existingIdx = prev.findIndex((it) => it.kind === "tool" && it.toolCallId === toolCallId);
				if (existingIdx >= 0) {
					const next = [...prev];
					next[existingIdx] = { kind: "tool", toolCallId, name, title, status };
					return next;
				}
				return [...prev, { kind: "tool", toolCallId, name, title, status }];
			});
			return;
		}

		if (kind === "tool_call_update") {
			const toolCallId = update.toolCallId as string | undefined;
			if (!toolCallId) return;
			const status = mapToolStatus(update.status as string | undefined);
			setItems((prev) =>
				prev.map((it) => (it.kind === "tool" && it.toolCallId === toolCallId ? { ...it, status } : it)),
			);
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
			setItems((prev) => [...prev, { kind: "message", role: "user", text }]);
			try {
				if (!sessionIdRef.current) {
					const ns = await conn.newSession({ cwd: "/", mcpServers: [] });
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
		[conn],
	);

	const newSession = useCallback(() => {
		setItems([]);
		setError("");
		setStatus("idle");
		sessionIdRef.current = null;
	}, []);

	const loadSession = useCallback(
		async (sessionId: string) => {
			if (!conn) {
				setError("not connected");
				return;
			}
			setError("");
			setItems([]);
			sessionIdRef.current = sessionId;
			try {
				type LoadCapable = {
					loadSession?: (params: { sessionId: string; cwd: string; mcpServers: never[] }) => Promise<unknown>;
				};
				const c = conn as unknown as LoadCapable;
				if (typeof c.loadSession !== "function") {
					setError("server does not support session/load");
					return;
				}
				await c.loadSession({ sessionId, cwd: "/", mcpServers: [] });
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			}
		},
		[conn],
	);

	const reset = newSession;

	return {
		items,
		status,
		error,
		send,
		handleNotification,
		newSession,
		loadSession,
		reset,
		currentSessionId: () => sessionIdRef.current,
	};
}
