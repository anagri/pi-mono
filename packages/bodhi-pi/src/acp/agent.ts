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
	getModels,
	getProviders,
	getSupportedThinkingLevels,
	isContextOverflow,
	type KnownProvider,
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
	setAt,
	unsetAt,
	unsetGlobalSetting,
	unsetProjectSetting,
	writeGlobalSetting,
	writeProjectSetting,
} from "@/core/settings-writer.js";
import { buildSystemPrompt } from "@/core/system-prompt.js";
import { EventDispatcher } from "@/events/dispatcher.js";
import type { BodhiPiEventHandlers, StopReason } from "@/events/types.js";
import { mergeCommands, mergeTools } from "@/extensions/merge.js";
import { ExtensionRunner } from "@/extensions/runner.js";
import type { RegisteredExtension } from "@/extensions/types.js";
import type { Filesystem } from "@/filesystem/filesystem.js";
import { AUTH_PREFIX, type KvStore, type KvStoreEntry } from "@/kv/kv-store.js";
import type { ScriptExecutor } from "@/script-executor/script-executor.js";
import { detectCrossBranch, runBranchSummary } from "@/sessions/branch-summary.js";
import { buildSessionContext, walkPath } from "@/sessions/build-context.js";
import {
	type CompactionResult,
	type CompactionSettings,
	calculateContextTokens,
	DEFAULT_COMPACTION_SETTINGS,
	getLastAssistantUsage,
	prepareCompaction,
	runCompaction,
} from "@/sessions/compaction.js";
import type { CompactionEntry, SessionEntry } from "@/sessions/entries.js";
import type { SessionRecord, SessionStore } from "@/sessions/session-store.js";
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
	/** Additive host-supplied models for providers not in pi-ai's built-in catalog (e.g. local Ollama). */
	models?: Model<Api>[];
	/** Optional override. When unset or unavailable, the agent picks the first auth-available model. */
	defaultModelId?: string;
	getApiKey?: (provider: string) => string | undefined;
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

/**
 * Three-layer settings snapshot read at session bootstrap. Mutated only by `handleSettings*`
 * (session-scope) and re-loaded into `projectSettings` / `globalSettings` after the corresponding
 * file write. `sessionOverrides` is in-memory only.
 */
interface SettingsState {
	/** Global settings layer snapshot (Node hosts only); `null` when `BodhiPiConfig.homeDir` was omitted. */
	globalSettings: BodhiPiProjectSettings | null;
	projectSettings: BodhiPiProjectSettings;
	sessionOverrides: BodhiPiProjectSettings;
	projectSettingsPresent: boolean;
	globalSettingsPresent: boolean;
	projectSettingsParseError?: string;
	globalSettingsParseError?: string;
}

/**
 * Live runtime state owned by a single `prompt()` lifecycle. `currentModelId` is `null` until
 * the first auth-resolvable model is selected; `prompt()` rejects in that state.
 */
interface SessionRuntime {
	piAgent: PiAgent;
	/** `null` when no auth-resolvable model exists at boot; `prompt()` rejects with a branched error message. */
	currentModelId: string | null;
	thinkingLevel: ModelThinkingLevel;
	pendingThinkingLevelChange: boolean;
	/** Set by `cancel()`; read by `prompt()` to return `stopReason: "cancelled"`. Reset before each prompt. */
	cancelled: boolean;
	/** Current head of the session DAG; `null` for a fresh session. Bumped on every entry append. */
	leafId: string | null;
	/** True after one auto-compact retry; reset at the start of each prompt() to allow per-turn recovery. */
	overflowRecoveryAttempted: boolean;
}

interface SessionState {
	cwd: string;
	tools: AgentTool[];
	/** Discovered once at session hydration; refresh requires `session/close` + `session/load`. */
	commands: PromptTemplate[];
	skills: Skill[];
	appendSystemPrompt: string | null;
	contextFiles: ContextFile[];
	/** Resolved per-session bits surfaced via `_bodhi-pi/session/config`. */
	compaction: CompactionSettings;
	retryOptions: ResolvedRetryOptions;
	settings: SettingsState;
	runtime: SessionRuntime;
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
	return (conn: AgentSideConnection): AcpAgent => new BodhiPiAcpAgent(config, conn);
}

/**
 * Throw conventions:
 *   - ACP protocol violations → `RequestError(-32602/-32601, ...)`
 *   - tool execution errors → plain `Error` (pi-agent-core surfaces these as
 *     `tool_execution_end.isError` → ACP `tool_call_update.status: "failed"`)
 */
type ExtHandler = (params: Record<string, unknown>) => Promise<Record<string, unknown>>;

class BodhiPiAcpAgent implements AcpAgent {
	private sessions = new Map<string, SessionState>();
	private readonly events: EventDispatcher;
	private extensionRunner?: ExtensionRunner;
	private extensionRunnerReady?: Promise<void>;
	/** Single source of truth for `_bodhi-pi/*` ext-method dispatch — one entry per implemented method. */
	private readonly extHandlers: Map<string, ExtHandler>;

	constructor(
		private readonly config: BodhiPiConfig,
		private readonly conn: AgentSideConnection,
	) {
		// EventDispatcher is constructed once with both host-supplied handlers
		// AND extension-registered handlers merged. Extension handlers are added
		// asynchronously via `ensureExtensionRunner()` on first session use.
		this.events = new EventDispatcher(config.eventHandlers);

		// Internal subscribers: route state-change events into spec-stable ACP
		// `config_option_update` notifications. Demonstrates the same hook surface
		// available to extensions — bodhi-pi's picker-refresh side-effect ships
		// through the same bus.
		this.events.appendHandlers("auth_change", [
			async (e) => {
				if (e.sessionId !== undefined) await this.emitConfigOptionUpdate(e.sessionId);
			},
		]);
		this.events.appendHandlers("settings_change", [
			async (e) => {
				if (this.affectsPickerKey(e.key)) await this.emitConfigOptionUpdate(e.sessionId);
			},
		]);
		this.events.appendHandlers("model_select", [
			async (e) => {
				await this.emitConfigOptionUpdate(e.sessionId);
			},
		]);

		this.extHandlers = new Map<string, ExtHandler>([
			[EXT_DELETE_SESSION, this.handleSessionDelete.bind(this)],
			[EXT_SESSION_COMPACT, this.handleSessionCompact.bind(this)],
			[EXT_SESSION_FORK, this.handleSessionFork.bind(this)],
			[EXT_SESSION_CLONE, this.handleSessionClone.bind(this)],
			[EXT_SESSION_ENTRIES, this.handleSessionEntries.bind(this)],
			[EXT_SESSION_TREE, this.handleSessionTree.bind(this)],
			[EXT_SESSION_NAVIGATE, this.handleSessionNavigate.bind(this)],
			[EXT_SESSION_SET_NAME, this.handleSessionSetName.bind(this)],
			[EXT_SESSION_STATS, this.handleSessionStats.bind(this)],
			[EXT_SESSION_EXPORT, this.handleSessionExport.bind(this)],
			[EXT_SESSION_CONFIG, this.handleSessionConfig.bind(this)],
			[EXT_SESSION_SETTINGS_GET, this.handleSettingsGet.bind(this)],
			[EXT_SESSION_SETTINGS_SET, this.handleSettingsSet.bind(this)],
			[EXT_SESSION_SETTINGS_UNSET, this.handleSettingsUnset.bind(this)],
			[EXT_SESSION_SETTINGS_LIST, this.handleSettingsList.bind(this)],
			[EXT_KV_SET, this.handleKvSet.bind(this)],
			[EXT_KV_GET, this.handleKvGet.bind(this)],
			[EXT_KV_LIST, this.handleKvList.bind(this)],
			[EXT_KV_REMOVE, this.handleKvRemove.bind(this)],
		]);
	}

	/** True for the dotted-key paths whose changes reshape the model picker advertised in `configOptions`. */
	private affectsPickerKey(key: string): boolean {
		return (
			key === "defaultModel" ||
			key.startsWith("defaultModel.") ||
			key === "defaultThinkingLevel" ||
			key.startsWith("defaultThinkingLevel.")
		);
	}

	/**
	 * Emit the spec-stable `config_option_update` sessionUpdate so connected
	 * clients refresh their picker without polling. No-op for sessions that
	 * are no longer loaded (e.g., picker change targeted a closed session).
	 */
	private async emitConfigOptionUpdate(sessionId: string): Promise<void> {
		if (!this.sessions.has(sessionId)) return;
		const configOptions = await this.buildAllConfigOptions(sessionId);
		await this.conn.sessionUpdate({
			sessionId,
			update: { sessionUpdate: "config_option_update", configOptions },
		});
	}

	/** Emit the spec-stable `session_info_update` sessionUpdate after a name change. */
	private async emitSessionInfoUpdate(
		sessionId: string,
		title: string | null,
		updatedAt: string | null,
	): Promise<void> {
		await this.conn.sessionUpdate({
			sessionId,
			update: { sessionUpdate: "session_info_update", title, updatedAt },
		});
	}

	/**
	 * Persist `entry` with `parentId` set to the session's current leaf, then
	 * advance the leaf to `entry.id`. The store and runtime state stay in sync.
	 */
	private async appendEntry(sessionId: string, session: SessionState, entry: SessionEntry): Promise<void> {
		entry.parentId = session.runtime.leafId;
		await this.config.sessionStore.append(sessionId, entry);
		session.runtime.leafId = entry.id;
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
					"bodhi-pi": { version: BODHI_PI_VERSION },
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
		await this._buildSessionState(record.id, null, record.cwd);
		await this.advertiseSlashable(record.id);
		await this.events.emit({
			type: "session_start",
			sessionId: record.id,
			cwd: record.cwd,
			reason: "new",
		});
		return {
			sessionId: record.id,
			configOptions: await this.buildAllConfigOptions(record.id),
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
		await this.events.emit({
			type: "session_start",
			sessionId: params.sessionId,
			cwd: params.cwd,
			reason: "load",
		});
		return {
			configOptions: await this.buildAllConfigOptions(params.sessionId),
		};
	}

	async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
		await this.ensureExtensionRunner();
		// Per ACP spec: rehydrate without replaying history.
		await this.rehydrateSession(params.sessionId, params.cwd);
		await this.advertiseSlashable(params.sessionId);
		await this.events.emit({
			type: "session_start",
			sessionId: params.sessionId,
			cwd: params.cwd,
			reason: "resume",
		});
		return {
			configOptions: await this.buildAllConfigOptions(params.sessionId),
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
		cached?.runtime.piAgent.abort();
		this.sessions.delete(params.sessionId);
		await this.events.emit({ type: "session_shutdown", sessionId: params.sessionId });
		return {};
	}

	async extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const handler = this.extHandlers.get(method);
		if (!handler) throw new RequestError(-32601, `Method not found: ${method}`);
		return await handler(params);
	}

	private async handleSessionDelete(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const sessionId = this.validateSessionId(EXT_DELETE_SESSION, params);
		this.sessions.get(sessionId)?.runtime.piAgent.abort();
		this.sessions.delete(sessionId);
		await this.config.sessionStore.delete(sessionId);
		await this.events.emit({ type: "session_shutdown", sessionId });
		return {};
	}

	private validateSessionId(method: string, params: Record<string, unknown>): string {
		const sessionId = params.sessionId;
		if (typeof sessionId !== "string") {
			throw new RequestError(-32602, `${method}: sessionId must be a string`);
		}
		return sessionId;
	}

	/** For handlers that don't require a sessionId; off-session ext calls (e.g. KV auth writes) pass it through opportunistically. */
	private optionalSessionId(params: Record<string, unknown>): string | undefined {
		const sessionId = params.sessionId;
		return typeof sessionId === "string" ? sessionId : undefined;
	}

	private requireSession(method: string, params: Record<string, unknown>): SessionState {
		const sessionId = this.validateSessionId(method, params);
		const session = this.sessions.get(sessionId);
		if (!session) {
			throw new RequestError(-32602, `session ${sessionId} is not loaded. Call session/load first.`);
		}
		return session;
	}

	/** For handlers that load fresh from the store rather than the live runtime map. */
	private async requireSessionRecord(
		method: string,
		params: Record<string, unknown>,
	): Promise<{ sessionId: string; record: NonNullable<Awaited<ReturnType<SessionStore["load"]>>> }> {
		const sessionId = this.validateSessionId(method, params);
		const record = await this.config.sessionStore.load(sessionId);
		if (!record) throw new RequestError(-32602, `unknown session: ${sessionId}`);
		return { sessionId, record };
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
			mergeSettings(session.settings.globalSettings ?? {}, session.settings.projectSettings),
			session.settings.sessionOverrides,
		);
	}

	private sourceForKey(session: SessionState, dotted: string): SettingsScope | "default" {
		const path = parseDottedKey(dotted);
		if (path.length === 0) return "default";
		if (getAt(session.settings.sessionOverrides as Record<string, unknown>, path) !== undefined) return "session";
		if (getAt(session.settings.projectSettings as Record<string, unknown>, path) !== undefined) return "project";
		if (getAt((session.settings.globalSettings ?? {}) as Record<string, unknown>, path) !== undefined)
			return "global";
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
			source = (session.settings.globalSettings ?? {}) as Record<string, unknown>;
		} else if (scope === "project") {
			source = session.settings.projectSettings as Record<string, unknown>;
		} else {
			source = session.settings.sessionOverrides as Record<string, unknown>;
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
			session.settings.globalSettings = updated;
		} else if (scope === "project") {
			const updated = await writeProjectSetting(this.config.filesystem, session.cwd, key, value);
			session.settings.projectSettings = updated;
			session.settings.projectSettingsPresent = true;
		} else {
			// Session scope: mutate in-memory overrides only.
			session.settings.sessionOverrides = setAt(
				session.settings.sessionOverrides as Record<string, unknown>,
				path,
				value,
			) as BodhiPiProjectSettings;
		}

		await this.events.emit({
			type: "settings_change",
			sessionId: params.sessionId as string,
			scope,
			key,
			value,
			reason: "set",
		});

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
			session.settings.globalSettings = updated;
		} else if (scope === "project") {
			const updated = await unsetProjectSetting(this.config.filesystem, session.cwd, key);
			session.settings.projectSettings = updated;
		} else {
			// Session scope: delete from in-memory overrides.
			session.settings.sessionOverrides = unsetAt(
				session.settings.sessionOverrides as Record<string, unknown>,
				path,
			) as BodhiPiProjectSettings;
		}

		await this.events.emit({
			type: "settings_change",
			sessionId: params.sessionId as string,
			scope,
			key,
			value: null,
			reason: "unset",
		});

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
				? (session.settings.globalSettings ?? {})
				: scope === "project"
					? session.settings.projectSettings
					: scope === "session"
						? session.settings.sessionOverrides
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
		if (key.startsWith(AUTH_PREFIX)) {
			await this.events.emit({
				type: "auth_change",
				sessionId: this.optionalSessionId(params),
				provider: key.slice(AUTH_PREFIX.length),
				action: "login",
			});
		}
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
		if (key.startsWith(AUTH_PREFIX)) {
			await this.events.emit({
				type: "auth_change",
				sessionId: this.optionalSessionId(params),
				provider: key.slice(AUTH_PREFIX.length),
				action: "logout",
			});
		}
		return { key };
	}

	private async handleSessionConfig(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const sessionId = this.validateSessionId(EXT_SESSION_CONFIG, params);
		const session = this.requireSession(EXT_SESSION_CONFIG, params);
		const effective = this.effectiveSettings(session);
		return {
			sessionId,
			cwd: session.cwd,
			defaultModelId: this.config.defaultModelId ?? null,
			currentModelId: session.runtime.currentModelId,
			thinkingLevel: session.runtime.thinkingLevel,
			retryOptions: { ...session.retryOptions },
			compaction: { ...session.compaction },
			appendSystemPrompt: session.appendSystemPrompt,
			contextFilePaths: session.contextFiles.map((f) => f.path),
			projectSettingsPresent: session.settings.projectSettingsPresent,
			projectSettings: session.settings.projectSettings as Record<string, unknown>,
			globalSettingsPresent: session.settings.globalSettingsPresent,
			globalSettings: (session.settings.globalSettings ?? null) as Record<string, unknown> | null,
			sessionOverrides: session.settings.sessionOverrides as Record<string, unknown>,
			layers: {
				global: (session.settings.globalSettings ?? null) as Record<string, unknown> | null,
				project: session.settings.projectSettings as Record<string, unknown>,
				sessionOverrides: session.settings.sessionOverrides as Record<string, unknown>,
				effective: effective as Record<string, unknown>,
			},
			...(session.settings.globalSettingsParseError !== undefined
				? { globalSettingsParseError: session.settings.globalSettingsParseError }
				: {}),
			...(session.settings.projectSettingsParseError !== undefined
				? { projectSettingsParseError: session.settings.projectSettingsParseError }
				: {}),
		};
	}

	private async handleSessionSetName(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const sessionId = this.validateSessionId(EXT_SESSION_SET_NAME, params);
		const name = params.name;
		if (typeof name !== "string") {
			throw new RequestError(-32602, `${EXT_SESSION_SET_NAME}: name must be a string`);
		}
		const session = this.sessions.get(sessionId);
		if (!session) {
			throw new RequestError(-32602, `session ${sessionId} is not loaded. Call session/load first.`);
		}
		const timestamp = Date.now();
		await this.appendEntry(sessionId, session, {
			type: "session_info",
			id: randomUUID(),
			parentId: session.runtime.leafId,
			timestamp,
			name,
		});
		await this.emitSessionInfoUpdate(sessionId, name, new Date(timestamp).toISOString());
		return { ok: true, name };
	}

	private async handleSessionStats(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const { record } = await this.requireSessionRecord(EXT_SESSION_STATS, params);
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
		const { record } = await this.requireSessionRecord(EXT_SESSION_EXPORT, params);
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
		const { record } = await this.requireSessionRecord(EXT_SESSION_TREE, params);
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
		const { sessionId, record } = await this.requireSessionRecord(EXT_SESSION_NAVIGATE, params);
		const targetEntryId = params.targetEntryId;
		if (typeof targetEntryId !== "string") {
			throw new RequestError(-32602, `${EXT_SESSION_NAVIGATE}: targetEntryId must be a string`);
		}
		const target = record.entries.find((e) => e.id === targetEntryId);
		if (!target) throw new RequestError(-32602, `unknown entry: ${targetEntryId}`);

		const session = this.sessions.get(sessionId);
		const oldLeaf = session?.runtime.leafId ?? record.leafId ?? null;

		// If navigation crosses branches, summarize the abandoned tail and append
		// a branch_summary entry on the new branch BEFORE moving the leaf.
		const cross = detectCrossBranch(record.entries, oldLeaf, targetEntryId);
		if (cross && session && oldLeaf) {
			try {
				const apiKey = await this.resolveApiKeyForCompaction(session.runtime.piAgent.state.model.provider);
				if (apiKey) {
					const result = await runBranchSummary(cross.abandonedTail, session.runtime.piAgent.state.model, apiKey);
					if (result.summary) {
						session.runtime.leafId = targetEntryId;
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
							const ctx = buildSessionContext(refreshed, session.runtime.leafId);
							session.runtime.piAgent.state.messages = ctx.messages;
						}
						await this.events.emit({
							type: "branch_summary_created",
							sessionId,
							abandonedTailLeafId: oldLeaf,
							commonAncestorId: cross.commonAncestorId,
							summary: result.summary,
						});
						await this.events.emit({
							type: "session_navigate",
							sessionId,
							fromLeafId: oldLeaf,
							toLeafId: targetEntryId,
							crossedBranches: true,
						});
						return { leafId: session.runtime.leafId };
					}
				}
			} catch {
				// Non-fatal: fall through to plain navigate
			}
		}

		await this.config.sessionStore.setLeafId?.(sessionId, targetEntryId);

		if (session) {
			session.runtime.leafId = targetEntryId;
			const refreshed = await this.config.sessionStore.load(sessionId);
			if (refreshed) {
				const ctx = buildSessionContext(refreshed, targetEntryId);
				session.runtime.piAgent.state.messages = ctx.messages;
			}
		}
		await this.events.emit({
			type: "session_navigate",
			sessionId,
			fromLeafId: oldLeaf,
			toLeafId: targetEntryId,
			crossedBranches: !!cross,
		});
		return { leafId: targetEntryId };
	}

	private async handleSessionEntries(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const { record } = await this.requireSessionRecord(EXT_SESSION_ENTRIES, params);
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
		const { sessionId, record } = await this.requireSessionRecord(EXT_SESSION_FORK, params);
		const entryId = params.entryId;
		const position = params.position === "at" ? "at" : "before";
		if (typeof entryId !== "string") {
			throw new RequestError(-32602, `${EXT_SESSION_FORK}: entryId must be a string`);
		}
		const target = record.entries.find((e) => e.id === entryId);
		if (!target) throw new RequestError(-32602, `unknown entry: ${entryId}`);
		if (!this.config.sessionStore.forkRecord) {
			throw new RequestError(-32603, "session store does not support forking");
		}
		const { newSessionId } = await this.config.sessionStore.forkRecord(sessionId, entryId, position);
		await this.events.emit({
			type: "session_fork",
			sessionId,
			newSessionId,
			fromEntryId: entryId,
			position,
		});
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
		const { sessionId, record } = await this.requireSessionRecord(EXT_SESSION_CLONE, params);
		const leafId = record.leafId ?? record.entries[record.entries.length - 1]?.id;
		if (!leafId) throw new RequestError(-32603, "cannot clone an empty session");
		if (!this.config.sessionStore.forkRecord) {
			throw new RequestError(-32603, "session store does not support cloning");
		}
		const { newSessionId } = await this.config.sessionStore.forkRecord(sessionId, leafId, "at");
		await this.events.emit({
			type: "session_clone",
			sessionId,
			newSessionId,
			fromLeafId: leafId,
		});
		return { newSessionId };
	}

	/** Build the persisted entry from a successful summarization result. Single source of truth for the literal across manual/proactive/recovery paths. */
	private makeCompactionEntry(parentId: string | null | undefined, result: CompactionResult): CompactionEntry {
		return {
			type: "compaction",
			id: randomUUID(),
			parentId,
			timestamp: Date.now(),
			summary: result.summary,
			firstKeptEntryId: result.firstKeptEntryId,
			tokensBefore: result.tokensBefore,
			...(result.details ? { details: result.details } : {}),
		};
	}

	/**
	 * Run a compaction end-to-end (prepare → emit start → summarize → persist entry → rebuild live messages → emit end).
	 *
	 * Single source of truth for the three sites (manual `/compact`, proactive auto-compact after `agent_end`, and
	 * overflow recovery). Returns a discriminated union so callers can distinguish "nothing to do" / "skipped"
	 * (e.g. no API key, no preparation) from "succeeded" / "failed". Manual callers re-throw on `failed`; the two
	 * background callers swallow errors and continue.
	 */
	private async runAndPersistCompaction(
		sessionId: string,
		session: SessionState,
		reason: "manual" | "proactive" | "recovery",
		options: { record?: SessionRecord; customInstructions?: string } = {},
	): Promise<
		| { kind: "skipped"; reason: "no_record" | "nothing_to_compact" | "no_api_key" }
		| { kind: "succeeded"; result: CompactionResult; messages: AgentMessage[] }
		| { kind: "failed"; error: Error }
	> {
		const record = options.record ?? (await this.config.sessionStore.load(sessionId));
		if (!record) return { kind: "skipped", reason: "no_record" };
		const path = walkPath(record.entries, session.runtime.leafId);
		const preparation = prepareCompaction(path, session.compaction);
		if (!preparation) return { kind: "skipped", reason: "nothing_to_compact" };
		const model = session.runtime.piAgent.state.model;
		const apiKey = await this.resolveApiKeyForCompaction(model.provider);
		if (!apiKey) return { kind: "skipped", reason: "no_api_key" };

		await this.events.emit({ type: "compaction_start", sessionId, reason });
		let result: CompactionResult;
		try {
			result = await runCompaction(preparation, model, apiKey, options.customInstructions);
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err));
			await this.events.emit({
				type: "compaction_end",
				sessionId,
				reason,
				errorMessage: error.message,
			});
			return { kind: "failed", error };
		}

		await this.appendEntry(sessionId, session, this.makeCompactionEntry(session.runtime.leafId, result));
		const refreshed = await this.config.sessionStore.load(sessionId);
		const messages = refreshed
			? buildSessionContext(refreshed, session.runtime.leafId).messages
			: session.runtime.piAgent.state.messages;
		session.runtime.piAgent.state.messages = messages;

		await this.events.emit({
			type: "compaction_end",
			sessionId,
			reason,
			summary: result.summary,
			firstKeptEntryId: result.firstKeptEntryId,
			tokensBefore: result.tokensBefore,
		});
		return { kind: "succeeded", result, messages };
	}

	private async handleSessionCompact(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const session = this.requireSession(EXT_SESSION_COMPACT, params);
		const { sessionId, record } = await this.requireSessionRecord(EXT_SESSION_COMPACT, params);
		const customInstructions = typeof params.customInstructions === "string" ? params.customInstructions : undefined;

		// Map skip reasons to /compact-spec error codes; an absent record path
		// is impossible here (requireSessionRecord already loaded), but we keep
		// the case for exhaustiveness.
		const outcome = await this.runAndPersistCompaction(sessionId, session, "manual", {
			record,
			...(customInstructions !== undefined ? { customInstructions } : {}),
		});
		if (outcome.kind === "skipped") {
			if (outcome.reason === "nothing_to_compact") {
				throw new RequestError(-32603, "nothing to compact (session is empty or already compacted at the leaf)");
			}
			if (outcome.reason === "no_api_key") {
				const provider = session.runtime.piAgent.state.model.provider;
				throw new RequestError(-32603, `no API key available for provider "${provider}"`);
			}
			throw new RequestError(-32603, `compact skipped: ${outcome.reason}`);
		}
		if (outcome.kind === "failed") throw outcome.error;

		const { result } = outcome;
		return {
			summary: result.summary,
			firstKeptEntryId: result.firstKeptEntryId,
			tokensBefore: result.tokensBefore,
			...(result.details ? { details: result.details } : {}),
		};
	}

	private async resolveProviderApiKey(provider: string): Promise<string | undefined> {
		// Order: kvStore (set by /login) > BodhiPiConfig.getApiKey > extension fallback.
		const kvKey = await this.config.kvStore?.get(AUTH_PREFIX + provider);
		if (kvKey !== undefined) return kvKey;
		const hostKey = this.config.getApiKey?.(provider);
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
		return { configOptions: await this.buildAllConfigOptions(params.sessionId) };
	}

	private async setSessionModel(sessionId: string, session: SessionState, value: unknown): Promise<void> {
		if (typeof value !== "string") {
			throw new RequestError(-32602, `model config requires string value, got ${typeof value}`);
		}
		const newModel = await this.findModel(value);
		const previousModelId = session.runtime.currentModelId;
		// pi-ai's streamSimple reads state.model per turn, so mutating here routes the next prompt to the new model.
		session.runtime.piAgent.state.model = newModel;
		session.runtime.currentModelId = value;
		const clamped = clampThinkingLevel(newModel, session.runtime.thinkingLevel);
		if (clamped !== session.runtime.thinkingLevel) {
			session.runtime.thinkingLevel = clamped;
			session.runtime.piAgent.state.thinkingLevel = clamped as never;
			session.runtime.pendingThinkingLevelChange = true;
		}
		await this.appendEntry(sessionId, session, {
			type: "model_change",
			id: randomUUID(),
			parentId: session.runtime.leafId,
			timestamp: Date.now(),
			provider: newModel.provider,
			modelId: newModel.id,
		});
		await this.events.emit({
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
		const supported = getSupportedThinkingLevels(session.runtime.piAgent.state.model);
		if (!supported.includes(value as ModelThinkingLevel)) {
			throw new RequestError(
				-32602,
				`unsupported thinking level "${value}" for model ${session.runtime.piAgent.state.model.id}; supported: ${supported.join(", ")}`,
			);
		}
		const level = value as ModelThinkingLevel;
		if (level === session.runtime.thinkingLevel) return;
		session.runtime.thinkingLevel = level;
		// Mutate pi-agent state so subsequent prompt() invocations see the new level
		// (prepareNextTurn only handles mid-loop swaps within a single agentLoop call).
		session.runtime.piAgent.state.thinkingLevel = level as never;
		session.runtime.pendingThinkingLevelChange = true;
		await this.appendEntry(sessionId, session, {
			type: "thinking_change",
			id: randomUUID(),
			parentId: session.runtime.leafId,
			timestamp: Date.now(),
			level,
		});
	}

	async prompt(params: PromptRequest): Promise<PromptResponse> {
		const session = this.sessions.get(params.sessionId);
		if (!session) {
			throw new RequestError(-32602, `session ${params.sessionId} is not loaded. Call session/load first.`);
		}

		if (session.runtime.currentModelId === null) {
			const models = await this.allModels();
			throw new RequestError(
				-32603,
				models.length > 0
					? `no model selected; choose one of: ${models.map((m) => m.id).join(", ")} via setSessionConfigOption(${MODEL_CONFIG_ID}) or /model <id>`
					: `no models available; configure provider auth via /login <provider> <api-key> or _bodhi-pi/kv/set auth/<provider>`,
			);
		}

		const text = params.prompt
			.filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
			.map((b) => b.text)
			.join("");
		// Skills first because they use the more specific `/skill:` prefix; if no
		// skill matches, the text falls through to slash-command expansion.
		const expandedText = expandPromptTemplate(expandSkillCommand(text, session.skills), session.commands);

		// Reset so a prior cancel doesn't bleed into this prompt.
		session.runtime.cancelled = false;
		// Each user prompt gets one shot at overflow auto-compact recovery.
		session.runtime.overflowRecoveryAttempted = false;

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
			systemPrompt: session.runtime.piAgent.state.systemPrompt,
			userPrompt: inputResult.text,
		});
		if (before.systemPrompt !== session.runtime.piAgent.state.systemPrompt) {
			session.runtime.piAgent.state.systemPrompt = before.systemPrompt;
		}
		const promptText = before.userPrompt;

		await events.emit({ type: "agent_start", sessionId, userPrompt: promptText });

		const outcome: { stopReason?: PiStopReason; errorMessage?: string } = {};
		const unsubscribe = this.subscribeToAgent(sessionId, session, outcome);

		// Single `agent_end` emitter — every exit path from prompt/recovery flows through here so
		// the event always pairs with the matching `agent_start` and forwards optional `stopReason` /
		// `errorMessage` consistently. `tryOverflowRecovery` reuses this helper for the retry case.
		const finishTurn = async (
			stopReason: StopReason | undefined,
			errorMessage: string | undefined,
		): Promise<void> => {
			await events.emit({
				type: "agent_end",
				sessionId,
				...(stopReason !== undefined ? { stopReason } : {}),
				messages: session.runtime.piAgent.state.messages,
				...(errorMessage !== undefined ? { errorMessage } : {}),
			});
		};

		try {
			await session.runtime.piAgent.prompt(promptText);
			await session.runtime.piAgent.waitForIdle();
			if (session.runtime.cancelled) {
				await finishTurn("cancelled", outcome.errorMessage);
				return { stopReason: "cancelled", userMessageId: params.messageId ?? null };
			}
			if (outcome.stopReason === "error") {
				const recovered = await this.tryOverflowRecovery(sessionId, session, promptText, outcome, finishTurn);
				if (recovered) {
					return { stopReason: "end_turn", userMessageId: params.messageId ?? null };
				}
				const errorMessage = outcome.errorMessage ?? "model error";
				await finishTurn(undefined, errorMessage);
				throw new RequestError(-32603, errorMessage);
			}
			const stopReason = mapStopReason(outcome.stopReason);
			await finishTurn(stopReason, undefined);
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
		if (!session || session.runtime.cancelled) return undefined;
		const ctx = await this.runProactiveCompaction(sessionId, session);
		if (!ctx) return undefined;
		return {
			context: {
				systemPrompt: session.runtime.piAgent.state.systemPrompt,
				messages: ctx.messages,
				tools: session.runtime.piAgent.state.tools,
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
		const path = walkPath(record.entries, session.runtime.leafId);
		const usage = getLastAssistantUsage(path);
		if (!usage) return undefined;
		const contextTokens = calculateContextTokens(usage);
		const contextWindow =
			(session.runtime.piAgent.state.model as Model<Api> & { contextWindow?: number }).contextWindow ?? 0;
		if (contextWindow <= 0) return undefined;
		if (contextTokens <= contextWindow - settings.reserveTokens) return undefined;

		// Background compaction — swallow skip/failure outcomes and leave the session uncompacted.
		const outcome = await this.runAndPersistCompaction(sessionId, session, "proactive", { record });
		if (outcome.kind !== "succeeded") return undefined;
		return { messages: outcome.messages };
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
		finishTurn: (stopReason: StopReason | undefined, errorMessage: string | undefined) => Promise<void>,
	): Promise<boolean> {
		if (session.runtime.overflowRecoveryAttempted) return false;
		const messages = session.runtime.piAgent.state.messages;
		const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
		if (!lastAssistant) return false;
		const contextWindow =
			(session.runtime.piAgent.state.model as Model<Api> & { contextWindow?: number }).contextWindow ?? 0;
		if (!isContextOverflow(lastAssistant as AssistantMessage, contextWindow > 0 ? contextWindow : undefined)) {
			return false;
		}
		session.runtime.overflowRecoveryAttempted = true;

		// Drop the failed assistant message so the retry doesn't replay it as history.
		session.runtime.piAgent.state.messages = messages.slice(0, -1);

		// Recovery compaction — non-fatal: any skip/failure outcome aborts the recovery attempt.
		const compactOutcome = await this.runAndPersistCompaction(sessionId, session, "recovery");
		if (compactOutcome.kind !== "succeeded") return false;

		// Retry the same user prompt once. A re-overflow falls through.
		const retryOutcome: { stopReason?: PiStopReason; errorMessage?: string } = {};
		const unsubscribe = this.subscribeToAgent(sessionId, session, retryOutcome);
		try {
			await session.runtime.piAgent.prompt(promptText);
			await session.runtime.piAgent.waitForIdle();
		} finally {
			unsubscribe();
		}
		if (retryOutcome.stopReason === "error") {
			outcome.stopReason = retryOutcome.stopReason;
			outcome.errorMessage = retryOutcome.errorMessage;
			return false;
		}
		await finishTurn(mapStopReason(retryOutcome.stopReason), undefined);
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
		return session.runtime.piAgent.subscribe(async (event) => {
			switch (event.type) {
				case "turn_start": {
					await events.emit({ type: "turn_start", sessionId });
					return;
				}
				case "turn_end": {
					await events.emit({
						type: "turn_end",
						sessionId,
						message: event.message,
						toolResults: event.toolResults,
					});
					return;
				}
				case "message_start": {
					await events.emit({ type: "message_start", sessionId, message: event.message });
					return;
				}
				case "message_update": {
					await events.emit({
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
					await events.emit({
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
					await events.emit({
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
					await events.emit({
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
					await events.emit({ type: "message_end", sessionId, message: event.message });
					const message = event.message;
					if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") return;
					if (message.role === "assistant") {
						outcome.stopReason = message.stopReason;
						outcome.errorMessage = message.errorMessage;
					}
					await appendEntry(sessionId, session, {
						type: "message",
						id: randomUUID(),
						parentId: session.runtime.leafId,
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
		session.runtime.cancelled = true;
		session.runtime.piAgent.abort();
	}

	/**
	 * Dynamic model registry: pi-ai built-in catalog filtered by stored auth,
	 * plus host-additive `config.models` (for non-pi-ai providers like local
	 * Ollama), plus extension-provided models. Deduped by id.
	 */
	private async allModels(): Promise<Model<Api>[]> {
		const out: Model<Api>[] = [];
		const seen = new Set<string>();
		const hostProviders = new Set<string>();
		const push = (m: Model<Api>) => {
			if (seen.has(m.id)) return;
			seen.add(m.id);
			out.push(m);
		};
		// Host-supplied models win — if the host listed ANY model for a provider,
		// pi-ai's catalog is suppressed for that provider (the host knows best,
		// including custom baseUrls for tests / local LLMs).
		for (const m of this.config.models ?? []) {
			push(m);
			hostProviders.add(m.provider);
		}
		for (const m of this.extensionRunner?.getProviderModels() ?? []) {
			push(m);
			hostProviders.add(m.provider);
		}
		// pi-ai catalog filtered by stored auth, skipping provider names the host
		// already supplied.
		for (const provider of getProviders()) {
			if (hostProviders.has(provider)) continue;
			const key = await this.resolveProviderApiKey(provider);
			if (!key) continue;
			for (const m of getModels(provider as KnownProvider) as Model<Api>[]) push(m);
		}
		return out;
	}

	private async findModel(id: string): Promise<Model<Api>> {
		const models = await this.allModels();
		const m = models.find((x) => x.id === id);
		if (!m) {
			throw new RequestError(
				-32602,
				`unknown or unavailable model id: "${id}" — run /login <provider> <api-key> first`,
			);
		}
		return m;
	}

	/**
	 * Pick a model id at session bootstrap, preferring (in order):
	 *   1. `BodhiPiConfig.defaultModelId` when it resolves in the dynamic registry,
	 *   2. `mergedFileSettings.defaultModel` when it resolves,
	 *   3. The first auth-available model in the dynamic registry.
	 *
	 * Returns `null` when no auth-resolvable model exists; the session boots with
	 * `runtime.currentModelId === null` and `prompt()` rejects with a branched error.
	 */
	private async pickDefaultModelIdOrNull(merged: BodhiPiProjectSettings): Promise<string | null> {
		const models = await this.allModels();
		const explicit = this.config.defaultModelId;
		if (explicit && models.find((m) => m.id === explicit)) return explicit;
		const fromSettings = merged.defaultModel;
		if (fromSettings && models.find((m) => m.id === fromSettings)) return fromSettings;
		return models[0]?.id ?? null;
	}

	private async buildModelConfigOption(currentValue: string | null): Promise<SessionConfigOption> {
		const models = await this.allModels();
		return {
			id: MODEL_CONFIG_ID,
			name: "Model",
			category: "model",
			type: "select",
			// ACP requires `currentValue: string`; emit `""` when no model is auth-resolvable so hosts can render an "unset" picker.
			currentValue: currentValue ?? "",
			options: models.map((m) => ({ value: m.id, name: m.name })),
		};
	}

	private buildThinkingConfigOption(session: SessionState): SessionConfigOption | undefined {
		const model = session.runtime.piAgent.state.model;
		const supported = getSupportedThinkingLevels(model);
		// Models that only support "off" — non-reasoning — don't advertise the option at all.
		if (supported.length <= 1) return undefined;
		return {
			id: THINKING_CONFIG_ID,
			name: "Thinking",
			category: "model",
			type: "select",
			currentValue: session.runtime.thinkingLevel,
			options: supported.map((level) => ({ value: level, name: level })),
		};
	}

	private async buildAllConfigOptions(sessionId: string): Promise<SessionConfigOption[]> {
		const session = this.sessions.get(sessionId);
		if (!session) return [];
		const options: SessionConfigOption[] = [await this.buildModelConfigOption(session.runtime.currentModelId)];
		const thinking = this.buildThinkingConfigOption(session);
		if (thinking) options.push(thinking);
		return options;
	}

	private async rehydrateSession(
		sessionId: string,
		cwd: string,
	): Promise<{
		entries: NonNullable<Awaited<ReturnType<SessionStore["load"]>>>["entries"];
		currentModelId: string | null;
	}> {
		const record = await this.config.sessionStore.load(sessionId);
		if (!record) throw new RequestError(-32602, `unknown session: ${sessionId}`);

		const ctx = buildSessionContext(record);
		const leafId =
			record.leafId !== undefined
				? record.leafId
				: record.entries.length > 0
					? record.entries[record.entries.length - 1].id
					: null;
		// Resolve to whatever's available: previous session model > first auth-available model. May be
		// `null` if no provider auth is configured; the rebuilt session boots with `runtime.currentModelId === null`.
		const requested = ctx.currentModelId ?? this.config.defaultModelId ?? null;
		const restoredModel = await this._resolveSessionModel(requested);
		await this._buildSessionState(sessionId, restoredModel, cwd, ctx.messages, leafId, ctx.currentThinkingLevel);
		return { entries: record.entries, currentModelId: restoredModel?.id ?? null };
	}

	/**
	 * Resolve a requested model id against the dynamic auth-available registry. Returns the first
	 * available model when `requestedId` doesn't match (so a stale per-session default still boots
	 * with *some* working model), or `null` when nothing is auth-available — caller must handle the
	 * `null` path: bootstrap with `currentModelId === null` and reject `prompt()` with the branched
	 * error.
	 */
	private async _resolveSessionModel(requestedId: string | null): Promise<Model<Api> | null> {
		const models = await this.allModels();
		if (requestedId) {
			const hit = models.find((m) => m.id === requestedId);
			if (hit) return hit;
		}
		return models[0] ?? null;
	}

	/**
	 * Read all per-cwd bootstrap inputs in parallel: discovered tools, project + global settings,
	 * and the merged file-settings view. Pure I/O — no Agent construction yet. Reused by `_buildSessionState`
	 * (and any future bootstrap surfaces) so the discovery contract stays in one place.
	 */
	private async loadProjectArtifacts(cwd: string): Promise<{
		builtinTools: ReturnType<typeof createBuiltinTools>;
		projectCommands: Awaited<ReturnType<typeof loadProjectCommands>>;
		skills: Skill[];
		contextFiles: ContextFile[];
		projectSettingsResult: Awaited<ReturnType<typeof loadProjectSettings>>;
		globalSettingsResult: Awaited<ReturnType<typeof loadGlobalSettings>> | undefined;
		mergedFileSettings: BodhiPiProjectSettings;
	}> {
		const builtinTools = createBuiltinTools({
			filesystem: this.config.filesystem,
			cwd,
			...(this.config.scriptExecutor ? { scriptExecutor: this.config.scriptExecutor } : {}),
		});
		const [projectCommands, skills, contextFiles, projectSettingsResult, globalSettingsResult] = await Promise.all([
			loadProjectCommands(this.config.filesystem, cwd),
			loadProjectSkills(this.config.filesystem, cwd),
			loadProjectContextFiles(this.config.filesystem, cwd),
			loadProjectSettings(this.config.filesystem, cwd),
			this.config.homeDir
				? loadGlobalSettings(this.config.globalFilesystem ?? this.config.filesystem, this.config.homeDir)
				: Promise.resolve(undefined),
		]);
		const mergedFileSettings = mergeSettings(globalSettingsResult?.settings ?? {}, projectSettingsResult.settings);
		return {
			builtinTools,
			projectCommands,
			skills,
			contextFiles,
			projectSettingsResult,
			globalSettingsResult,
			mergedFileSettings,
		};
	}

	/**
	 * Build the composed system prompt: optional host-supplied base + builtin tool list + skills section + cwd context-files.
	 * `appendSystemPrompt` precedence is `BodhiPiConfig.appendSystemPrompt` (host-explicit) > `mergedFileSettings.appendSystemPrompt`.
	 */
	private composeSystemPrompt(args: {
		tools: AgentTool[];
		mergedFileSettings: BodhiPiProjectSettings;
		contextFiles: ContextFile[];
		skills: Skill[];
		cwd: string;
	}): { prompt: string; resolvedAppend: string | undefined } {
		const resolvedAppend = this.config.appendSystemPrompt ?? args.mergedFileSettings.appendSystemPrompt ?? undefined;
		const prompt = buildSystemPrompt({
			...(this.config.systemPrompt !== undefined ? { customPrompt: this.config.systemPrompt } : {}),
			selectedTools: args.tools.map((t) => t.name),
			toolSnippets: BUILTIN_TOOL_SNIPPETS,
			...(resolvedAppend !== undefined ? { appendSystemPrompt: resolvedAppend } : {}),
			cwd: args.cwd,
			contextFiles: args.contextFiles,
			skills: args.skills,
		});
		return { prompt, resolvedAppend };
	}

	/**
	 * Construct the `pi-agent-core` Agent + wire every event hook (`tool_call` / `tool_result` /
	 * `before_provider_request` / `after_provider_response` / `prepareNextTurn`) onto the
	 * {@link EventDispatcher}. The model parameter is `null` when no auth-resolvable models are
	 * available — bootstrap continues with pi-agent-core's placeholder so settings/login UIs stay
	 * usable, and `prompt()` rejects with a branched error.
	 */
	private createPiAgent(args: {
		sessionId: string;
		model: Model<Api> | null;
		messages: AgentMessage[];
		tools: AgentTool[];
		systemPrompt: string | undefined;
		thinkingLevel: ModelThinkingLevel;
		retryOptions: ResolvedRetryOptions;
	}): Agent {
		const events = this.events;
		const resolveApiKey = (provider: string) => this.resolveProviderApiKey(provider);
		return new Agent({
			...args.retryOptions,
			initialState: {
				...(args.model ? { model: args.model } : {}),
				...(args.messages.length > 0 ? { messages: args.messages } : {}),
				tools: args.tools,
				...(args.systemPrompt !== undefined ? { systemPrompt: args.systemPrompt } : {}),
				thinkingLevel: args.thinkingLevel as never,
			},
			getApiKey: resolveApiKey,
			beforeToolCall: async (ctx: BeforeToolCallContext): Promise<BeforeToolCallResult | undefined> => {
				const result = await events.emitToolCall({
					type: "tool_call",
					sessionId: args.sessionId,
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
					sessionId: args.sessionId,
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
					sessionId: args.sessionId,
					provider: m.provider,
					modelId: m.id,
					payload,
				});
			},
			onResponse: async (response: ProviderResponse, m) => {
				await events.emit({
					type: "after_provider_response",
					sessionId: args.sessionId,
					provider: m.provider,
					modelId: m.id,
					status: response.status,
					headers: response.headers,
				});
			},
			prepareNextTurn: async (): Promise<AgentLoopTurnUpdate | undefined> => {
				const compactUpdate = await this.maybeProactiveCompact(args.sessionId);
				const state = this.sessions.get(args.sessionId);
				if (!state?.runtime.pendingThinkingLevelChange) return compactUpdate;
				state.runtime.pendingThinkingLevelChange = false;
				return { ...(compactUpdate ?? {}), thinkingLevel: state.runtime.thinkingLevel as never };
			},
		});
	}

	/**
	 * Compose a fresh {@link SessionState} from disk artifacts + a (possibly null) model. Skills
	 * must load before Agent construction so the system prompt's `<available_skills>` block is in
	 * the initial state. `model === null` is a legal bootstrap state (no auth-resolvable models);
	 * the underlying `pi-agent-core` Agent uses its placeholder model and `prompt()` rejects with
	 * a branched error until the user logs in or selects a model.
	 */
	private async _buildSessionState(
		sessionId: string,
		model: Model<Api> | null,
		cwd: string,
		messages: AgentMessage[] = [],
		leafId: string | null = null,
		initialThinkingLevel: ModelThinkingLevel | null = null,
	): Promise<void> {
		const artifacts = await this.loadProjectArtifacts(cwd);
		const {
			builtinTools,
			projectCommands,
			skills,
			contextFiles,
			projectSettingsResult,
			globalSettingsResult,
			mergedFileSettings,
		} = artifacts;

		const resolvedModel =
			model ?? (await this._resolveSessionModel(await this.pickDefaultModelIdOrNull(mergedFileSettings)));
		const tools = this.extensionRunner ? mergeTools(builtinTools, this.extensionRunner.getTools()) : builtinTools;
		const commands = this.extensionRunner
			? mergeCommands(projectCommands, this.extensionRunner.getCommands())
			: projectCommands;

		const { prompt: composedSystemPrompt, resolvedAppend } = this.composeSystemPrompt({
			tools,
			mergedFileSettings,
			contextFiles,
			skills,
			cwd,
		});
		const effectiveCompaction: CompactionSettings = {
			...DEFAULT_COMPACTION_SETTINGS,
			...(mergedFileSettings.compaction ?? {}),
			...(this.config.compaction ?? {}),
		};
		const requestedThinking: ModelThinkingLevel =
			initialThinkingLevel ?? this.config.defaultThinkingLevel ?? mergedFileSettings.defaultThinkingLevel ?? "off";
		// `clampThinkingLevel` requires a model; when none is auth-available, default to "off".
		const resolvedThinkingLevel = resolvedModel ? clampThinkingLevel(resolvedModel, requestedThinking) : "off";
		const retryOptions = resolveProviderStreamOptions(resolvedModel?.provider ?? "openai", mergedFileSettings);

		const piAgent = this.createPiAgent({
			sessionId,
			model: resolvedModel,
			messages,
			tools,
			systemPrompt: composedSystemPrompt,
			thinkingLevel: resolvedThinkingLevel,
			retryOptions,
		});

		this.sessions.set(sessionId, {
			cwd,
			tools,
			commands,
			skills,
			appendSystemPrompt: resolvedAppend ?? null,
			contextFiles,
			compaction: effectiveCompaction,
			retryOptions,
			settings: {
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
			},
			runtime: {
				piAgent,
				currentModelId: resolvedModel?.id ?? null,
				thinkingLevel: resolvedThinkingLevel,
				pendingThinkingLevelChange: false,
				cancelled: false,
				leafId,
				overflowRecoveryAttempted: false,
			},
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
