import { useCallback, useEffect, useRef, useState } from "react";
import type { AcpHttpClient } from "../lib/acp-http-client.ts";

export type ChatStatus = "idle" | "streaming" | "error";

export interface ChatMessage {
	id: string;
	role: "user" | "assistant";
	text: string;
}

export interface ToolCard {
	id: string;
	name: string;
	status: "running" | "completed" | "failed";
	preview?: string;
}

export interface AvailableCommand {
	name: string;
	description: string;
	input?: { hint?: string };
}

export type ChatItem =
	| { type: "message"; message: ChatMessage }
	| { type: "tool"; tool: ToolCard }
	| { type: "system"; system: { id: string; text: string } };

export interface UseChatResult {
	items: ChatItem[];
	status: ChatStatus;
	error?: string;
	availableCommands: AvailableCommand[];
	send: (text: string) => Promise<void>;
	cancel: () => void;
	loadSession: (sessionId: string) => Promise<{ configOptions?: { id: string; currentValue: string }[] } | undefined>;
	clear: () => void;
	addSystemMessage: (text: string) => void;
}

/**
 * Drives a single ACP session: streams session/update notifications into
 * `items`, exposes send/cancel/loadSession. The session id is passed in;
 * caller manages session lifecycle (new/list/delete).
 */
export function useChat(client: AcpHttpClient, sessionId?: string): UseChatResult {
	const [items, setItems] = useState<ChatItem[]>([]);
	const [status, setStatus] = useState<ChatStatus>("idle");
	const [error, setError] = useState<string | undefined>();
	const [availableCommands, setAvailableCommands] = useState<AvailableCommand[]>([]);
	const abortRef = useRef<AbortController | undefined>(undefined);

	useEffect(() => {
		const unsub = client.onSessionUpdate((n) => {
			const update = n.update as {
				sessionUpdate: string;
				content?: { type?: string; text?: string };
				toolCallId?: string;
				title?: string;
				status?: string;
				availableCommands?: AvailableCommand[];
			};
			if (update.sessionUpdate === "available_commands_update" && Array.isArray(update.availableCommands)) {
				setAvailableCommands(update.availableCommands);
				return;
			}
			setItems((prev) => applyUpdate(prev, update));
		});
		return unsub;
	}, [client]);

	const send = useCallback(
		async (text: string) => {
			if (!sessionId) {
				setError("no active session");
				return;
			}
			setError(undefined);
			setStatus("streaming");
			setItems((prev) => [...prev, { type: "message", message: { id: `local-${Date.now()}`, role: "user", text } }]);
			const ctrl = new AbortController();
			abortRef.current = ctrl;
			try {
				await client.prompt({ sessionId, prompt: [{ type: "text", text }] }, { signal: ctrl.signal });
				setStatus("idle");
			} catch (err) {
				if (ctrl.signal.aborted) {
					setStatus("idle");
				} else {
					setError(err instanceof Error ? err.message : String(err));
					setStatus("error");
				}
			} finally {
				abortRef.current = undefined;
			}
		},
		[client, sessionId],
	);

	const cancel = useCallback(() => {
		if (!sessionId) return;
		void client.cancel(sessionId).catch(() => {});
		abortRef.current?.abort();
	}, [client, sessionId]);

	const loadSession = useCallback(
		async (sid: string) => {
			setError(undefined);
			setItems([]);
			try {
				return await client.loadSession({ sessionId: sid });
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
				return undefined;
			}
		},
		[client],
	);

	const clear = useCallback(() => {
		setItems([]);
		setError(undefined);
		setStatus("idle");
	}, []);

	const addSystemMessage = useCallback((text: string) => {
		setItems((prev) => [...prev, { type: "system", system: { id: `sys-${Date.now()}-${Math.random()}`, text } }]);
	}, []);

	return { items, status, error, availableCommands, send, cancel, loadSession, clear, addSystemMessage };
}

/**
 * Tool name in ACP arrives as the first word of `title` (per
 * bodhi-pi/src/acp/agent.ts which formats title as "<name> <loc-hint>").
 * `kind` is a higher-level category and a less precise fallback.
 */
function deriveToolName(title: string | undefined, kind?: string): string {
	if (title && title.length > 0) {
		const first = title.trim().split(/\s+/)[0];
		if (first) return first.replace(/[^a-zA-Z0-9_-]/g, "");
	}
	return kind ?? "tool";
}

/**
 * Extract a preview string from a tool_call_update's `content` array. The ACP
 * shape is `[{type:"content", content:{type:"text", text:"..."}}, ...]` for
 * text outputs. We concatenate the text blocks and trim to a safe inline size.
 */
function extractToolPreview(content: unknown): string | undefined {
	if (!Array.isArray(content)) return undefined;
	const blocks = content as Array<{ type?: string; content?: { type?: string; text?: string } }>;
	const text = blocks
		.filter((b) => b.type === "content" && b.content?.type === "text")
		.map((b) => b.content?.text ?? "")
		.join("");
	if (text.length === 0) return undefined;
	return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

function applyUpdate(
	prev: ChatItem[],
	update: {
		sessionUpdate: string;
		content?: { type?: string; text?: string };
		toolCallId?: string;
		title?: string;
		status?: string;
	},
): ChatItem[] {
	switch (update.sessionUpdate) {
		case "user_message_chunk": {
			// History replay user message — append a discrete user item.
			const text = update.content?.type === "text" ? (update.content.text ?? "") : "";
			return [...prev, { type: "message", message: { id: `replay-u-${prev.length}`, role: "user", text } }];
		}
		case "agent_message_chunk": {
			const text = update.content?.type === "text" ? (update.content.text ?? "") : "";
			const last = prev[prev.length - 1];
			if (last && last.type === "message" && last.message.role === "assistant") {
				const next = prev.slice(0, -1);
				next.push({
					type: "message",
					message: { ...last.message, text: last.message.text + text },
				});
				return next;
			}
			return [
				...prev,
				{ type: "message", message: { id: `a-${Date.now()}-${Math.random()}`, role: "assistant", text } },
			];
		}
		case "tool_call": {
			const id = update.toolCallId;
			if (!id) return prev;
			const name = deriveToolName(update.title, (update as { kind?: string }).kind);
			const previewText = extractToolPreview((update as { content?: unknown }).content);
			const existingIdx = prev.findIndex((it) => it.type === "tool" && it.tool.id === id);
			const card: ChatItem = {
				type: "tool",
				tool: {
					id,
					name,
					status: (update.status as ToolCard["status"]) ?? "running",
					...(previewText !== undefined ? { preview: previewText } : {}),
				},
			};
			if (existingIdx >= 0) {
				const next = prev.slice();
				next[existingIdx] = card;
				return next;
			}
			return [...prev, card];
		}
		case "tool_call_update": {
			const id = update.toolCallId;
			if (!id) return prev;
			const previewText = extractToolPreview((update as { content?: unknown }).content);
			return prev.map<ChatItem>((it) => {
				if (it.type === "tool" && it.tool.id === id) {
					return {
						type: "tool",
						tool: {
							...it.tool,
							status: (update.status as ToolCard["status"]) ?? it.tool.status,
							...(previewText !== undefined ? { preview: previewText } : {}),
						},
					};
				}
				return it;
			});
		}
		default:
			return prev;
	}
}
