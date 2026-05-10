import { create } from "zustand";

// `direction: "in"` = client → agent, `direction: "out"` = agent → client
// (worker-side perspective — the wire-tap lives in the worker).
// Pushes run outside React via the worker postMessage handler in runtime.ts.

export type LifecycleEventRow = {
	id: number;
	type: string;
	sessionId?: string;
	toolName?: string;
	userPrompt?: string;
	stopReason?: string;
	fromModelId?: string;
	toModelId?: string;
};

export type WireFrameKind = "request" | "response" | "notification" | "error" | "unknown";

export type WireEventRow = {
	id: number;
	direction: "in" | "out";
	kind: WireFrameKind;
	method: string;
	rpcId: string;
	payload: string;
	ts: number;
};

interface EventState {
	lifecycle: LifecycleEventRow[];
	wire: WireEventRow[];
	pushLifecycle(row: Omit<LifecycleEventRow, "id">): void;
	pushWire(row: Omit<WireEventRow, "id">): void;
	clear(): void;
}

const MAX_ENTRIES = 500;

let nextId = 0;
const newId = () => ++nextId;

function appendCapped<T>(buffer: T[], row: T): T[] {
	const next = buffer.length >= MAX_ENTRIES ? buffer.slice(buffer.length - MAX_ENTRIES + 1) : buffer.slice();
	next.push(row);
	return next;
}

export const useEventStore = create<EventState>((set) => ({
	lifecycle: [],
	wire: [],
	pushLifecycle: (row) => set((s) => ({ lifecycle: appendCapped(s.lifecycle, { ...row, id: newId() }) })),
	pushWire: (row) => set((s) => ({ wire: appendCapped(s.wire, { ...row, id: newId() }) })),
	clear: () => set({ lifecycle: [], wire: [] }),
}));

// Falls back to "unknown" so malformed bytes still surface in the panel.
export function parseWireFrame(line: string): { kind: WireFrameKind; method: string; rpcId: string } {
	try {
		const obj = JSON.parse(line) as {
			method?: unknown;
			id?: unknown;
			result?: unknown;
			error?: unknown;
			params?: unknown;
		};
		const method = typeof obj.method === "string" ? obj.method : "";
		const rpcId = obj.id !== undefined && obj.id !== null ? String(obj.id) : "";
		let kind: WireFrameKind;
		if (obj.error !== undefined) kind = "error";
		else if (obj.result !== undefined) kind = "response";
		else if (method && obj.id !== undefined && obj.id !== null) kind = "request";
		else if (method) kind = "notification";
		else kind = "unknown";
		return { kind, method, rpcId };
	} catch {
		return { kind: "unknown", method: "", rpcId: "" };
	}
}
