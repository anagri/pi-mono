import path from "node:path";
import type { Agent, AgentSideConnection, LoadSessionRequest, NewSessionRequest } from "@agentclientprotocol/sdk";
import { type BodhiPiEvent, type BodhiPiEventHandlers, createBodhiPiAgent, LIFECYCLE_EVENT_METHOD } from "@bodhiapp/bodhi-pi";
import {
	createNodeFilesystem,
	createNodeKvStore,
	createNodePackageExtensionLoader,
	createNodeScriptExecutor,
	createMultiTenantSqliteSessionStore as createSqliteSessionStore,
	type Db,
} from "@bodhiapp/bodhi-pi-test-app-in-memory";
import { createJustBashTerminal } from "@bodhiapp/bodhi-pi-test-app-utils/just-bash-terminal";
import { pickDefined } from "@bodhiapp/bodhi-pi-test-app-utils/pick-defined";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Bash } from "just-bash";
import type { UserCtx } from "../auth/token.js";
import { resolveUserWorkspace } from "../filesystem/user-workspace.js";

export interface WireAgentWsOptions {
	user: UserCtx;
	dataDir: string;
	db: Db;
	models?: Model<Api>[];
	defaultModelId?: string;
	getApiKey?: (provider: string) => string | undefined;
	systemPrompt?: string;
	appendSystemPrompt?: string;
	/** When set, all users share this dir as cwd (CLI `--workspace <dir>`). */
	workspaceOverride?: string;
	/** Optional override for the KV store directory; defaults to ~/.bodhi-pi/kv. */
	kvStoreDir?: string;
}

export type AgentFactory = (conn: AgentSideConnection) => Agent;

export interface WireAgentWsResult {
	/** Server-resolved cwd for this WS connection. */
	cwd: string;
	factory: AgentFactory;
}


// Forwards every BodhiPiEvent — full payload, all 25 types — to the client via
// extNotification. Matches test-app-http's HTTP path so e2e tests assert the same
// shape regardless of transport.
function eventForwardingHandlers(conn: AgentSideConnection): BodhiPiEventHandlers {
	const post = (event: BodhiPiEvent): undefined => {
		void conn.extNotification(LIFECYCLE_EVENT_METHOD, event as unknown as Record<string, unknown>).catch((err) => {
			console.error("[bodhi-pi-test-app-http ws] lifecycle forward failed:", err);
		});
		return undefined;
	};
	return {
		session_start: [post],
		session_shutdown: [post],
		agent_start: [post],
		agent_end: [post],
		turn_start: [post],
		turn_end: [post],
		message_start: [post],
		message_update: [post],
		message_end: [post],
		tool_execution_start: [post],
		tool_execution_update: [post],
		tool_execution_end: [post],
		input: [post],
		before_agent_start: [post],
		before_provider_request: [post],
		after_provider_response: [post],
		tool_call: [post],
		tool_result: [post],
		model_select: [post],
		auth_change: [post],
		settings_change: [post],
		compaction_start: [post],
		compaction_end: [post],
		branch_summary_created: [post],
		session_navigate: [post],
		session_fork: [post],
		session_clone: [post],
	};
}

/**
 * Build a per-WS-connection bodhi-pi agent factory.
 *
 * Each WS upgrade gets its own AcpAgent + multi-tenant SqliteSessionStore scoped
 * to the authenticated userId. The agent stays alive for the connection lifetime
 * (vs. the per-request rebuild of the HTTP path). Project-level extensions are
 * discovered once per connection.
 */
export async function wireAgentForWsConnection(opts: WireAgentWsOptions): Promise<WireAgentWsResult> {
	const cwd = resolveUserWorkspace({
		dataDir: opts.dataDir,
		userId: opts.user.id,
		...(opts.workspaceOverride !== undefined ? { workspaceOverride: opts.workspaceOverride } : {}),
	});
	const filesystem = createNodeFilesystem({ rootCwd: cwd });
	const sessionStore = createSqliteSessionStore({ db: opts.db, userId: opts.user.id });
	const extensionFactories = await createNodePackageExtensionLoader({ cwd });
	const scriptExecutor = createNodeScriptExecutor();
	const terminal = createJustBashTerminal(Bash, { filesystem, defaultCwd: cwd });
	// Per-user kv dir matches per-user sessions/workspace; without it, every
	// connecting user shares one auth/* namespace which breaks parallel e2e.
	const kvDir = opts.kvStoreDir ? path.join(opts.kvStoreDir, String(opts.user.id)) : undefined;
	const kvStore = createNodeKvStore(kvDir ? { dir: kvDir } : {});

	const factory: AgentFactory = (conn) => {
		const innerFactory = createBodhiPiAgent({
			sessionStore,
			filesystem,
			kvStore,
			scriptExecutor,
			terminal,
			// stdio MCP scope is limited to in-memory + cli in this phase.
			supportsMcpStdio: false,
			eventHandlers: eventForwardingHandlers(conn),
			...pickDefined({
				models: opts.models,
				defaultModelId: opts.defaultModelId,
				getApiKey: opts.getApiKey,
				systemPrompt: opts.systemPrompt,
				appendSystemPrompt: opts.appendSystemPrompt,
			}),
			// extensionFactories is omitted when empty so the agent uses its default.
			...(extensionFactories.length > 0 ? { extensionFactories } : {}),
		});
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
