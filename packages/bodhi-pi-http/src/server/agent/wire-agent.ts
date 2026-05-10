import type { Agent, AgentSideConnection, LoadSessionRequest, NewSessionRequest } from "@agentclientprotocol/sdk";
import { createBodhiPiAgent } from "@bodhiapp/bodhi-pi";
import { createNodeExtensionLoader, createNodeFilesystem, createNodeScriptExecutor } from "@bodhiapp/bodhi-pi-node";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { UserCtx } from "../auth/token.js";
import { resolveUserWorkspace } from "../filesystem/user-workspace.js";
import { createSqliteSessionStore, type Db } from "../sessions/sqlite-session-store.js";

export interface WireAgentOptions {
	user: UserCtx;
	dataDir: string;
	db: Db;
	models: Model<Api>[];
	defaultModelId: string;
	getApiKey: (provider: string) => string | undefined;
	systemPrompt?: string;
	/** When set, all users share this dir as cwd (CLI `--workspace <dir>`). */
	workspaceOverride?: string;
}

export type AgentFactory = (conn: AgentSideConnection) => Agent;

export interface WireAgentResult {
	/** Server-resolved cwd. The handler uses this for transparent `resumeSession` before `prompt`. */
	cwd: string;
	factory: AgentFactory;
}

/**
 * Build a per-request bodhi-pi agent factory.
 *
 * Each HTTP request gets its own AcpAgent + multi-tenant SqliteSessionStore
 * scoped to the authenticated userId, plus a NodeFilesystem rooted at the
 * user's workspace. Project-level extensions are discovered fresh from
 * `<cwd>/.bodhi-pi/extensions/` per request.
 *
 * The agent's cwd is fixed server-side. We override newSession/loadSession via
 * a Proxy so clients don't need to know server-side absolute paths.
 */
export async function wireAgentForRequest(opts: WireAgentOptions): Promise<WireAgentResult> {
	const cwd = resolveUserWorkspace({
		dataDir: opts.dataDir,
		userId: opts.user.id,
		...(opts.workspaceOverride !== undefined ? { workspaceOverride: opts.workspaceOverride } : {}),
	});
	const filesystem = createNodeFilesystem({ rootCwd: cwd });
	const sessionStore = createSqliteSessionStore({ db: opts.db, userId: opts.user.id });
	const extensionFactories = await createNodeExtensionLoader({ cwd });
	const scriptExecutor = createNodeScriptExecutor();

	const innerFactory = createBodhiPiAgent({
		models: opts.models,
		defaultModelId: opts.defaultModelId,
		getApiKey: opts.getApiKey,
		sessionStore,
		filesystem,
		scriptExecutor,
		...(opts.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
		...(extensionFactories.length > 0 ? { extensionFactories } : {}),
	});

	const factory: AgentFactory = (conn) => {
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
	return { cwd, factory };
}
