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
	cwd: string;
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

export function useChat({ conn, cwd }: UseChatArgs) {
	const [items, setItems] = useState<ChatItem[]>([]);
	const [status, setStatus] = useState<ChatStatus>("idle");
	const [error, setError] = useState<string>("");
	const sessionIdRef = useRef<string | null>(null);

	const handleNotification = useCallback((n: SessionNotification) => {
		const update = n.update as Record<string, unknown>;
		const kind = update.sessionUpdate as string | undefined;

		if (kind === "agent_message_chunk") {
			const content = update.content as { type?: string; text?: string } | undefined;
			if (content?.type !== "text" || !content.text) return;
			const chunk = content.text;
			setItems((prev) => {
				const last = prev[prev.length - 1];
				if (last?.kind === "message" && last.role === "assistant") {
					return [...prev.slice(0, -1), { ...last, text: last.text + chunk }];
				}
				return [...prev, { kind: "message", role: "assistant", text: chunk }];
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
		setItems([]);
		setError("");
		setStatus("idle");
		sessionIdRef.current = null;
	}, []);

	return { items, status, error, send, handleNotification, reset };
}
