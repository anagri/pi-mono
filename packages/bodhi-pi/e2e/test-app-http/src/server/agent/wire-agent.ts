import path from "node:path";
import type { Agent, AgentSideConnection, LoadSessionRequest, NewSessionRequest } from "@agentclientprotocol/sdk";
import { type BodhiPiEvent, type BodhiPiEventHandlers, createBodhiPiAgent } from "@bodhiapp/bodhi-pi";
import { createNodePackageExtensionLoader } from "@e2e/helpers/extension-loaders/index.js";
import { createNodeFilesystem, createNodeKvStore, createNodeScriptExecutor } from "@e2e/helpers/node-adapters/index.js";
import { pickDefined } from "@e2e/helpers/pick-defined.js";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { UserCtx } from "../auth/token.js";
import { resolveUserWorkspace } from "../filesystem/user-workspace.js";
import { createSqliteSessionStore, type Db } from "../sessions/sqlite-session-store.js";

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
	/** Optional override for the KV store directory; defaults to ~/.bodhi-pi/kv. */
	kvStoreDir?: string;
}

export type AgentFactory = (conn: AgentSideConnection) => Agent;

export interface WireAgentResult {
	/** Server-resolved cwd. The handler uses this for transparent `resumeSession` before `prompt`. */
	cwd: string;
	factory: AgentFactory;
}

/** ACP extension method that forwards bodhi-pi lifecycle events to the client. */
export const LIFECYCLE_EVENT_METHOD = "_bodhi-pi/lifecycle/event";

/**
 * Forwards every BodhiPiEvent — full payload, all 25 types — to the client via
 * `extNotification`. Fire-and-forget; lifecycle delivery must never block agent
 * execution. Returns `undefined` from mutable hooks so the agent keeps its
 * original payload (the test-app observes; it does not mutate).
 *
 * Diverges from production `bodhi-pi-http` deliberately: production downsamples
 * to `LifecycleEventRecord` and only covers 19 of 25 types; the test-app needs
 * full visibility for e2e assertions (sequence + payload-field correctness).
 */
function eventForwardingHandlers(conn: AgentSideConnection): BodhiPiEventHandlers {
	const post = (event: BodhiPiEvent): undefined => {
		void conn.extNotification(LIFECYCLE_EVENT_METHOD, event as unknown as Record<string, unknown>).catch((err) => {
			console.error("[bodhi-pi-test-app-http] lifecycle forward failed:", err);
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
 * Build a per-request bodhi-pi agent factory.
 *
 * Each HTTP request gets its own AcpAgent + multi-tenant SqliteSessionStore
 * scoped to the authenticated userId, plus a NodeFilesystem rooted at the
 * user's workspace. Project-level extensions are discovered fresh from
 * `<cwd>/.bodhi-pi/extensions/` per request.
 *
 * The agent's cwd is fixed server-side. We override newSession/loadSession via
 * a Proxy so clients don't need to know server-side absolute paths.
 *
 * Lifecycle events are forwarded via `extNotification(_bodhi-pi/lifecycle/event)`
 * — see `eventForwardingHandlers`. This requires the inner factory to be
 * constructed *per-conn* (not at wire-agent setup time) so handlers close
 * over the per-request `conn`.
 */
export async function wireAgentForRequest(opts: WireAgentOptions): Promise<WireAgentResult> {
	const cwd = resolveUserWorkspace({
		dataDir: opts.dataDir,
		userId: opts.user.id,
		...(opts.workspaceOverride !== undefined ? { workspaceOverride: opts.workspaceOverride } : {}),
	});
	const filesystem = createNodeFilesystem({ rootCwd: cwd });
	const sessionStore = createSqliteSessionStore({ db: opts.db, userId: opts.user.id });
	const extensionFactories = await createNodePackageExtensionLoader({ cwd });
	const scriptExecutor = createNodeScriptExecutor();
	// Per-user kv dir matches per-user sessions/workspace; without it, every
	// connecting user shares one auth/* namespace which breaks parallel e2e.
	const kvDir = opts.kvStoreDir ? path.join(opts.kvStoreDir, String(opts.user.id)) : undefined;
	const kvStore = createNodeKvStore(kvDir ? { dir: kvDir } : {});

	const factory: AgentFactory = (conn) => {
		// Inner factory built here so eventHandlers close over the per-request conn.
		const innerFactory = createBodhiPiAgent({
			sessionStore,
			filesystem,
			kvStore,
			scriptExecutor,
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
