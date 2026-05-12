import type { WorkspaceData } from "../workspace/provider";

export interface InitMessage {
	type: "init";
	agentPort: MessagePort;
	systemPrompt?: string;
	appendSystemPrompt?: string;
	// `WorkspaceData` is the structured-cloneable shape; closures (toData/mount)
	// don't cross the postMessage boundary.
	workspace: WorkspaceData;
	/**
	 * Optional `MessagePort` to a sandboxed iframe. When set, the worker
	 * delegates `run_script` execution and extension loading through the
	 * sandbox bridge — required for hosts under strict CSPs that ban
	 * `unsafe-eval` (MV3 chrome extensions).
	 */
	sandboxPort?: MessagePort;
}

export interface WorkerEventMessage {
	type: "bodhi-pi-event";
	record: {
		type: string;
		sessionId?: string;
		toolName?: string;
		userPrompt?: string;
		stopReason?: string;
		/** `null` when the previous model was unset; distinct from `undefined` (= field N/A). */
		fromModelId?: string | null;
		toModelId?: string;
	};
}

export interface WorkerWireMessage {
	type: "bodhi-pi-wire";
	direction: "in" | "out";
	line: string;
	ts: number;
}

export type WorkerMessage = WorkerEventMessage | WorkerWireMessage;
