import path from "node:path";
import type { Agent, AgentSideConnection, LoadSessionRequest, NewSessionRequest } from "@agentclientprotocol/sdk";
import { type BodhiPiEvent, type BodhiPiEventHandlers, LIFECYCLE_EVENT_METHOD } from "@bodhiapp/bodhi-pi";
import { createBodhiPiHostAgent } from "@bodhiapp/bodhi-pi-test-app-utils/host-agent";
import {
	createNodeFilesystem,
	createNodeKvStore,
	createNodePackageExtensionLoader,
	createNodeScriptExecutor,
	createMultiTenantSqliteSessionStore as createSqliteSessionStore,
	type Db,
} from "@bodhiapp/bodhi-pi-test-app-node-adapters";
import { createJustBashTerminal } from "@bodhiapp/bodhi-pi-test-app-utils/just-bash-terminal";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Bash } from "just-bash";
import type { UserCtx } from "../auth/token.js";
import { resolveUserWorkspace } from "../filesystem/user-workspace.js";
import type { ServerMcpStore } from "../mcp/server-mcp-store.js";

export interface WireAgentOptions {
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
	/** Optional override for the KV store directory; defaults to <dataDir>/kv. */
	kvStoreDir?: string;
	/** Per-user `McpConnectionProvider` cache shared across HTTP + WS so connections survive per-request rebuild. */
	mcpStore: ServerMcpStore;
}

export type AgentFactory = (conn: AgentSideConnection) => Agent;

export interface WireAgentResult {
	/** Server-resolved cwd. The handler uses this for transparent `resumeSession` before `prompt`. */
	cwd: string;
	factory: AgentFactory;
}

/**
 * Forwards every BodhiPiEvent — full payload, all 32 types — to the client via `extNotification`.
 * Diverges from production `bodhi-pi-http` deliberately: production downsamples to `LifecycleEventRecord`;
 * the test-app needs full visibility for e2e payload-field assertions.
 */
export function createForwardingEventHandlers(conn: AgentSideConnection, label: string): BodhiPiEventHandlers {
	const post = (event: BodhiPiEvent): undefined => {
		void conn.extNotification(LIFECYCLE_EVENT_METHOD, event as unknown as Record<string, unknown>).catch((err) => {
			console.error(`[bodhi-pi-test-app-http ${label}] lifecycle forward failed:`, err);
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
		mcp_status_change: [post],
		mcp_tools_change: [post],
		mcp_oauth_status_change: [post],
		subagent_start: [post],
		subagent_end: [post],
	};
}

/**
 * Build a bodhi-pi agent factory rooted at the authenticated user's workspace.
 * Both the per-request HTTP path and the per-WS-connection path use this shape;
 * the only behavioural difference is who calls it and how often.
 *
 * The agent's cwd is fixed server-side; clients don't know the absolute path.
 * A `Proxy` overrides `newSession`/`loadSession` to inject `cwd` so clients can
 * leave it blank.
 */
export async function buildAgentFactory(opts: WireAgentOptions, label: string): Promise<WireAgentResult> {
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
	const kvRoot = opts.kvStoreDir ?? path.join(opts.dataDir, "kv");
	const kvDir = path.join(kvRoot, String(opts.user.id));
	const kvStore = createNodeKvStore({ dir: kvDir });
	const mcpConnectionProvider = opts.mcpStore.getProviderForUser(String(opts.user.id), kvStore);

	const factory: AgentFactory = (conn) => {
		const innerFactory = createBodhiPiHostAgent(
			{ sessionStore, filesystem },
			{
				kvStore,
				scriptExecutor,
				terminal,
				// stdio MCP requires in-memory + cli host (subprocess lifecycle).
				supportsMcpStdio: false,
				mcpConnectionProvider,
				eventHandlers: createForwardingEventHandlers(conn, label),
				models: opts.models,
				defaultModelId: opts.defaultModelId,
				getApiKey: opts.getApiKey,
				systemPrompt: opts.systemPrompt,
				appendSystemPrompt: opts.appendSystemPrompt,
				extensionFactories: extensionFactories.length > 0 ? extensionFactories : undefined,
				// Multi-tenant: oauth/start emits a state token of the form
				// `<base64url(userId)>.<random>` so /oauth/callback can route the redirect.
				tenantId: String(opts.user.id),
			},
		);
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
