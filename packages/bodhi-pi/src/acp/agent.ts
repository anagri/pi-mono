import { randomUUID } from "node:crypto";
import {
	type Agent as AcpAgent,
	type AgentSideConnection,
	type AuthenticateRequest,
	type AuthenticateResponse,
	type AvailableCommand,
	type CancelNotification,
	type CloseSessionRequest,
	type CloseSessionResponse,
	type InitializeRequest,
	type InitializeResponse,
	type ListSessionsRequest,
	type ListSessionsResponse,
	type LoadSessionRequest,
	type LoadSessionResponse,
	type NewSessionRequest,
	type NewSessionResponse,
	type PromptRequest,
	type PromptResponse,
	RequestError,
	type ResumeSessionRequest,
	type ResumeSessionResponse,
	type SessionConfigOption,
	type SetSessionConfigOptionRequest,
	type SetSessionConfigOptionResponse,
} from "@agentclientprotocol/sdk";
import type {
	AfterToolCallContext,
	AfterToolCallResult,
	AgentLoopTurnUpdate,
	AgentMessage,
	AgentTool,
	BeforeToolCallContext,
	BeforeToolCallResult,
	Agent as PiAgent,
} from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core/dist/agent.js";
import {
	type Api,
	type AssistantMessage,
	clampThinkingLevel,
	getSupportedThinkingLevels,
	isContextOverflow,
	type Model,
	type ModelThinkingLevel,
	type StopReason as PiStopReason,
	type ProviderResponse,
} from "@earendil-works/pi-ai";
import { loadProjectCommands } from "@/commands/discovery.js";
import { expandPromptTemplate, type PromptTemplate } from "@/commands/prompt-templates.js";
import { type ContextFile, loadProjectContextFiles } from "@/core/resource-loader.js";
import { type BodhiPiProjectSettings, loadProjectSettings, type ProviderOptionsEntry } from "@/core/settings.js";
import { loadGlobalSettings } from "@/core/settings-global.js";
import { mergeSettings } from "@/core/settings-merge.js";
import {
	getAt,
	parseDottedKey,
	parseSettingValue,
	type SettingsScope,
	unsetGlobalSetting,
	unsetProjectSetting,
	writeGlobalSetting,
	writeProjectSetting,
} from "@/core/settings-writer.js";
import { buildSystemPrompt } from "@/core/system-prompt.js";
import { EventDispatcher } from "@/events/dispatcher.js";
import type { BodhiPiEventHandlers } from "@/events/types.js";
import { mergeCommands, mergeTools } from "@/extensions/merge.js";
import { ExtensionRunner } from "@/extensions/runner.js";
import type { RegisteredExtension } from "@/extensions/types.js";
import type { Filesystem } from "@/filesystem/filesystem.js";
import { AUTH_PREFIX, type KvStore, type KvStoreEntry } from "@/kv/kv-store.js";
import type { ScriptExecutor } from "@/script-executor/script-executor.js";
import { detectCrossBranch, runBranchSummary } from "@/sessions/branch-summary.js";
import { buildSessionContext, walkPath } from "@/sessions/build-context.js";
import {
	type CompactionSettings,
	calculateContextTokens,
	DEFAULT_COMPACTION_SETTINGS,
	getLastAssistantUsage,
	prepareCompaction,
	runCompaction,
} from "@/sessions/compaction.js";
import type { CompactionEntry, SessionEntry } from "@/sessions/entries.js";
import type { SessionStore } from "@/sessions/session-store.js";
import { loadProjectSkills } from "@/skills/discovery.js";
import { expandSkillCommand } from "@/skills/invocation.js";
import type { Skill } from "@/skills/skill.js";
import { BUILTIN_TOOL_SNIPPETS, createBuiltinTools, toolKindFor } from "@/tools/index.js";
import { BODHI_PI_VERSION } from "@/version.js";
import {
	EXT_DELETE_SESSION,
	EXT_KV_GET,
	EXT_KV_LIST,
	EXT_KV_REMOVE,
	EXT_KV_SET,
	EXT_SESSION_CLONE,
	EXT_SESSION_COMPACT,
	EXT_SESSION_CONFIG,
	EXT_SESSION_ENTRIES,
	EXT_SESSION_EXPORT,
	EXT_SESSION_FORK,
	EXT_SESSION_NAVIGATE,
	EXT_SESSION_SET_NAME,
	EXT_SESSION_SETTINGS_GET,
	EXT_SESSION_SETTINGS_LIST,
	EXT_SESSION_SETTINGS_SET,
	EXT_SESSION_SETTINGS_UNSET,
	EXT_SESSION_STATS,
	EXT_SESSION_TREE,
	MODEL_CONFIG_ID,
	THINKING_CONFIG_ID,
} from "./constants.js";
import {
	agentToolContentForAcp,
	extractText,
	extractToolCalls,
	formatLocationHint,
	isToolResultMessage,
	mapStopReason,
	toolResultContentForAcp,
} from "./notifications.js";

export interface BodhiPiConfig {
	models: Model<Api>[];
	/** Must be one of `models[i].id`. */
	defaultModelId: string;
	getApiKey: (provider: string) => string | undefined;
	sessionStore: SessionStore;
	filesystem: Filesystem;
	/** Replaces the built-in template entirely. Not persisted; reread from config on every load/resume. */
	systemPrompt?: string;
	/** Appended after the system prompt (built-in or custom). Not persisted; reread on every load/resume. */
	appendSystemPrompt?: string;
	/** When provided, the `run_script` built-in tool is registered. Hosts implement per their runtime. */
	scriptExecutor?: ScriptExecutor;
	/** Lifecycle event handlers; map keyed by event type, each value an array of async handlers. */
	eventHandlers?: BodhiPiEventHandlers;
	/**
	 * Pre-loaded extension factories. bodhi-pi core never walks the filesystem;
	 * each runtime (Node via jiti, browser via data-URL ESM) is responsible for
	 * its own discovery + loading and passes the resulting factories here.
	 */
	extensionFactories?: RegisteredExtension[];
	/** Compaction thresholds. Defaults to `DEFAULT_COMPACTION_SETTINGS`. */
	compaction?: Partial<CompactionSettings>;
	/** Home dir for the global settings layer (`~/.bodhi-pi/settings.json`); Node-only. */
	homeDir?: string;
	/** Optional unjailed FS used for the global settings file. Defaults to `filesystem` when unset. */
	globalFilesystem?: Filesystem;
	/** Host-injected KV store; auth keys live under `auth/<provider>`. */
	kvStore?: KvStore;
	/** Host-explicit default thinking level; beats global/project settings. */
	defaultThinkingLevel?: ModelThinkingLevel;
}

interface SessionState {
	piAgent: PiAgent;
	currentModelId: string;
	thinkingLevel: ModelThinkingLevel;
	pendingThinkingLevelChange: boolean;
	cwd: string;
	tools: AgentTool[];
	/** Discovered once at session hydration; refresh requires `session/close` + `session/load`. */
	commands: PromptTemplate[];
	skills: Skill[];
	/** Set by `cancel()`; read by `prompt()` to return `stopReason: "cancelled"`. Reset before each prompt. */
	cancelled: boolean;
	/** Current head of the session DAG; `null` for a fresh session. Bumped on every entry append. */
	leafId: string | null;
	/** True after one auto-compact retry; reset at the start of each prompt() to allow per-turn recovery. */
	overflowRecoveryAttempted: boolean;
	/** Resolved per-session bits surfaced via `_bodhi-pi/session/config`. */
	compaction: CompactionSettings;
	appendSystemPrompt: string | null;
	contextFiles: ContextFile[];
	projectSettings: BodhiPiProjectSettings;
	projectSettingsPresent: boolean;
	/** Global settings layer snapshot (Node hosts only); `null` when `BodhiPiConfig.homeDir` was omitted. */
	globalSettings: BodhiPiProjectSettings | null;
	globalSettingsPresent: boolean;
	globalSettingsParseError?: string;
	projectSettingsParseError?: string;
	sessionOverrides: BodhiPiProjectSettings;
	retryOptions: ResolvedRetryOptions;
}

interface ResolvedRetryOptions {
	maxRetries?: number;
	timeoutMs?: number;
	maxRetryDelayMs?: number;
}

function resolveProviderStreamOptions(provider: string, merged: BodhiPiProjectSettings): ResolvedRetryOptions {
	const perProvider: ProviderOptionsEntry | undefined = merged.providerOptions?.[provider];
	const defaults = merged.retry;
	const out: ResolvedRetryOptions = {};
	const maxRetries = perProvider?.maxRetries ?? defaults?.maxRetries;
	const timeoutMs = perProvider?.timeoutMs;
	const maxRetryDelayMs = perProvider?.maxRetryDelayMs ?? defaults?.maxDelayMs;
	if (maxRetries !== undefined) out.maxRetries = maxRetries;
	if (timeoutMs !== undefined) out.timeoutMs = timeoutMs;
	if (maxRetryDelayMs !== undefined) out.maxRetryDelayMs = maxRetryDelayMs;
	return out;
}

function toAvailableCommand(t: PromptTemplate): AvailableCommand {
	return {
		name: t.name,
		description: t.description,
		...(t.argumentHint ? { input: { hint: t.argumentHint } } : {}),
	};
}

function skillToAvailableCommand(s: Skill): AvailableCommand {
	return { name: `skill:${s.name}`, description: s.description };
}

/** Returns the `toAgent` callback expected by `AgentSideConnection`. */
export function createBodhiPiAgent(config: BodhiPiConfig) {
	if (!config.sessionStore) {
		throw new Error("BodhiPiConfig.sessionStore is required (no default fallback)");
	}
	if (!config.filesystem) {
		throw new Error("BodhiPiConfig.filesystem is required (no default fallback)");
	}
	// Defaults must be in the host-supplied models registry. Extension-contributed
	// providers are *additive* — they cannot satisfy the default model requirement.
	if (!config.models.find((m) => m.id === config.defaultModelId)) {
		throw new Error(`defaultModelId "${config.defaultModelId}" not in models registry`);
	}
	return (conn: AgentSideConnection): AcpAgent => new BodhiPiAcpAgent(config, conn);
}

/**
 * Throw conventions:
 *   - ACP protocol violations → `RequestError(-32602/-32601, ...)`
 *   - tool execution errors → plain `Error` (pi-agent-core surfaces these as
 *     `tool_execution_end.isError` → ACP `tool_call_update.status: "failed"`)
 */
class BodhiPiAcpAgent implements AcpAgent {
	private sessions = new Map<string, SessionState>();
	private readonly events: EventDispatcher;
	private extensionRunner?: ExtensionRunner;
	private extensionRunnerReady?: Promise<void>;

	constructor(
		private readonly config: BodhiPiConfig,
		private readonly conn: AgentSideConnection,
	) {
		// EventDispatcher is constructed once with both host-supplied handlers
		// AND extension-registered handlers merged. Extension handlers are added
		// asynchronously via `ensureExtensionRunner()` on first session use.
		this.events = new EventDispatcher(config.eventHandlers);
	}

	/**
	 * Persist `entry` with `parentId` set to the session's current leaf, then
	 * advance the leaf to `entry.id`. The store and runtime state stay in sync.
	 */
	private async appendEntry(sessionId: string, session: SessionState, entry: SessionEntry): Promise<void> {
		entry.parentId = session.leafId;
		await this.config.sessionStore.append(sessionId, entry);
		session.leafId = entry.id;
		await this.config.sessionStore.setLeafId?.(sessionId, entry.id);
	}

	private async ensureExtensionRunner(): Promise<ExtensionRunner | undefined> {
		const factories = this.config.extensionFactories;
		if (!factories || factories.length === 0) return undefined;
		if (this.extensionRunner) return this.extensionRunner;
		if (!this.extensionRunnerReady) {
			this.extensionRunnerReady = (async () => {
				const runner = await ExtensionRunner.build({
					conn: this.conn,
					sessionStore: this.config.sessionStore,
					extensions: factories,
				});
				this.extensionRunner = runner;
				// Merge extension event handlers into the dispatcher's existing handler map.
				const extHandlers = runner.getEventHandlers();
				for (const [type, list] of Object.entries(extHandlers) as [
					keyof BodhiPiEventHandlers,
					NonNullable<BodhiPiEventHandlers[keyof BodhiPiEventHandlers]>,
				][]) {
					if (!list || list.length === 0) continue;
					this.events.appendHandlers(type, list);
				}
			})();
		}
		await this.extensionRunnerReady;
		return this.extensionRunner;
	}

	async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
		return {
			protocolVersion: 1,
			agentInfo: { name: "bodhi-pi", version: BODHI_PI_VERSION },
			agentCapabilities: {
				loadSession: true,
				sessionCapabilities: {
					list: {},
					close: {},
					resume: {},
				},
				promptCapabilities: { image: false, audio: false, embeddedContext: false },
				mcpCapabilities: { http: false, sse: false },
				_meta: {
					"bodhi-pi": {
						sessionDelete: true,
						sessionCompact: true,
						sessionConfig: true,
						extensions: { tools: true, commands: true, providers: true, events: true },
					},
				},
			},
			authMethods: [],
		};
	}

	async authenticate(_params: AuthenticateRequest): Promise<AuthenticateResponse> {
		return {};
	}

	async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
		await this.ensureExtensionRunner();
		const record = await this.config.sessionStore.create({ cwd: params.cwd });
		const defaultModel = this.findModel(this.config.defaultModelId);
		await this._buildSessionState(record.id, defaultModel, record.cwd);
		await this.advertiseSlashable(record.id);
		await this.events.emitSessionStart({
			type: "session_start",
			sessionId: record.id,
			cwd: record.cwd,
			reason: "new",
		});
		return {
			sessionId: record.id,
			configOptions: this.buildAllConfigOptions(record.id),
		};
	}

	async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
		await this.ensureExtensionRunner();
		const restored = await this.rehydrateSession(params.sessionId, params.cwd);

		// Stream history back via session/update notifications, pairing each
		// assistant tool_use block with its persisted tool_result.
		const toolResultsById = new Map<string, ReturnType<typeof toolResultContentForAcp>>();
		const toolResultIsError = new Map<string, boolean>();
		for (const entry of restored.entries) {
			if (entry.type !== "message") continue;
			if (!isToolResultMessage(entry.message)) continue;
			toolResultsById.set(entry.message.toolCallId, toolResultContentForAcp(entry.message));
			toolResultIsError.set(entry.message.toolCallId, entry.message.isError);
		}

		for (const entry of restored.entries) {
			if (entry.type !== "message") continue;
			const role = entry.message.role;
			if (role === "user") {
				const text = extractText(entry.message);
				if (text) {
					await this.conn.sessionUpdate({
						sessionId: params.sessionId,
						update: {
							sessionUpdate: "user_message_chunk",
							content: { type: "text", text },
						},
					});
				}
			} else if (role === "assistant") {
				const text = extractText(entry.message);
				if (text) {
					await this.conn.sessionUpdate({
						sessionId: params.sessionId,
						update: {
							sessionUpdate: "agent_message_chunk",
							content: { type: "text", text },
						},
					});
				}
				for (const toolCall of extractToolCalls(entry.message)) {
					await this.conn.sessionUpdate({
						sessionId: params.sessionId,
						update: {
							sessionUpdate: "tool_call",
							toolCallId: toolCall.id,
							title: `${toolCall.name} ${formatLocationHint(toolCall.arguments)}`.trim(),
							kind: toolKindFor(toolCall.name),
							status: "completed",
							rawInput: toolCall.arguments,
						},
					});
					const resultContent = toolResultsById.get(toolCall.id);
					if (resultContent !== undefined) {
						await this.conn.sessionUpdate({
							sessionId: params.sessionId,
							update: {
								sessionUpdate: "tool_call_update",
								toolCallId: toolCall.id,
								status: toolResultIsError.get(toolCall.id) ? "failed" : "completed",
								content: resultContent,
							},
						});
					}
				}
			}
		}

		await this.advertiseSlashable(params.sessionId);
		await this.events.emitSessionStart({
			type: "session_start",
			sessionId: params.sessionId,
			cwd: params.cwd,
			reason: "load",
		});
		return {
			configOptions: this.buildAllConfigOptions(params.sessionId),
		};
	}

	async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
		await this.ensureExtensionRunner();
		// Per ACP spec: rehydrate without replaying history.
		await this.rehydrateSession(params.sessionId, params.cwd);
		await this.advertiseSlashable(params.sessionId);
		await this.events.emitSessionStart({
			type: "session_start",
			sessionId: params.sessionId,
			cwd: params.cwd,
			reason: "resume",
		});
		return {
			configOptions: this.buildAllConfigOptions(params.sessionId),
		};
	}

	async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
		const result = await this.config.sessionStore.list({
			cwd: params.cwd ?? undefined,
			cursor: params.cursor ?? undefined,
		});
		return {
			sessions: result.sessions.map((s) => ({
				sessionId: s.sessionId,
				cwd: s.cwd,
				updatedAt: new Date(s.updatedAt).toISOString(),
			})),
			...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
		};
	}

	async closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
		const cached = this.sessions.get(params.sessionId);
		// Per ACP session/close: drop runtime state but keep the persisted record.
		cached?.piAgent.abort();
		this.sessions.delete(params.sessionId);
		await this.events.emitSessionShutdown({ type: "session_shutdown", sessionId: params.sessionId });
		return {};
	}

	async extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
		if (method === EXT_DELETE_SESSION) {
			const sessionId = params.sessionId;
			if (typeof sessionId !== "string") {
				throw new RequestError(-32602, `${EXT_DELETE_SESSION}: sessionId must be a string`);
			}
			this.sessions.get(sessionId)?.piAgent.abort();
			this.sessions.delete(sessionId);
			await this.config.sessionStore.delete(sessionId);
			await this.events.emitSessionShutdown({ type: "session_shutdown", sessionId });
			return {};
		}
		if (method === EXT_SESSION_COMPACT) {
			return await this.handleSessionCompact(params);
		}
		if (method === EXT_SESSION_FORK) {
			return await this.handleSessionFork(params);
		}
		if (method === EXT_SESSION_CLONE) {
			return await this.handleSessionClone(params);
		}
		if (method === EXT_SESSION_ENTRIES) {
			return await this.handleSessionEntries(params);
		}
		if (method === EXT_SESSION_TREE) {
			return await this.handleSessionTree(params);
		}
		if (method === EXT_SESSION_NAVIGATE) {
			return await this.handleSessionNavigate(params);
		}
		if (method === EXT_SESSION_SET_NAME) {
			return await this.handleSessionSetName(params);
		}
		if (method === EXT_SESSION_STATS) {
			return await this.handleSessionStats(params);
		}
		if (method === EXT_SESSION_EXPORT) {
			return await this.handleSessionExport(params);
		}
		if (method === EXT_SESSION_CONFIG) {
			return await this.handleSessionConfig(params);
		}
		if (method === EXT_SESSION_SETTINGS_GET) {
			return await this.handleSettingsGet(params);
		}
		if (method === EXT_SESSION_SETTINGS_SET) {
			return await this.handleSettingsSet(params);
		}
		if (method === EXT_SESSION_SETTINGS_UNSET) {
			return await this.handleSettingsUnset(params);
		}
		if (method === EXT_SESSION_SETTINGS_LIST) {
			return await this.handleSettingsList(params);
		}
		if (method === EXT_KV_SET) {
			return await this.handleKvSet(params);
		}
		if (method === EXT_KV_GET) {
			return await this.handleKvGet(params);
		}
		if (method === EXT_KV_LIST) {
			return await this.handleKvList(params);
		}
		if (method === EXT_KV_REMOVE) {
			return await this.handleKvRemove(params);
		}
		throw new RequestError(-32601, `Method not found: ${method}`);
	}

	private requireSession(method: string, params: Record<string, unknown>): SessionState {
		const sessionId = params.sessionId;
		if (typeof sessionId !== "string") {
			throw new RequestError(-32602, `${method}: sessionId must be a string`);
		}
		const session = this.sessions.get(sessionId);
		if (!session) {
			throw new RequestError(-32602, `session ${sessionId} is not loaded. Call session/load first.`);
		}
		return session;
	}

	private parseScope(method: string, raw: unknown, defaultScope: SettingsScope): SettingsScope {
		if (raw === undefined) return defaultScope;
		if (raw === "global" || raw === "project" || raw === "session") return raw;
		throw new RequestError(-32602, `${method}: scope must be one of "global"|"project"|"session"`);
	}

	private assertGlobalSupported(method: string): string {
		const homeDir = this.config.homeDir;
		if (!homeDir) {
			throw new RequestError(
				-32602,
				`${method}: --global scope not supported on this runtime; use --project or --session`,
			);
		}
		return homeDir;
	}

	private effectiveSettings(session: SessionState): BodhiPiProjectSettings {
		return mergeSettings(
			mergeSettings(session.globalSettings ?? {}, session.projectSettings),
			session.sessionOverrides,
		);
	}

	private sourceForKey(session: SessionState, dotted: string): SettingsScope | "default" {
		const path = parseDottedKey(dotted);
		if (path.length === 0) return "default";
		if (getAt(session.sessionOverrides as Record<string, unknown>, path) !== undefined) return "session";
		if (getAt(session.projectSettings as Record<string, unknown>, path) !== undefined) return "project";
		if (getAt((session.globalSettings ?? {}) as Record<string, unknown>, path) !== undefined) return "global";
		return "default";
	}

	private async handleSettingsGet(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const session = this.requireSession(EXT_SESSION_SETTINGS_GET, params);
		const key = params.key;
		if (typeof key !== "string" || key.length === 0) {
			throw new RequestError(-32602, `${EXT_SESSION_SETTINGS_GET}: key must be a non-empty string`);
		}
		const scope = this.parseScope(EXT_SESSION_SETTINGS_GET, params.scope, "session");
		const path = parseDottedKey(key);
		let source: Record<string, unknown> = {};
		const resolvedScope: SettingsScope | "default" | "effective" = scope;
		if (scope === "global") {
			this.assertGlobalSupported(EXT_SESSION_SETTINGS_GET);
			source = (session.globalSettings ?? {}) as Record<string, unknown>;
		} else if (scope === "project") {
			source = session.projectSettings as Record<string, unknown>;
		} else {
			source = session.sessionOverrides as Record<string, unknown>;
		}
		const value = getAt(source, path);
		const effectiveValue = getAt(this.effectiveSettings(session) as Record<string, unknown>, path);
		const effectiveSource = this.sourceForKey(session, key);
		return {
			key,
			scope: resolvedScope,
			value: value ?? null,
			effective: effectiveValue ?? null,
			source: effectiveSource,
		};
	}

	private async handleSettingsSet(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const session = this.requireSession(EXT_SESSION_SETTINGS_SET, params);
		const key = params.key;
		if (typeof key !== "string" || key.length === 0) {
			throw new RequestError(-32602, `${EXT_SESSION_SETTINGS_SET}: key must be a non-empty string`);
		}
		if (!("value" in params)) {
			throw new RequestError(-32602, `${EXT_SESSION_SETTINGS_SET}: value is required`);
		}
		const value = typeof params.value === "string" ? parseSettingValue(params.value) : params.value;
		const scope = this.parseScope(EXT_SESSION_SETTINGS_SET, params.scope, "session");
		const path = parseDottedKey(key);

		if (scope === "global") {
			const homeDir = this.assertGlobalSupported(EXT_SESSION_SETTINGS_SET);
			const fs = this.config.globalFilesystem ?? this.config.filesystem;
			const updated = await writeGlobalSetting(fs, homeDir, key, value);
			session.globalSettings = updated;
		} else if (scope === "project") {
			const updated = await writeProjectSetting(this.config.filesystem, session.cwd, key, value);
			session.projectSettings = updated;
			session.projectSettingsPresent = true;
		} else {
			// Session scope: mutate in-memory overrides only.
			const next = { ...(session.sessionOverrides as Record<string, unknown>) };
			session.sessionOverrides = (function applySet() {
				const root = { ...next };
				let cur = root;
				for (let i = 0; i < path.length - 1; i++) {
					const seg = path[i];
					const existing = cur[seg];
					const fresh =
						existing && typeof existing === "object" && !Array.isArray(existing)
							? { ...(existing as Record<string, unknown>) }
							: {};
					cur[seg] = fresh;
					cur = fresh as Record<string, unknown>;
				}
				if (path.length > 0) cur[path[path.length - 1]] = value;
				return root;
			})() as BodhiPiProjectSettings;
		}

		return {
			key,
			scope,
			effective: getAt(this.effectiveSettings(session) as Record<string, unknown>, path) ?? null,
		};
	}

	private async handleSettingsUnset(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const session = this.requireSession(EXT_SESSION_SETTINGS_UNSET, params);
		const key = params.key;
		if (typeof key !== "string" || key.length === 0) {
			throw new RequestError(-32602, `${EXT_SESSION_SETTINGS_UNSET}: key must be a non-empty string`);
		}
		const scope = this.parseScope(EXT_SESSION_SETTINGS_UNSET, params.scope, "session");
		const path = parseDottedKey(key);

		if (scope === "global") {
			const homeDir = this.assertGlobalSupported(EXT_SESSION_SETTINGS_UNSET);
			const fs = this.config.globalFilesystem ?? this.config.filesystem;
			const updated = await unsetGlobalSetting(fs, homeDir, key);
			session.globalSettings = updated;
		} else if (scope === "project") {
			const updated = await unsetProjectSetting(this.config.filesystem, session.cwd, key);
			session.projectSettings = updated;
		} else {
			// Session scope: delete from in-memory overrides.
			const root = { ...(session.sessionOverrides as Record<string, unknown>) };
			let cur = root;
			let ok = true;
			for (let i = 0; i < path.length - 1; i++) {
				const next = cur[path[i]];
				if (!next || typeof next !== "object" || Array.isArray(next)) {
					ok = false;
					break;
				}
				const fresh = { ...(next as Record<string, unknown>) };
				cur[path[i]] = fresh;
				cur = fresh;
			}
			if (ok && path.length > 0) delete cur[path[path.length - 1]];
			session.sessionOverrides = root as BodhiPiProjectSettings;
		}

		return {
			key,
			scope,
			effective: getAt(this.effectiveSettings(session) as Record<string, unknown>, path) ?? null,
		};
	}

	private async handleSettingsList(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const session = this.requireSession(EXT_SESSION_SETTINGS_LIST, params);
		const raw = params.scope;
		const scope: SettingsScope | "effective" =
			raw === undefined || raw === "effective"
				? "effective"
				: this.parseScope(EXT_SESSION_SETTINGS_LIST, raw, "session");
		if (scope === "global") this.assertGlobalSupported(EXT_SESSION_SETTINGS_LIST);
		const settings =
			scope === "global"
				? (session.globalSettings ?? {})
				: scope === "project"
					? session.projectSettings
					: scope === "session"
						? session.sessionOverrides
						: this.effectiveSettings(session);
		return {
			scope,
			settings: settings as Record<string, unknown>,
		};
	}

	private requireKvStore(method: string): KvStore {
		if (!this.config.kvStore) {
			throw new RequestError(-32601, `${method}: kvStore not configured on this host`);
		}
		return this.config.kvStore;
	}

	private async handleKvSet(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const kv = this.requireKvStore(EXT_KV_SET);
		const key = params.key;
		const value = params.value;
		if (typeof key !== "string" || key.length === 0) {
			throw new RequestError(-32602, `${EXT_KV_SET}: key must be a non-empty string`);
		}
		if (typeof value !== "string") {
			throw new RequestError(-32602, `${EXT_KV_SET}: value must be a string`);
		}
		const secret = params.secret === true;
		await kv.set(key, value, { secret });
		return { key, secret };
	}

	private maskEntry(entry: KvStoreEntry): { value: string; secret: boolean } {
		return { value: entry.secret ? "***" : entry.value, secret: entry.secret };
	}

	private async handleKvGet(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const kv = this.requireKvStore(EXT_KV_GET);
		const key = params.key;
		if (typeof key !== "string" || key.length === 0) {
			throw new RequestError(-32602, `${EXT_KV_GET}: key must be a non-empty string`);
		}
		const entry = await kv.getWithMeta(key);
		if (!entry) return { key, value: null, secret: false };
		return { key, ...this.maskEntry(entry) };
	}

	private async handleKvList(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const kv = this.requireKvStore(EXT_KV_LIST);
		const prefix = params.prefix;
		if (prefix !== undefined && typeof prefix !== "string") {
			throw new RequestError(-32602, `${EXT_KV_LIST}: prefix must be a string`);
		}
		const entries = await kv.listWithMeta(prefix);
		return {
			entries: entries.map((e) => ({ key: e.key, ...this.maskEntry(e) })),
		};
	}

	private async handleKvRemove(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const kv = this.requireKvStore(EXT_KV_REMOVE);
		const key = params.key;
		if (typeof key !== "string" || key.length === 0) {
			throw new RequestError(-32602, `${EXT_KV_REMOVE}: key must be a non-empty string`);
		}
		await kv.remove(key);
		return { key };
	}

	private async handleSessionConfig(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const sessionId = params.sessionId;
		if (typeof sessionId !== "string") {
			throw new RequestError(-32602, `${EXT_SESSION_CONFIG}: sessionId must be a string`);
		}
		const session = this.sessions.get(sessionId);
		if (!session) {
			throw new RequestError(-32602, `session ${sessionId} is not loaded. Call session/load first.`);
		}
		const effective = mergeSettings(
			mergeSettings(session.globalSettings ?? {}, session.projectSettings),
			session.sessionOverrides,
		);
		return {
			sessionId,
			cwd: session.cwd,
			defaultModelId: this.config.defaultModelId,
			currentModelId: session.currentModelId,
			thinkingLevel: session.thinkingLevel,
			retryOptions: { ...session.retryOptions },
			compaction: { ...session.compaction },
			appendSystemPrompt: session.appendSystemPrompt,
			contextFilePaths: session.contextFiles.map((f) => f.path),
			projectSettingsPresent: session.projectSettingsPresent,
			projectSettings: session.projectSettings as Record<string, unknown>,
			globalSettingsPresent: session.globalSettingsPresent,
			globalSettings: (session.globalSettings ?? null) as Record<string, unknown> | null,
			sessionOverrides: session.sessionOverrides as Record<string, unknown>,
			layers: {
				global: (session.globalSettings ?? null) as Record<string, unknown> | null,
				project: session.projectSettings as Record<string, unknown>,
				sessionOverrides: session.sessionOverrides as Record<string, unknown>,
				effective: effective as Record<string, unknown>,
			},
			...(session.globalSettingsParseError !== undefined
				? { globalSettingsParseError: session.globalSettingsParseError }
				: {}),
			...(session.projectSettingsParseError !== undefined
				? { projectSettingsParseError: session.projectSettingsParseError }
				: {}),
		};
	}

	private async handleSessionSetName(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const sessionId = params.sessionId;
		const name = params.name;
		if (typeof sessionId !== "string") {
			throw new RequestError(-32602, `${EXT_SESSION_SET_NAME}: sessionId must be a string`);
		}
		if (typeof name !== "string") {
			throw new RequestError(-32602, `${EXT_SESSION_SET_NAME}: name must be a string`);
		}
		const session = this.sessions.get(sessionId);
		if (!session) {
			throw new RequestError(-32602, `session ${sessionId} is not loaded. Call session/load first.`);
		}
		await this.appendEntry(sessionId, session, {
			type: "session_info",
			id: randomUUID(),
			parentId: session.leafId,
			timestamp: Date.now(),
			name,
		});
		return { ok: true, name };
	}

	private async handleSessionStats(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const sessionId = params.sessionId;
		if (typeof sessionId !== "string") {
			throw new RequestError(-32602, `${EXT_SESSION_STATS}: sessionId must be a string`);
		}
		const record = await this.config.sessionStore.load(sessionId);
		if (!record) throw new RequestError(-32602, `unknown session: ${sessionId}`);
		const path = walkPath(record.entries, record.leafId ?? null);
		let messageCount = 0;
		let toolCallCount = 0;
		let name: string | undefined;
		for (const entry of path) {
			if (entry.type === "message") {
				const role = entry.message.role;
				if (role === "user" || role === "assistant") messageCount++;
				if (role === "assistant") {
					for (const block of entry.message.content) {
						if (block.type === "toolCall") toolCallCount++;
					}
				}
			} else if (entry.type === "session_info" && entry.name !== undefined) {
				name = entry.name;
			}
		}
		const leafId = record.leafId ?? record.entries[record.entries.length - 1]?.id ?? null;
		return {
			messageCount,
			toolCallCount,
			leafId,
			...(name !== undefined ? { name } : {}),
		};
	}

	private async handleSessionExport(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const sessionId = params.sessionId;
		if (typeof sessionId !== "string") {
			throw new RequestError(-32602, `${EXT_SESSION_EXPORT}: sessionId must be a string`);
		}
		const record = await this.config.sessionStore.load(sessionId);
		if (!record) throw new RequestError(-32602, `unknown session: ${sessionId}`);
		const path = walkPath(record.entries, record.leafId ?? null);
		const lines: string[] = [
			JSON.stringify({
				type: "session",
				version: 1,
				id: record.id,
				cwd: record.cwd,
				createdAt: record.createdAt,
				...(record.parentSessionId !== undefined ? { parentSessionId: record.parentSessionId } : {}),
			}),
		];
		for (const entry of path) lines.push(JSON.stringify(entry));
		return { format: "jsonl", content: lines.join("\n") };
	}

	private async handleSessionTree(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const sessionId = params.sessionId;
		if (typeof sessionId !== "string") {
			throw new RequestError(-32602, `${EXT_SESSION_TREE}: sessionId must be a string`);
		}
		const record = await this.config.sessionStore.load(sessionId);
		if (!record) throw new RequestError(-32602, `unknown session: ${sessionId}`);
		const childCount = new Map<string, number>();
		for (const entry of record.entries) {
			if (entry.parentId) childCount.set(entry.parentId, (childCount.get(entry.parentId) ?? 0) + 1);
		}
		const leafId = record.leafId ?? record.entries[record.entries.length - 1]?.id ?? null;
		const nodes = record.entries.map((entry) => {
			let preview = "";
			let role: string | undefined;
			if (entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant")) {
				role = entry.message.role;
				const text = extractText(entry.message).trim();
				preview = text.length > 60 ? `${text.slice(0, 60)}…` : text;
			}
			return {
				id: entry.id,
				parentId: entry.parentId ?? null,
				type: entry.type,
				...(role ? { role } : {}),
				...(preview ? { preview } : {}),
				isLeaf: entry.id === leafId,
				childCount: childCount.get(entry.id) ?? 0,
			};
		});
		return { leafId, nodes };
	}

	private async handleSessionNavigate(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const sessionId = params.sessionId;
		const targetEntryId = params.targetEntryId;
		if (typeof sessionId !== "string") {
			throw new RequestError(-32602, `${EXT_SESSION_NAVIGATE}: sessionId must be a string`);
		}
		if (typeof targetEntryId !== "string") {
			throw new RequestError(-32602, `${EXT_SESSION_NAVIGATE}: targetEntryId must be a string`);
		}
		const record = await this.config.sessionStore.load(sessionId);
		if (!record) throw new RequestError(-32602, `unknown session: ${sessionId}`);
		const target = record.entries.find((e) => e.id === targetEntryId);
		if (!target) throw new RequestError(-32602, `unknown entry: ${targetEntryId}`);

		const session = this.sessions.get(sessionId);
		const oldLeaf = session?.leafId ?? record.leafId ?? null;

		// If navigation crosses branches, summarize the abandoned tail and append
		// a branch_summary entry on the new branch BEFORE moving the leaf.
		const cross = detectCrossBranch(record.entries, oldLeaf, targetEntryId);
		if (cross && session) {
			try {
				const apiKey = await this.resolveApiKeyForCompaction(session.piAgent.state.model.provider);
				if (apiKey) {
					const result = await runBranchSummary(cross.abandonedTail, session.piAgent.state.model, apiKey);
					if (result.summary) {
						session.leafId = targetEntryId;
						await this.config.sessionStore.setLeafId?.(sessionId, targetEntryId);
						await this.appendEntry(sessionId, session, {
							type: "branch_summary",
							id: randomUUID(),
							parentId: targetEntryId,
							timestamp: Date.now(),
							fromId: cross.commonAncestorId,
							summary: result.summary,
							...(result.details ? { details: result.details } : {}),
						});
						const refreshed = await this.config.sessionStore.load(sessionId);
						if (refreshed) {
							const ctx = buildSessionContext(refreshed, session.leafId);
							session.piAgent.state.messages = ctx.messages;
						}
						return { leafId: session.leafId };
					}
				}
			} catch {
				// Non-fatal: fall through to plain navigate
			}
		}

		await this.config.sessionStore.setLeafId?.(sessionId, targetEntryId);

		if (session) {
			session.leafId = targetEntryId;
			const refreshed = await this.config.sessionStore.load(sessionId);
			if (refreshed) {
				const ctx = buildSessionContext(refreshed, targetEntryId);
				session.piAgent.state.messages = ctx.messages;
			}
		}
		return { leafId: targetEntryId };
	}

	private async handleSessionEntries(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const sessionId = params.sessionId;
		if (typeof sessionId !== "string") {
			throw new RequestError(-32602, `${EXT_SESSION_ENTRIES}: sessionId must be a string`);
		}
		const record = await this.config.sessionStore.load(sessionId);
		if (!record) throw new RequestError(-32602, `unknown session: ${sessionId}`);
		const path = walkPath(record.entries, record.leafId ?? null);
		const out: { id: string; role: string; preview: string }[] = [];
		for (const entry of path) {
			if (entry.type !== "message") continue;
			const role = entry.message.role;
			if (role !== "user" && role !== "assistant") continue;
			const text = extractText(entry.message).trim();
			const preview = text.length > 60 ? `${text.slice(0, 60)}…` : text;
			out.push({ id: entry.id, role, preview });
		}
		return { entries: out };
	}

	private async handleSessionFork(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const sessionId = params.sessionId;
		const entryId = params.entryId;
		const position = params.position === "at" ? "at" : "before";
		if (typeof sessionId !== "string") {
			throw new RequestError(-32602, `${EXT_SESSION_FORK}: sessionId must be a string`);
		}
		if (typeof entryId !== "string") {
			throw new RequestError(-32602, `${EXT_SESSION_FORK}: entryId must be a string`);
		}
		const record = await this.config.sessionStore.load(sessionId);
		if (!record) throw new RequestError(-32602, `unknown session: ${sessionId}`);
		const target = record.entries.find((e) => e.id === entryId);
		if (!target) throw new RequestError(-32602, `unknown entry: ${entryId}`);
		if (!this.config.sessionStore.forkRecord) {
			throw new RequestError(-32603, "session store does not support forking");
		}
		const { newSessionId } = await this.config.sessionStore.forkRecord(sessionId, entryId, position);
		const out: Record<string, unknown> = { newSessionId };
		if (position === "before" && target.type === "message" && target.message.role === "user") {
			const text = target.message.content;
			const selectedText =
				typeof text === "string"
					? text
					: text
							.filter((b): b is { type: "text"; text: string } => b.type === "text")
							.map((b) => b.text)
							.join("");
			if (selectedText) out.selectedText = selectedText;
		}
		return out;
	}

	private async handleSessionClone(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const sessionId = params.sessionId;
		if (typeof sessionId !== "string") {
			throw new RequestError(-32602, `${EXT_SESSION_CLONE}: sessionId must be a string`);
		}
		const record = await this.config.sessionStore.load(sessionId);
		if (!record) throw new RequestError(-32602, `unknown session: ${sessionId}`);
		const leafId = record.leafId ?? record.entries[record.entries.length - 1]?.id;
		if (!leafId) throw new RequestError(-32603, "cannot clone an empty session");
		if (!this.config.sessionStore.forkRecord) {
			throw new RequestError(-32603, "session store does not support cloning");
		}
		const { newSessionId } = await this.config.sessionStore.forkRecord(sessionId, leafId, "at");
		return { newSessionId };
	}

	private async handleSessionCompact(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const sessionId = params.sessionId;
		if (typeof sessionId !== "string") {
			throw new RequestError(-32602, `${EXT_SESSION_COMPACT}: sessionId must be a string`);
		}
		const customInstructions = typeof params.customInstructions === "string" ? params.customInstructions : undefined;
		const session = this.sessions.get(sessionId);
		if (!session) {
			throw new RequestError(-32602, `session ${sessionId} is not loaded. Call session/load first.`);
		}
		const record = await this.config.sessionStore.load(sessionId);
		if (!record) throw new RequestError(-32602, `unknown session: ${sessionId}`);

		const path = walkPath(record.entries, session.leafId);
		const preparation = prepareCompaction(path, session.compaction);
		if (!preparation) {
			throw new RequestError(-32603, "nothing to compact (session is empty or already compacted at the leaf)");
		}

		const model = session.piAgent.state.model;
		const apiKey = await this.resolveApiKeyForCompaction(model.provider);
		if (!apiKey) {
			throw new RequestError(-32603, `no API key available for provider "${model.provider}"`);
		}
		const result = await runCompaction(preparation, model, apiKey, customInstructions);

		const compactionEntry: CompactionEntry = {
			type: "compaction",
			id: randomUUID(),
			parentId: session.leafId,
			timestamp: Date.now(),
			summary: result.summary,
			firstKeptEntryId: result.firstKeptEntryId,
			tokensBefore: result.tokensBefore,
			...(result.details ? { details: result.details } : {}),
		};
		await this.appendEntry(sessionId, session, compactionEntry);

		// Rebuild the live agent's message list from the new branch (compaction summary + kept tail).
		const refreshed = await this.config.sessionStore.load(sessionId);
		if (refreshed) {
			const ctx = buildSessionContext(refreshed, session.leafId);
			session.piAgent.state.messages = ctx.messages;
		}

		return {
			summary: result.summary,
			firstKeptEntryId: result.firstKeptEntryId,
			tokensBefore: result.tokensBefore,
			...(result.details ? { details: result.details } : {}),
		};
	}

	private async resolveProviderApiKey(provider: string): Promise<string | undefined> {
		const kvKey = await this.config.kvStore?.get(AUTH_PREFIX + provider);
		if (kvKey !== undefined) return kvKey;
		const hostKey = this.config.getApiKey(provider);
		if (hostKey !== undefined) return hostKey;
		const ext = await this.extensionRunner?.resolveProviderKey(provider);
		return ext ?? undefined;
	}

	private async resolveApiKeyForCompaction(provider: string): Promise<string | undefined> {
		return this.resolveProviderApiKey(provider);
	}

	async setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
		const session = this.sessions.get(params.sessionId);
		if (!session) {
			throw new RequestError(-32602, `unknown session: ${params.sessionId}`);
		}
		if (params.configId === MODEL_CONFIG_ID) {
			await this.setSessionModel(params.sessionId, session, params.value);
		} else if (params.configId === THINKING_CONFIG_ID) {
			await this.setSessionThinkingLevel(params.sessionId, session, params.value);
		} else {
			throw new RequestError(-32602, `unknown configId: ${params.configId}`);
		}
		return { configOptions: this.buildAllConfigOptions(params.sessionId) };
	}

	private async setSessionModel(sessionId: string, session: SessionState, value: unknown): Promise<void> {
		if (typeof value !== "string") {
			throw new RequestError(-32602, `model config requires string value, got ${typeof value}`);
		}
		const newModel = this.findModel(value);
		const previousModelId = session.currentModelId;
		// pi-ai's streamSimple reads state.model per turn, so mutating here routes the next prompt to the new model.
		session.piAgent.state.model = newModel;
		session.currentModelId = value;
		const clamped = clampThinkingLevel(newModel, session.thinkingLevel);
		if (clamped !== session.thinkingLevel) {
			session.thinkingLevel = clamped;
			session.piAgent.state.thinkingLevel = clamped as never;
			session.pendingThinkingLevelChange = true;
		}
		await this.appendEntry(sessionId, session, {
			type: "model_change",
			id: randomUUID(),
			parentId: session.leafId,
			timestamp: Date.now(),
			provider: newModel.provider,
			modelId: newModel.id,
		});
		await this.events.emitModelSelect({
			type: "model_select",
			sessionId,
			fromModelId: previousModelId,
			toModelId: value,
		});
	}

	private async setSessionThinkingLevel(sessionId: string, session: SessionState, value: unknown): Promise<void> {
		if (typeof value !== "string") {
			throw new RequestError(-32602, `thinking config requires string value, got ${typeof value}`);
		}
		const supported = getSupportedThinkingLevels(session.piAgent.state.model);
		if (!supported.includes(value as ModelThinkingLevel)) {
			throw new RequestError(
				-32602,
				`unsupported thinking level "${value}" for model ${session.piAgent.state.model.id}; supported: ${supported.join(", ")}`,
			);
		}
		const level = value as ModelThinkingLevel;
		if (level === session.thinkingLevel) return;
		session.thinkingLevel = level;
		// Mutate pi-agent state so subsequent prompt() invocations see the new level
		// (prepareNextTurn only handles mid-loop swaps within a single agentLoop call).
		session.piAgent.state.thinkingLevel = level as never;
		session.pendingThinkingLevelChange = true;
		await this.appendEntry(sessionId, session, {
			type: "thinking_change",
			id: randomUUID(),
			parentId: session.leafId,
			timestamp: Date.now(),
			level,
		});
	}

	async prompt(params: PromptRequest): Promise<PromptResponse> {
		const session = this.sessions.get(params.sessionId);
		if (!session) {
			throw new RequestError(-32602, `session ${params.sessionId} is not loaded. Call session/load first.`);
		}

		const text = params.prompt
			.filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
			.map((b) => b.text)
			.join("");
		// Skills first because they use the more specific `/skill:` prefix; if no
		// skill matches, the text falls through to slash-command expansion.
		const expandedText = expandPromptTemplate(expandSkillCommand(text, session.skills), session.commands);

		// Reset so a prior cancel doesn't bleed into this prompt.
		session.cancelled = false;
		// Each user prompt gets one shot at overflow auto-compact recovery.
		session.overflowRecoveryAttempted = false;

		const sessionId = params.sessionId;
		const events = this.events;

		// Mutable input hook — extensions can rewrite text or short-circuit with `handled: true`.
		const inputResult = await events.emitInput({ type: "input", sessionId, text: expandedText, source: "acp" });
		if (inputResult.handled) {
			return { stopReason: "end_turn", userMessageId: params.messageId ?? null };
		}

		// Mutable system-prompt + user-prompt hook (fired once per agent run).
		const before = await events.emitBeforeAgentStart({
			type: "before_agent_start",
			sessionId,
			systemPrompt: session.piAgent.state.systemPrompt,
			userPrompt: inputResult.text,
		});
		if (before.systemPrompt !== session.piAgent.state.systemPrompt) {
			session.piAgent.state.systemPrompt = before.systemPrompt;
		}
		const promptText = before.userPrompt;

		await events.emitAgentStart({ type: "agent_start", sessionId, userPrompt: promptText });

		const outcome: { stopReason?: PiStopReason; errorMessage?: string } = {};
		const unsubscribe = this.subscribeToAgent(sessionId, session, outcome);

		try {
			await session.piAgent.prompt(promptText);
			await session.piAgent.waitForIdle();
			if (session.cancelled) {
				await events.emitAgentEnd({
					type: "agent_end",
					sessionId,
					stopReason: "cancelled",
					messages: session.piAgent.state.messages,
					...(outcome.errorMessage !== undefined ? { errorMessage: outcome.errorMessage } : {}),
				});
				return { stopReason: "cancelled", userMessageId: params.messageId ?? null };
			}
			if (outcome.stopReason === "error") {
				const recovered = await this.tryOverflowRecovery(sessionId, session, promptText, outcome);
				if (recovered) {
					return { stopReason: "end_turn", userMessageId: params.messageId ?? null };
				}
				await events.emitAgentEnd({
					type: "agent_end",
					sessionId,
					messages: session.piAgent.state.messages,
					errorMessage: outcome.errorMessage ?? "model error",
				});
				throw new RequestError(-32603, outcome.errorMessage ?? "model error");
			}
			const stopReason = mapStopReason(outcome.stopReason);
			await events.emitAgentEnd({
				type: "agent_end",
				sessionId,
				stopReason,
				messages: session.piAgent.state.messages,
			});
			await this.checkAutoCompact(sessionId, session);
			return { stopReason, userMessageId: params.messageId ?? null };
		} finally {
			unsubscribe();
		}
	}

	private async checkAutoCompact(sessionId: string, session: SessionState): Promise<void> {
		await this.runProactiveCompaction(sessionId, session);
	}

	private async maybeProactiveCompact(sessionId: string): Promise<AgentLoopTurnUpdate | undefined> {
		const session = this.sessions.get(sessionId);
		if (!session || session.cancelled) return undefined;
		const ctx = await this.runProactiveCompaction(sessionId, session);
		if (!ctx) return undefined;
		return {
			context: {
				systemPrompt: session.piAgent.state.systemPrompt,
				messages: ctx.messages,
				tools: session.piAgent.state.tools,
			},
		};
	}

	private async runProactiveCompaction(
		sessionId: string,
		session: SessionState,
	): Promise<{ messages: AgentMessage[] } | undefined> {
		const settings = session.compaction;
		if (!settings.enabled) return undefined;
		const record = await this.config.sessionStore.load(sessionId);
		if (!record) return undefined;
		const path = walkPath(record.entries, session.leafId);
		const usage = getLastAssistantUsage(path);
		if (!usage) return undefined;
		const contextTokens = calculateContextTokens(usage);
		const contextWindow = (session.piAgent.state.model as Model<Api> & { contextWindow?: number }).contextWindow ?? 0;
		if (contextWindow <= 0) return undefined;
		if (contextTokens <= contextWindow - settings.reserveTokens) return undefined;
		const preparation = prepareCompaction(path, settings);
		if (!preparation) return undefined;
		const apiKey = await this.resolveApiKeyForCompaction(session.piAgent.state.model.provider);
		if (!apiKey) return undefined;
		try {
			const result = await runCompaction(preparation, session.piAgent.state.model, apiKey);
			const compactionEntry: CompactionEntry = {
				type: "compaction",
				id: randomUUID(),
				parentId: session.leafId,
				timestamp: Date.now(),
				summary: result.summary,
				firstKeptEntryId: result.firstKeptEntryId,
				tokensBefore: result.tokensBefore,
				...(result.details ? { details: result.details } : {}),
			};
			await this.appendEntry(sessionId, session, compactionEntry);
			const refreshed = await this.config.sessionStore.load(sessionId);
			if (!refreshed) return undefined;
			const rebuilt = buildSessionContext(refreshed, session.leafId);
			session.piAgent.state.messages = rebuilt.messages;
			return { messages: rebuilt.messages };
		} catch {
			// Auto-compact errors are non-fatal — leave the session uncompacted.
			return undefined;
		}
	}

	/**
	 * Catch context-overflow errors from the provider, run an emergency compaction,
	 * and retry the same prompt once. Subsequent overflows fall through to the
	 * caller's error path. The retry suppresses the original `agent_end` (caller
	 * already emitted one for the failed turn); a successful retry emits its own.
	 */
	private async tryOverflowRecovery(
		sessionId: string,
		session: SessionState,
		promptText: string,
		outcome: { stopReason?: PiStopReason; errorMessage?: string },
	): Promise<boolean> {
		if (session.overflowRecoveryAttempted) return false;
		const messages = session.piAgent.state.messages;
		const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
		if (!lastAssistant) return false;
		const contextWindow = (session.piAgent.state.model as Model<Api> & { contextWindow?: number }).contextWindow ?? 0;
		if (!isContextOverflow(lastAssistant as AssistantMessage, contextWindow > 0 ? contextWindow : undefined)) {
			return false;
		}
		session.overflowRecoveryAttempted = true;

		// Drop the failed assistant message so the retry doesn't replay it as history.
		session.piAgent.state.messages = messages.slice(0, -1);

		const record = await this.config.sessionStore.load(sessionId);
		if (!record) return false;
		const path = walkPath(record.entries, session.leafId);
		const preparation = prepareCompaction(path, session.compaction);
		if (!preparation) return false;
		const apiKey = await this.resolveApiKeyForCompaction(session.piAgent.state.model.provider);
		if (!apiKey) return false;
		try {
			const result = await runCompaction(preparation, session.piAgent.state.model, apiKey);
			const compactionEntry: CompactionEntry = {
				type: "compaction",
				id: randomUUID(),
				parentId: session.leafId,
				timestamp: Date.now(),
				summary: result.summary,
				firstKeptEntryId: result.firstKeptEntryId,
				tokensBefore: result.tokensBefore,
				...(result.details ? { details: result.details } : {}),
			};
			await this.appendEntry(sessionId, session, compactionEntry);
			const refreshed = await this.config.sessionStore.load(sessionId);
			if (refreshed) {
				const ctx = buildSessionContext(refreshed, session.leafId);
				session.piAgent.state.messages = ctx.messages;
			}
		} catch {
			return false;
		}

		// Retry the same user prompt once. A re-overflow falls through.
		const retryOutcome: { stopReason?: PiStopReason; errorMessage?: string } = {};
		const unsubscribe = this.subscribeToAgent(sessionId, session, retryOutcome);
		try {
			await session.piAgent.prompt(promptText);
			await session.piAgent.waitForIdle();
		} finally {
			unsubscribe();
		}
		if (retryOutcome.stopReason === "error") {
			outcome.stopReason = retryOutcome.stopReason;
			outcome.errorMessage = retryOutcome.errorMessage;
			return false;
		}
		await this.events.emitAgentEnd({
			type: "agent_end",
			sessionId,
			stopReason: mapStopReason(retryOutcome.stopReason),
			messages: session.piAgent.state.messages,
		});
		return true;
	}

	/**
	 * Wire the pi-agent-core subscription. Forwards every `Agent` event to its
	 * matching {@link EventDispatcher} emitter, mirrors text deltas + tool-call
	 * updates onto the ACP `sessionUpdate` channel, persists `message_end` to the
	 * session store, and records the final assistant `stopReason`/`errorMessage`
	 * into `outcome` so the caller can map to an ACP `PromptResponse`.
	 */
	private subscribeToAgent(
		sessionId: string,
		session: SessionState,
		outcome: { stopReason?: PiStopReason; errorMessage?: string },
	): () => void {
		const conn = this.conn;
		const events = this.events;
		const appendEntry = this.appendEntry.bind(this);
		return session.piAgent.subscribe(async (event) => {
			switch (event.type) {
				case "turn_start": {
					await events.emitTurnStart({ type: "turn_start", sessionId });
					return;
				}
				case "turn_end": {
					await events.emitTurnEnd({
						type: "turn_end",
						sessionId,
						message: event.message,
						toolResults: event.toolResults,
					});
					return;
				}
				case "message_start": {
					await events.emitMessageStart({ type: "message_start", sessionId, message: event.message });
					return;
				}
				case "message_update": {
					await events.emitMessageUpdate({
						type: "message_update",
						sessionId,
						message: event.message,
						assistantMessageEvent: event.assistantMessageEvent,
					});
					if (event.assistantMessageEvent.type !== "text_delta") return;
					await conn.sessionUpdate({
						sessionId,
						update: {
							sessionUpdate: "agent_message_chunk",
							content: { type: "text", text: event.assistantMessageEvent.delta },
						},
					});
					return;
				}
				case "tool_execution_start": {
					await events.emitToolExecutionStart({
						type: "tool_execution_start",
						sessionId,
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						args: event.args,
					});
					await conn.sessionUpdate({
						sessionId,
						update: {
							sessionUpdate: "tool_call",
							toolCallId: event.toolCallId,
							title: `${event.toolName} ${formatLocationHint(event.args)}`.trim(),
							kind: toolKindFor(event.toolName),
							status: "in_progress",
							rawInput: event.args,
						},
					});
					return;
				}
				case "tool_execution_update": {
					await events.emitToolExecutionUpdate({
						type: "tool_execution_update",
						sessionId,
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						partialResult: event.partialResult,
					});
					const partialContent = Array.isArray(event.partialResult?.content) ? event.partialResult.content : [];
					await conn.sessionUpdate({
						sessionId,
						update: {
							sessionUpdate: "tool_call_update",
							toolCallId: event.toolCallId,
							status: "in_progress",
							content: agentToolContentForAcp(partialContent),
						},
					});
					return;
				}
				case "tool_execution_end": {
					await events.emitToolExecutionEnd({
						type: "tool_execution_end",
						sessionId,
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						result: event.result,
						isError: event.isError,
					});
					const resultContent = Array.isArray(event.result?.content) ? event.result.content : [];
					await conn.sessionUpdate({
						sessionId,
						update: {
							sessionUpdate: "tool_call_update",
							toolCallId: event.toolCallId,
							status: event.isError ? "failed" : "completed",
							content: agentToolContentForAcp(resultContent),
						},
					});
					return;
				}
				case "message_end": {
					await events.emitMessageEnd({ type: "message_end", sessionId, message: event.message });
					const message = event.message;
					if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") return;
					if (message.role === "assistant") {
						outcome.stopReason = message.stopReason;
						outcome.errorMessage = message.errorMessage;
					}
					await appendEntry(sessionId, session, {
						type: "message",
						id: randomUUID(),
						parentId: session.leafId,
						timestamp: Date.now(),
						message,
					});
					return;
				}
			}
		});
	}

	async cancel(params: CancelNotification): Promise<void> {
		const session = this.sessions.get(params.sessionId);
		if (!session) return;
		session.cancelled = true;
		session.piAgent.abort();
	}

	private allModels(): Model<Api>[] {
		const ext = this.extensionRunner?.getProviderModels() ?? [];
		const seen = new Set(this.config.models.map((m) => m.id));
		return [...this.config.models, ...ext.filter((m) => !seen.has(m.id))];
	}

	private findModel(id: string): Model<Api> {
		const m = this.allModels().find((x) => x.id === id);
		if (!m) throw new RequestError(-32602, `unknown model id: ${id}`);
		return m;
	}

	private buildModelConfigOption(currentValue: string): SessionConfigOption {
		return {
			id: MODEL_CONFIG_ID,
			name: "Model",
			category: "model",
			type: "select",
			currentValue,
			options: this.allModels().map((m) => ({
				value: m.id,
				name: m.name,
			})),
		};
	}

	private buildThinkingConfigOption(session: SessionState): SessionConfigOption | undefined {
		const model = session.piAgent.state.model;
		const supported = getSupportedThinkingLevels(model);
		// Models that only support "off" — non-reasoning — don't advertise the option at all.
		if (supported.length <= 1) return undefined;
		return {
			id: THINKING_CONFIG_ID,
			name: "Thinking",
			category: "model",
			type: "select",
			currentValue: session.thinkingLevel,
			options: supported.map((level) => ({ value: level, name: level })),
		};
	}

	private buildAllConfigOptions(sessionId: string): SessionConfigOption[] {
		const session = this.sessions.get(sessionId);
		if (!session) return [];
		const options: SessionConfigOption[] = [this.buildModelConfigOption(session.currentModelId)];
		const thinking = this.buildThinkingConfigOption(session);
		if (thinking) options.push(thinking);
		return options;
	}

	private async rehydrateSession(
		sessionId: string,
		cwd: string,
	): Promise<{ entries: NonNullable<Awaited<ReturnType<SessionStore["load"]>>>["entries"]; currentModelId: string }> {
		const record = await this.config.sessionStore.load(sessionId);
		if (!record) throw new RequestError(-32602, `unknown session: ${sessionId}`);

		const ctx = buildSessionContext(record);
		const modelId = ctx.currentModelId ?? this.config.defaultModelId;
		const restoredModel = this.findModel(modelId);

		const leafId =
			record.leafId !== undefined
				? record.leafId
				: record.entries.length > 0
					? record.entries[record.entries.length - 1].id
					: null;
		await this._buildSessionState(sessionId, restoredModel, cwd, ctx.messages, leafId, ctx.currentThinkingLevel);
		return { entries: record.entries, currentModelId: modelId };
	}

	// Skills must load before Agent construction so the composed systemPrompt
	// (base + <available_skills>) is in the initial state.
	private async _buildSessionState(
		sessionId: string,
		model: Model<Api>,
		cwd: string,
		messages: AgentMessage[] = [],
		leafId: string | null = null,
		initialThinkingLevel: ModelThinkingLevel | null = null,
	): Promise<void> {
		const builtinTools = createBuiltinTools({
			filesystem: this.config.filesystem,
			cwd,
			...(this.config.scriptExecutor ? { scriptExecutor: this.config.scriptExecutor } : {}),
		});
		const projectCommands = await loadProjectCommands(this.config.filesystem, cwd);
		const skills = await loadProjectSkills(this.config.filesystem, cwd);
		const contextFiles = await loadProjectContextFiles(this.config.filesystem, cwd);
		const projectSettingsResult = await loadProjectSettings(this.config.filesystem, cwd);
		const globalSettingsResult = this.config.homeDir
			? await loadGlobalSettings(this.config.globalFilesystem ?? this.config.filesystem, this.config.homeDir)
			: undefined;
		const mergedFileSettings = mergeSettings(globalSettingsResult?.settings ?? {}, projectSettingsResult.settings);
		// Merge extension tools/commands. Builtins + project commands win on collision.
		const tools = this.extensionRunner ? mergeTools(builtinTools, this.extensionRunner.getTools()) : builtinTools;
		const commands = this.extensionRunner
			? mergeCommands(projectCommands, this.extensionRunner.getCommands())
			: projectCommands;
		// Append precedence: BodhiPiConfig.appendSystemPrompt (host-explicit) > merged file settings.
		const resolvedAppend = this.config.appendSystemPrompt ?? mergedFileSettings.appendSystemPrompt ?? undefined;
		const composedSystemPrompt = buildSystemPrompt({
			...(this.config.systemPrompt !== undefined ? { customPrompt: this.config.systemPrompt } : {}),
			selectedTools: tools.map((t) => t.name),
			toolSnippets: BUILTIN_TOOL_SNIPPETS,
			...(resolvedAppend !== undefined ? { appendSystemPrompt: resolvedAppend } : {}),
			cwd,
			contextFiles,
			skills,
		});
		const effectiveCompaction: CompactionSettings = {
			...DEFAULT_COMPACTION_SETTINGS,
			...(mergedFileSettings.compaction ?? {}),
			...(this.config.compaction ?? {}),
		};
		const requestedThinking: ModelThinkingLevel =
			initialThinkingLevel ?? this.config.defaultThinkingLevel ?? mergedFileSettings.defaultThinkingLevel ?? "off";
		const resolvedThinkingLevel = clampThinkingLevel(model, requestedThinking);
		const retryOptions = resolveProviderStreamOptions(model.provider, mergedFileSettings);
		const events = this.events;
		const resolveApiKey = (provider: string) => this.resolveProviderApiKey(provider);
		const piAgent = new Agent({
			...retryOptions,
			initialState: {
				model,
				...(messages.length > 0 ? { messages } : {}),
				tools,
				...(composedSystemPrompt !== undefined ? { systemPrompt: composedSystemPrompt } : {}),
				thinkingLevel: resolvedThinkingLevel as never,
			},
			getApiKey: resolveApiKey,
			beforeToolCall: async (ctx: BeforeToolCallContext): Promise<BeforeToolCallResult | undefined> => {
				const result = await events.emitToolCall({
					type: "tool_call",
					sessionId,
					toolCallId: ctx.toolCall.id,
					toolName: ctx.toolCall.name,
					input: ctx.args as Record<string, unknown>,
				});
				return result.block
					? { block: true, ...(result.reason !== undefined ? { reason: result.reason } : {}) }
					: undefined;
			},
			afterToolCall: async (ctx: AfterToolCallContext): Promise<AfterToolCallResult | undefined> => {
				const overrides = await events.emitToolResult({
					type: "tool_result",
					sessionId,
					toolCallId: ctx.toolCall.id,
					toolName: ctx.toolCall.name,
					result: ctx.result,
					isError: ctx.isError,
				});
				return Object.keys(overrides).length === 0 ? undefined : overrides;
			},
			onPayload: async (payload, m) => {
				return await events.emitBeforeProviderRequest({
					type: "before_provider_request",
					sessionId,
					provider: m.provider,
					modelId: m.id,
					payload,
				});
			},
			onResponse: async (response: ProviderResponse, m) => {
				await events.emitAfterProviderResponse({
					type: "after_provider_response",
					sessionId,
					provider: m.provider,
					modelId: m.id,
					status: response.status,
					headers: response.headers,
				});
			},
			prepareNextTurn: async (): Promise<AgentLoopTurnUpdate | undefined> => {
				const compactUpdate = await this.maybeProactiveCompact(sessionId);
				const state = this.sessions.get(sessionId);
				if (!state?.pendingThinkingLevelChange) return compactUpdate;
				state.pendingThinkingLevelChange = false;
				return { ...(compactUpdate ?? {}), thinkingLevel: state.thinkingLevel as never };
			},
		});
		this.sessions.set(sessionId, {
			piAgent,
			currentModelId: model.id,
			thinkingLevel: resolvedThinkingLevel,
			pendingThinkingLevelChange: false,
			cwd,
			tools,
			commands,
			skills,
			cancelled: false,
			leafId,
			overflowRecoveryAttempted: false,
			compaction: effectiveCompaction,
			appendSystemPrompt: resolvedAppend ?? null,
			contextFiles,
			projectSettings: projectSettingsResult.settings,
			projectSettingsPresent: projectSettingsResult.present,
			globalSettings: globalSettingsResult ? globalSettingsResult.settings : null,
			globalSettingsPresent: globalSettingsResult?.present ?? false,
			...(globalSettingsResult?.parseError !== undefined
				? { globalSettingsParseError: globalSettingsResult.parseError }
				: {}),
			...(projectSettingsResult.parseError !== undefined
				? { projectSettingsParseError: projectSettingsResult.parseError }
				: {}),
			sessionOverrides: {},
			retryOptions,
		});
	}

	private async advertiseSlashable(sessionId: string): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) return;
		const availableCommands: AvailableCommand[] = [
			...session.commands.map(toAvailableCommand),
			...session.skills.map(skillToAvailableCommand),
		];
		await this.conn.sessionUpdate({
			sessionId,
			update: {
				sessionUpdate: "available_commands_update",
				availableCommands,
			},
		});
	}
}
