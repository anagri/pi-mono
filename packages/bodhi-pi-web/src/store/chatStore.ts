import { create } from "zustand";

export type MessageRole = "user" | "assistant" | "system";

export interface ChatMessage {
	id: string;
	role: MessageRole;
	content: string;
}

export type ChatStatus = "echo" | "initializing" | "idle" | "streaming" | "closed" | "error";

export interface ChatState {
	messages: ChatMessage[];
	status: ChatStatus;
	currentModelId: string;
	sessionId: string;

	addMessage: (role: MessageRole, content: string) => void;
	addSystemMessage: (content: string) => void;
	appendChunk: (role: MessageRole, text: string) => void;
	setStatus: (status: ChatStatus) => void;
	setCurrentModelId: (id: string) => void;
	setSessionId: (id: string) => void;
	clear: () => void;
}

let nextId = 0;
const newId = () => `m${++nextId}`;

export const useChatStore = create<ChatState>((set) => ({
	messages: [],
	status: "echo",
	currentModelId: "echo",
	sessionId: "local",

	addMessage: (role, content) => set((s) => ({ messages: [...s.messages, { id: newId(), role, content }] })),

	addSystemMessage: (content) => set((s) => ({ messages: [...s.messages, { id: newId(), role: "system", content }] })),

	appendChunk: (role, text) =>
		set((s) => {
			const last = s.messages[s.messages.length - 1];
			if (last && last.role === role) {
				const updated = { ...last, content: last.content + text };
				return { messages: [...s.messages.slice(0, -1), updated] };
			}
			return { messages: [...s.messages, { id: newId(), role, content: text }] };
		}),

	setStatus: (status) => set({ status }),
	setCurrentModelId: (currentModelId) => set({ currentModelId }),
	setSessionId: (sessionId) => set({ sessionId }),
	clear: () => set({ messages: [] }),
}));
