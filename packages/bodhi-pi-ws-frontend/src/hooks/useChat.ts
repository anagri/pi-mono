import type { AvailableCommand, ClientSideConnection, SessionNotification } from "@agentclientprotocol/sdk";
import { useCallback, useEffect, useRef, useState } from "react";
import { handleCommand, isCommand } from "../ui/commands";

export interface MessageItem {
	kind: "message";
	role: "user" | "assistant";
	text: string;
}

export interface SystemItem {
	kind: "system";
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

export type ChatItem = MessageItem | SystemItem | ToolCallItem;

export type ChatStatus = "idle" | "streaming" | "closed";

interface UseChatArgs {
	conn: ClientSideConnection | null;
	cwd: string;
	onSessionIdChange?: (sessionId: string | null) => void;
}

function mapToolStatus(raw: string | undefined): ToolCallStatus {
	if (raw === "completed") return "completed";
	if (raw === "failed") return "failed";
	return "running";
}

function deriveToolName(title: string, kind?: string): string {
	// Title is shaped "<tool-name> <location-hint>" (see bodhi-pi/src/acp/agent.ts).
	// First word of the title is the tool name; `kind` is a higher-level category
	// (e.g., "edit", "fetch") that's less precise. Match bodhi-pi-web's deriveToolName.
	if (title && title.length > 0) {
		const first = title.trim().split(/\s+/)[0];
		if (first) return first.replace(/[^a-zA-Z0-9_-]/g, "");
	}
	return kind ?? "tool";
}

export function useChat({ conn, cwd, onSessionIdChange }: UseChatArgs) {
	const [items, setItems] = useState<ChatItem[]>([]);
	const [status, setStatus] = useState<ChatStatus>("idle");
	const [error, setError] = useState<string>("");
	const [currentModelId, setCurrentModelId] = useState<string>("");
	const [availableCommands, setAvailableCommands] = useState<AvailableCommand[]>([]);
	const [sessionId, setSessionIdState] = useState<string | null>(null);
	const sessionIdRef = useRef<string | null>(null);
	const defaultModelIdRef = useRef<string>("");
	const onSessionIdChangeRef = useRef(onSessionIdChange);
	useEffect(() => {
		onSessionIdChangeRef.current = onSessionIdChange;
	}, [onSessionIdChange]);

	const updateSessionId = useCallback((id: string | null) => {
		if (sessionIdRef.current === id) return;
		sessionIdRef.current = id;
		setSessionIdState(id);
		onSessionIdChangeRef.current?.(id);
	}, []);

	const addSystemMessage = useCallback((text: string) => {
		setItems((prev) => [...prev, { kind: "system", text }]);
	}, []);

	const setSessionId = useCallback(
		(id: string) => {
			updateSessionId(id);
		},
		[updateSessionId],
	);

	const setDefaultModelId = useCallback(
		(id: string) => {
			defaultModelIdRef.current = id;
			if (!currentModelId) setCurrentModelId(id);
		},
		[currentModelId],
	);

	const clear = useCallback(() => {
		setItems([]);
	}, []);

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
			return;
		}

		if (kind === "available_commands_update") {
			const commands = (update.availableCommands as AvailableCommand[] | undefined) ?? [];
			setAvailableCommands(commands);
		}
	}, []);

	const send = useCallback(
		async (text: string) => {
			if (!conn) {
				setError("not connected");
				return;
			}
			setError("");

			// Slash commands: handle locally if a built-in; otherwise forward as prompt.
			if (isCommand(text)) {
				const handled = await handleCommand(text, {
					conn,
					cwd,
					sessionId: sessionIdRef.current ?? "",
					currentModelId,
					defaultModelId: defaultModelIdRef.current,
					availableCommands,
					addSystemMessage,
					setCurrentModelId,
					setSessionId,
					setStatus,
					clear,
				});
				if (handled) return;
				// Project commands fall through to forward-as-prompt.
			}

			setStatus("streaming");
			setItems((prev) => [...prev, { kind: "message", role: "user", text }]);
			try {
				if (!sessionIdRef.current) {
					const ns = await conn.newSession({ cwd, mcpServers: [] });
					updateSessionId(ns.sessionId);
					const opt = ns.configOptions?.[0];
					const value =
						opt && typeof (opt as { currentValue?: unknown }).currentValue === "string"
							? (opt as { currentValue: string }).currentValue
							: undefined;
					if (value) {
						defaultModelIdRef.current = value;
						setCurrentModelId(value);
					}
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
		[conn, cwd, currentModelId, availableCommands, addSystemMessage, setSessionId, clear, updateSessionId],
	);

	const newSession = useCallback(() => {
		setItems([]);
		setError("");
		setStatus("idle");
		updateSessionId(null);
	}, [updateSessionId]);

	const loadSession = useCallback(
		async (sessionId: string) => {
			if (!conn) {
				setError("not connected");
				return;
			}
			setError("");
			setItems([]);
			updateSessionId(sessionId);
			try {
				type LoadCapable = {
					loadSession?: (params: { sessionId: string; cwd: string; mcpServers: never[] }) => Promise<unknown>;
				};
				const c = conn as unknown as LoadCapable;
				if (typeof c.loadSession !== "function") {
					setError("server does not support session/load");
					return;
				}
				await c.loadSession({ sessionId, cwd, mcpServers: [] });
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
				throw err;
			}
		},
		[conn, cwd, updateSessionId],
	);

	return {
		items,
		status,
		error,
		send,
		handleNotification,
		newSession,
		loadSession,
		reset: newSession,
		addSystemMessage,
		currentModelId,
		setDefaultModelId,
		availableCommands,
		sessionId,
		currentSessionId: () => sessionIdRef.current,
	};
}
