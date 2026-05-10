import { create } from "zustand";

export type MessageRole = "user" | "assistant" | "system" | "tool";

export type ToolCallStatus = "running" | "completed" | "failed";

export interface ToolCallEntry {
	toolCallId: string;
	name: string;
	title: string;
	kind?: string;
	status: ToolCallStatus;
	preview?: string;
}

export interface ChatMessage {
	id: string;
	role: MessageRole;
	content: string;
	toolCall?: ToolCallEntry;
}

export type ChatStatus = "echo" | "initializing" | "idle" | "streaming" | "closed" | "error";

export interface ChatState {
	messages: ChatMessage[];
	status: ChatStatus;
	currentModelId: string;
	sessionId: string;
	mountPath: string;

	addMessage: (role: MessageRole, content: string) => void;
	addSystemMessage: (content: string) => void;
	appendChunk: (role: MessageRole, text: string) => void;
	addToolCall: (entry: ToolCallEntry) => void;
	updateToolCall: (toolCallId: string, patch: Partial<Omit<ToolCallEntry, "toolCallId">>) => void;
	setStatus: (status: ChatStatus) => void;
	setCurrentModelId: (id: string) => void;
	setSessionId: (id: string) => void;
	setMountPath: (path: string) => void;
	clear: () => void;
}

let nextId = 0;
const newId = () => `m${++nextId}`;

export const useChatStore = create<ChatState>((set) => ({
	messages: [],
	status: "echo",
	currentModelId: "echo",
	sessionId: "local",
	mountPath: "",

	addMessage: (role, content) => set((s) => ({ messages: [...s.messages, { id: newId(), role, content }] })),

	addSystemMessage: (content) => set((s) => ({ messages: [...s.messages, { id: newId(), role: "system", content }] })),

	appendChunk: (role, text) =>
		set((s) => {
			// Don't merge into a tool-card row; only into peer text messages.
			const last = s.messages[s.messages.length - 1];
			if (last && last.role === role && !last.toolCall) {
				const updated = { ...last, content: last.content + text };
				return { messages: [...s.messages.slice(0, -1), updated] };
			}
			return { messages: [...s.messages, { id: newId(), role, content: text }] };
		}),

	addToolCall: (entry) =>
		set((s) => {
			// If an entry with this toolCallId already exists, update in place.
			const existingIdx = s.messages.findIndex((m) => m.toolCall?.toolCallId === entry.toolCallId);
			if (existingIdx >= 0) {
				const next = [...s.messages];
				next[existingIdx] = { ...next[existingIdx], toolCall: entry };
				return { messages: next };
			}
			return { messages: [...s.messages, { id: newId(), role: "tool", content: "", toolCall: entry }] };
		}),

	updateToolCall: (toolCallId, patch) =>
		set((s) => {
			const idx = s.messages.findIndex((m) => m.toolCall?.toolCallId === toolCallId);
			if (idx < 0) return s;
			const next = [...s.messages];
			const prev = next[idx];
			if (!prev?.toolCall) return s;
			next[idx] = { ...prev, toolCall: { ...prev.toolCall, ...patch } };
			return { messages: next };
		}),

	setStatus: (status) => set({ status }),
	setCurrentModelId: (currentModelId) => set({ currentModelId }),
	setSessionId: (sessionId) => set({ sessionId }),
	setMountPath: (mountPath) => set({ mountPath }),
	clear: () => set({ messages: [] }),
}));
