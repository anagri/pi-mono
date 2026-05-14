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
	type SetSessionConfigOptionRequest,
	type SetSessionConfigOptionResponse,
} from "@agentclientprotocol/sdk";
import type { Api, Model, ModelThinkingLevel, StopReason as PiStopReason } from "@earendil-works/pi-ai";
import { expandPromptTemplate, type PromptTemplate } from "@/commands/prompt-templates.js";
import { EventDispatcher } from "@/events/dispatcher.js";
import type { BodhiPiEventHandlers, StopReason } from "@/events/types.js";
import { mergeCommands } from "@/extensions/merge.js";
import { ExtensionRunner } from "@/extensions/runner.js";
import type { RegisteredExtension } from "@/extensions/types.js";
import type { Filesystem } from "@/filesystem/filesystem.js";
import { KvService } from "@/kv/kv-service.js";
import type { KvStore } from "@/kv/kv-store.js";
import { ModelRegistry } from "@/models/registry.js";
import type { ScriptExecutor } from "@/script-executor/script-executor.js";
import { extractText, extractToolCalls, formatLocationHint, isToolResultMessage } from "@/sessions/_shared.js";
import type { CompactionSettings } from "@/sessions/compaction.js";
import { CompactionOrchestrator } from "@/sessions/compaction-orchestrator.js";
import type { SessionEntry } from "@/sessions/entries.js";
import {
	type BootstrapDeps,
	buildSessionState as buildSessionStateFn,
	rehydrateSession as rehydrateSessionFn,
} from "@/sessions/session-bootstrap.js";
import { SessionGraphService } from "@/sessions/session-graph-service.js";
import { SessionInfoService } from "@/sessions/session-info-service.js";
import type { ResolvedRetryOptions, SessionState } from "@/sessions/session-state.js";
import type { SessionStore } from "@/sessions/session-store.js";
import type { BodhiPiProjectSettings, ProviderOptionsEntry } from "@/settings/settings.js";
import { SettingsService } from "@/settings/settings-service.js";
import { expandSkillCommand } from "@/skills/invocation.js";
import type { Skill } from "@/skills/skill.js";
import { toolKindFor } from "@/tools/index.js";
import { BODHI_PI_VERSION } from "@/version.js";
import { EXT_DELETE_SESSION, MODEL_CONFIG_ID } from "@/wire/constants.js";
import { agentToolContentForAcp, mapStopReason, toolResultContentForAcp } from "@/wire/converters.js";
import { validateSessionId } from "@/wire/validators.js";
import { wireInternalEventHandlers } from "./event-wiring.js";

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
	/**
	 * Host-supplied logger for non-fatal internal errors (extension factory failures, event-handler
	 * exceptions, branch-summarisation fall-through). Defaults to `console.error` when unset.
	 */
	logger?: BodhiPiLogger;
}

/** Minimal logger contract for non-fatal internal errors. Compatible with `console`. */
export interface BodhiPiLogger {
	error(message: string, ...args: unknown[]): void;
}

function _resolveProviderStreamOptions(provider: string, merged: BodhiPiProjectSettings): ResolvedRetryOptions {
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
	private readonly logger: BodhiPiLogger;
	private readonly modelRegistry: ModelRegistry;
	private readonly kvService: KvService;
	private readonly settingsService: SettingsService;
	private readonly sessionInfoService: SessionInfoService;
	private readonly compactionOrchestrator: CompactionOrchestrator;
	private readonly sessionGraphService: SessionGraphService;
	private extensionRunner?: ExtensionRunner;
	private extensionRunnerReady?: Promise<void>;
	/** Single source of truth for `_bodhi-pi/*` ext-method dispatch — one entry per implemented method. */
	private readonly extHandlers: Map<string, ExtHandler>;

	constructor(
		private readonly config: BodhiPiConfig,
		private readonly conn: AgentSideConnection,
	) {
		const logger: BodhiPiLogger = config.logger ?? console;
		this.logger = logger;
		// EventDispatcher is constructed once with both host-supplied handlers
		// AND extension-registered handlers merged. Extension handlers are added
		// asynchronously via `ensureExtensionRunner()` on first session use.
		this.events = new EventDispatcher(config.eventHandlers, logger);

		this.modelRegistry = new ModelRegistry({
			...(config.models ? { hostModels: config.models } : {}),
			...(config.defaultModelId !== undefined ? { defaultModelId: config.defaultModelId } : {}),
			...(config.getApiKey ? { getApiKey: config.getApiKey } : {}),
			...(config.kvStore ? { kvStore: config.kvStore } : {}),
			sessions: this.sessions,
			events: this.events,
			appendEntry: this.appendEntry.bind(this),
			extensionRunner: () => this.extensionRunner,
		});

		wireInternalEventHandlers({
			events: this.events,
			conn: this.conn,
			sessions: this.sessions,
			modelRegistry: this.modelRegistry,
		});

		this.kvService = new KvService({
			...(config.kvStore ? { kvStore: config.kvStore } : {}),
			events: this.events,
		});
		this.settingsService = new SettingsService({
			filesystem: config.filesystem,
			...(config.globalFilesystem ? { globalFilesystem: config.globalFilesystem } : {}),
			...(config.homeDir ? { homeDir: config.homeDir } : {}),
			events: this.events,
			sessions: this.sessions,
		});
		this.sessionInfoService = new SessionInfoService({
			sessions: this.sessions,
			sessionStore: config.sessionStore,
			conn: this.conn,
			appendEntry: this.appendEntry.bind(this),
			getDefaultModelId: () => this.config.defaultModelId,
		});
		this.compactionOrchestrator = new CompactionOrchestrator({
			sessions: this.sessions,
			sessionStore: config.sessionStore,
			events: this.events,
			appendEntry: this.appendEntry.bind(this),
			resolveApiKey: (p: string) => this.modelRegistry.resolveProviderApiKey(p),
			subscribeToAgent: (sid, sess, outcome) => this.subscribeToAgent(sid, sess, outcome),
			logger,
		});

		this.sessionGraphService = new SessionGraphService({
			sessions: this.sessions,
			sessionStore: config.sessionStore,
			events: this.events,
			compactionOrchestrator: this.compactionOrchestrator,
		});

		this.extHandlers = new Map<string, ExtHandler>([
			[EXT_DELETE_SESSION, this.handleSessionDelete.bind(this)],
			...this.sessionGraphService.register(),
			...this.kvService.register(),
			...this.settingsService.register(),
			...this.sessionInfoService.register(),
			...this.compactionOrchestrator.register(),
		]);
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
					requestSlashableRefresh: (sessionId) => this.refreshSlashable(sessionId),
					logger: this.logger,
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

	private bootstrapDeps(): BootstrapDeps {
		return {
			config: this.config,
			events: this.events,
			conn: this.conn,
			sessions: this.sessions,
			modelRegistry: this.modelRegistry,
			compactionOrchestrator: this.compactionOrchestrator,
			extensionRunner: () => this.extensionRunner,
		};
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
		await buildSessionStateFn(this.bootstrapDeps(), { sessionId: record.id, model: null, cwd: record.cwd });
		await this.advertiseSlashable(record.id);
		await this.events.emit({
			type: "session_start",
			sessionId: record.id,
			cwd: record.cwd,
			reason: "new",
		});
		return {
			sessionId: record.id,
			configOptions: await this.modelRegistry.buildAllConfigOptions(record.id),
		};
	}

	async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
		await this.ensureExtensionRunner();
		const restored = await rehydrateSessionFn(this.bootstrapDeps(), params.sessionId, params.cwd);

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
			configOptions: await this.modelRegistry.buildAllConfigOptions(params.sessionId),
		};
	}

	async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
		await this.ensureExtensionRunner();
		// Per ACP spec: rehydrate without replaying history.
		await rehydrateSessionFn(this.bootstrapDeps(), params.sessionId, params.cwd);
		await this.advertiseSlashable(params.sessionId);
		await this.events.emit({
			type: "session_start",
			sessionId: params.sessionId,
			cwd: params.cwd,
			reason: "resume",
		});
		return {
			configOptions: await this.modelRegistry.buildAllConfigOptions(params.sessionId),
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
		const sessionId = validateSessionId(EXT_DELETE_SESSION, params);
		this.sessions.get(sessionId)?.runtime.piAgent.abort();
		this.sessions.delete(sessionId);
		await this.config.sessionStore.delete(sessionId);
		await this.events.emit({ type: "session_shutdown", sessionId });
		return {};
	}

	/** Build the persisted entry from a successful summarization result. Single source of truth for the literal across manual/proactive/recovery paths. */

	setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
		return this.modelRegistry.setSessionConfigOption(params);
	}

	async prompt(params: PromptRequest): Promise<PromptResponse> {
		const session = this.sessions.get(params.sessionId);
		if (!session) {
			throw new RequestError(-32602, `session ${params.sessionId} is not loaded. Call session/load first.`);
		}

		if (session.runtime.currentModelId === null) {
			const models = await this.modelRegistry.allModels();
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
				const recovered = await this.compactionOrchestrator.tryOverflowRecovery(
					sessionId,
					session,
					promptText,
					outcome,
					finishTurn,
				);
				if (recovered) {
					return { stopReason: "end_turn", userMessageId: params.messageId ?? null };
				}
				const errorMessage = outcome.errorMessage ?? "model error";
				await finishTurn(undefined, errorMessage);
				throw new RequestError(-32603, errorMessage);
			}
			const stopReason = mapStopReason(outcome.stopReason);
			await finishTurn(stopReason, undefined);
			await this.compactionOrchestrator.checkAutoCompact(sessionId, session);
			return { stopReason, userMessageId: params.messageId ?? null };
		} finally {
			unsubscribe();
		}
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

	/**
	 * Re-merge each session's `commands` from its frozen `projectCommands` plus
	 * the extension runner's *current* registry, then re-advertise. Invoked by
	 * the runner whenever a `registerCommand` (or its unregister) fires after
	 * boot, and by the explicit `pi.requestSlashableRefresh(sessionId)` API.
	 *
	 * When `sessionId` is omitted, refresh every loaded session — implicit
	 * `registerCommand` is global, so all sessions need to see the new entry.
	 * When `sessionId` is provided but unknown, this is a no-op (graceful for
	 * extensions that hold stale ids).
	 */
	private async refreshSlashable(sessionId?: string): Promise<void> {
		const runner = this.extensionRunner;
		const targets = sessionId !== undefined ? [sessionId] : Array.from(this.sessions.keys());
		for (const id of targets) {
			const session = this.sessions.get(id);
			if (!session) continue;
			session.commands = runner
				? mergeCommands(session.projectCommands, runner.getCommands())
				: session.projectCommands;
			await this.advertiseSlashable(id);
		}
	}
}
