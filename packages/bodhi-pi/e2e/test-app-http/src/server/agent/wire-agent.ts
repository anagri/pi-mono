import type { Agent, AgentSideConnection, LoadSessionRequest, NewSessionRequest } from "@agentclientprotocol/sdk";
import { type BodhiPiEvent, type BodhiPiEventHandlers, createBodhiPiAgent } from "@bodhiapp/bodhi-pi";
import {
	createNodeExtensionLoader,
	createNodeFilesystem,
	createNodeKvStore,
	createNodeScriptExecutor,
} from "@bodhiapp/bodhi-pi-node";
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

export interface LifecycleEventRecord {
	type: BodhiPiEvent["type"];
	sessionId?: string;
	toolName?: string;
	userPrompt?: string;
	stopReason?: string;
	/** `null` when the previous model was unset; distinct from `undefined` (= field N/A). */
	fromModelId?: string | null;
	toModelId?: string;
}

function recordFor(event: BodhiPiEvent): LifecycleEventRecord {
	const record: LifecycleEventRecord = { type: event.type };
	if ("sessionId" in event && event.sessionId) record.sessionId = event.sessionId;
	if (
		event.type === "tool_call" ||
		event.type === "tool_result" ||
		event.type === "tool_execution_start" ||
		event.type === "tool_execution_update" ||
		event.type === "tool_execution_end"
	) {
		record.toolName = event.toolName;
	}
	if (event.type === "agent_start") record.userPrompt = event.userPrompt;
	if (event.type === "agent_end" && event.stopReason !== undefined) record.stopReason = event.stopReason;
	if (event.type === "model_select") {
		record.fromModelId = event.fromModelId;
		record.toModelId = event.toModelId;
	}
	return record;
}

/**
 * Forwards every BodhiPiEvent to the client via `extNotification`. Fire-and-forget;
 * lifecycle delivery must never block agent execution.
 *
 * In the HTTP host, `extNotification` reaches the client only during SSE methods
 * (`session/prompt`, `session/load`) where the response stream is open. JSON-method
 * calls don't emit lifecycle events anyway, so this matches what ws-server does.
 */
function eventForwardingHandlers(conn: AgentSideConnection): BodhiPiEventHandlers {
	const post = (event: BodhiPiEvent): undefined => {
		const record = recordFor(event);
		void conn.extNotification(LIFECYCLE_EVENT_METHOD, record as unknown as Record<string, unknown>).catch((err) => {
			console.error("[bodhi-pi-http] lifecycle forward failed:", err);
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
	const extensionFactories = await createNodeExtensionLoader({ cwd });
	const scriptExecutor = createNodeScriptExecutor();
	const kvStore = createNodeKvStore(opts.kvStoreDir ? { dir: opts.kvStoreDir } : {});

	const factory: AgentFactory = (conn) => {
		// Inner factory built here so eventHandlers close over the per-request conn.
		const innerFactory = createBodhiPiAgent({
			sessionStore,
			filesystem,
			kvStore,
			scriptExecutor,
			...(opts.models !== undefined ? { models: opts.models } : {}),
			...(opts.defaultModelId !== undefined ? { defaultModelId: opts.defaultModelId } : {}),
			...(opts.getApiKey !== undefined ? { getApiKey: opts.getApiKey } : {}),
			eventHandlers: eventForwardingHandlers(conn),
			...(opts.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
			...(opts.appendSystemPrompt !== undefined ? { appendSystemPrompt: opts.appendSystemPrompt } : {}),
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
