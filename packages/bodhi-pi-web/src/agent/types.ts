import type { Api, Model } from "@mariozechner/pi-ai";
import type { WorkspaceData } from "../workspace/provider";

/** One-shot init message the main thread posts to the worker on spawn. */
export interface InitMessage {
	type: "init";
	agentPort: MessagePort;
	models: Model<Api>[];
	defaultModelId: string;
	apiKeys: Record<string, string>;
	systemPrompt?: string;
	/**
	 * Wire-format workspace. The main thread holds a `WorkspaceProvider`; closures
	 * don't survive structured clone, so the provider's `toData()` is called and
	 * the worker reconstructs the provider via `workspaceProviderFromData`.
	 */
	workspace: WorkspaceData;
	/**
	 * Independent observability toggle. When true, the worker registers lifecycle-
	 * event handlers and posts a small record of every event back via
	 * `self.postMessage` so Playwright specs can assert event sequences without
	 * bridging into the worker realm. Test-only — derive from
	 * `window.__bodhiPiWebRecordEvents` in `bootstrap.ts`, NOT from the workspace.
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
