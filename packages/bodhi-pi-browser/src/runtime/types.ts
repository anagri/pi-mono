import type { Api, Model } from "@mariozechner/pi-ai";
import type { WorkspaceData } from "../workspace/provider";

export interface InitMessage {
	type: "init";
	agentPort: MessagePort;
	models: Model<Api>[];
	defaultModelId: string;
	apiKeys: Record<string, string>;
	systemPrompt?: string;
	// `WorkspaceData` is the structured-cloneable shape; closures (toData/mount)
	// don't cross the postMessage boundary.
	workspace: WorkspaceData;
}

export interface WorkerEventMessage {
	type: "bodhi-pi-event";
	record: {
		type: string;
		sessionId?: string;
		toolName?: string;
		userPrompt?: string;
		stopReason?: string;
		fromModelId?: string;
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
