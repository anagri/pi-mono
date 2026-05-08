import type { Api, Model } from "@mariozechner/pi-ai";

/** One-shot init message the main thread posts to the worker on spawn. */
export interface InitMessage {
	type: "init";
	agentPort: MessagePort;
	models: Model<Api>[];
	defaultModelId: string;
	apiKeys: Record<string, string>;
	systemPrompt?: string;
}
