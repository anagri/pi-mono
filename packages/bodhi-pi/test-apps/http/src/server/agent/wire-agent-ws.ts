import { buildAgentFactory, type WireAgentOptions, type WireAgentResult } from "./wire-agent-shared.js";

export type { AgentFactory } from "./wire-agent-shared.js";
export type WireAgentWsOptions = WireAgentOptions;
export type WireAgentWsResult = WireAgentResult;

export function wireAgentForWsConnection(opts: WireAgentWsOptions): Promise<WireAgentWsResult> {
	return buildAgentFactory(opts, "ws");
}
