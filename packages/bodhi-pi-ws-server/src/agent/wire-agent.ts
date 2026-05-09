import type { Agent, AgentSideConnection } from "@agentclientprotocol/sdk";
import { createBodhiPiAgent } from "@bodhiapp/bodhi-pi";
import { createNodeFilesystem } from "@bodhiapp/bodhi-pi-node";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { UserCtx } from "../auth/token.js";
import { ensureUserWorkspace } from "../filesystem/user-workspace.js";
import { createSqliteSessionStore, type Db } from "../sessions/sqlite-session-store.js";

export interface WireAgentOptions {
	user: UserCtx;
	dataDir: string;
	db: Db;
	models: Model<Api>[];
	defaultModelId: string;
	getApiKey: (provider: string) => string | undefined;
	systemPrompt?: string;
}

export type AgentFactory = (conn: AgentSideConnection) => Agent;

/**
 * Build a per-WS-connection bodhi-pi agent factory.
 *
 * Each WS connection gets its own AcpAgent + multi-tenant SqliteSessionStore (M3)
 * scoped to the authenticated userId, plus a NodeFilesystem rooted at the user's workspace.
 */
export function wireAgentForConnection(opts: WireAgentOptions): AgentFactory {
	const cwd = ensureUserWorkspace(opts.dataDir, opts.user.id);
	const filesystem = createNodeFilesystem({ rootCwd: cwd });
	const sessionStore = createSqliteSessionStore({ db: opts.db, userId: opts.user.id });
	return createBodhiPiAgent({
		models: opts.models,
		defaultModelId: opts.defaultModelId,
		getApiKey: opts.getApiKey,
		sessionStore,
		filesystem,
		...(opts.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
	});
}
