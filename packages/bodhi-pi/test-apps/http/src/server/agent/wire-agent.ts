import { buildAgentFactory, type WireAgentOptions, type WireAgentResult } from "./wire-agent-shared.js";

export type { AgentFactory, WireAgentOptions, WireAgentResult } from "./wire-agent-shared.js";

export function wireAgentForRequest(opts: WireAgentOptions): Promise<WireAgentResult> {
	return buildAgentFactory(opts, "http");
}
