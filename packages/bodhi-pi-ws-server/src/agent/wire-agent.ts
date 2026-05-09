import type { Agent, AgentSideConnection } from "@agentclientprotocol/sdk";
import { createBodhiPiAgent, createInMemorySessionStore } from "@bodhiapp/bodhi-pi";
import { createNodeFilesystem } from "@bodhiapp/bodhi-pi-node";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { UserCtx } from "../auth/token.js";
import { ensureUserWorkspace } from "../filesystem/user-workspace.js";

export interface WireAgentOptions {
	user: UserCtx;
	dataDir: string;
	models: Model<Api>[];
	defaultModelId: string;
	getApiKey: (provider: string) => string | undefined;
	systemPrompt?: string;
}

export type AgentFactory = (conn: AgentSideConnection) => Agent;

/**
 * Build a per-WS-connection bodhi-pi agent factory.
 *
 * Each WS connection gets its own AcpAgent, in-memory SessionStore (M2 — SQLite in M3),
 * and NodeFilesystem rooted at the user's workspace dir.
 */
export function wireAgentForConnection(opts: WireAgentOptions): AgentFactory {
	const cwd = ensureUserWorkspace(opts.dataDir, opts.user.id);
	const filesystem = createNodeFilesystem({ rootCwd: cwd });
	const sessionStore = createInMemorySessionStore();
	return createBodhiPiAgent({
		models: opts.models,
		defaultModelId: opts.defaultModelId,
		getApiKey: opts.getApiKey,
		sessionStore,
		filesystem,
		...(opts.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
	});
}
