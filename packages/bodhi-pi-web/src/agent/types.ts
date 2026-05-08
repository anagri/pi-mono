import type { Api, Model } from "@mariozechner/pi-ai";
import type { WorkspaceConfig } from "../workspace/types";

/** One-shot init message the main thread posts to the worker on spawn. */
export interface InitMessage {
	type: "init";
	agentPort: MessagePort;
	models: Model<Api>[];
	defaultModelId: string;
	apiKeys: Record<string, string>;
	systemPrompt?: string;
	workspace: WorkspaceConfig;
	/**
	 * When true, the worker registers lifecycle-event handlers and posts a small
	 * record of every event back via `self.postMessage` so Playwright specs can
	 * assert event sequences without bridging into the worker realm.
	 */
	recordEvents?: boolean;
}

/** Shape of the messages the worker posts back when `recordEvents` is enabled. */
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
