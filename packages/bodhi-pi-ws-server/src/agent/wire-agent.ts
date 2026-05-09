import type { Agent, AgentSideConnection, LoadSessionRequest, NewSessionRequest } from "@agentclientprotocol/sdk";
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
 *
 * The agent's cwd is fixed to the server-side per-user workspace path. We override
 * newSession/loadSession to ignore whatever cwd the client sends and substitute the
 * authenticated user's workspace dir — clients don't need to know server paths.
 */
export function wireAgentForConnection(opts: WireAgentOptions): AgentFactory {
	const cwd = ensureUserWorkspace(opts.dataDir, opts.user.id);
	const filesystem = createNodeFilesystem({ rootCwd: cwd });
	const sessionStore = createSqliteSessionStore({ db: opts.db, userId: opts.user.id });
	const innerFactory = createBodhiPiAgent({
		models: opts.models,
		defaultModelId: opts.defaultModelId,
		getApiKey: opts.getApiKey,
		sessionStore,
		filesystem,
		...(opts.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
	});

	return (conn) => {
		const inner = innerFactory(conn);
		return new Proxy(inner, {
			get(target, prop, receiver) {
				if (prop === "newSession") {
					return (params: NewSessionRequest) => target.newSession({ ...params, cwd });
				}
				if (prop === "loadSession" && target.loadSession) {
					const original = target.loadSession.bind(target);
					return (params: LoadSessionRequest) => original({ ...params, cwd });
				}
				return Reflect.get(target, prop, receiver);
			},
		});
	};
}
