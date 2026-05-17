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
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { pickDefined } from "@/_internal/object.js";
import type { PromptTemplate } from "@/commands/prompt-templates.js";
import { EventDispatcher } from "@/events/dispatcher.js";
import type { BodhiPiEventHandlers } from "@/events/types.js";
import { mergeCommands } from "@/extensions/merge.js";
import { ExtensionRunner } from "@/extensions/runner.js";
import type { RegisteredExtension } from "@/extensions/types.js";
import type { Filesystem } from "@/filesystem/filesystem.js";
import { KvService } from "@/kv/kv-service.js";
import type { KvStore } from "@/kv/kv-store.js";
import { createInProcessMcpConnectionProvider } from "@/mcp/in-process-provider.js";
import type { McpConnectionProvider } from "@/mcp/mcp-connection-provider.js";
import { McpService } from "@/mcp/mcp-service.js";
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
import type { Skill } from "@/skills/skill.js";
import type { Terminal } from "@/terminal/terminal.js";
import { toolKindFor } from "@/tools/index.js";
import { BODHI_PI_VERSION } from "@/version.js";
import { EXT_DELETE_SESSION } from "@/wire/constants.js";
import { toolResultContentForAcp } from "@/wire/converters.js";
import { validateSessionId } from "@/wire/validators.js";
import { wireInternalEventHandlers } from "./event-wiring.js";
import { type PromptLoopDeps, runPromptLoop, subscribeToAgent } from "./prompt-loop.js";

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
	/** When provided, the `bash` built-in tool is registered. Hosts implement per their runtime. */
	terminal?: Terminal;
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
	 * When `false`, `_bodhi-pi/mcp/add` rejects `command=…` (stdio) MCP entries with a clear error.
	 *
	 * Defaults to `true`. **Hosts that cannot spawn child processes MUST set this to `false` explicitly**
	 * — otherwise the agent silently accepts stdio MCP entries that subsequent `_bodhi-pi/mcp/connect`
	 * calls cannot fulfill. The wrong default is a silent UX bug, not a runtime error. Applies to:
	 * `test-apps/browser`, `test-apps/chrome-ext`, and stateless HTTP rebuild Hosts.
	 */
	supportsMcpStdio?: boolean;
	/**
	 * Host-injected MCP connection provider. When omitted, the SDK installs a
	 * process-local default (`createInProcessMcpConnectionProvider()`) — fine for
	 * single-tenant embedded hosts (cli, in-memory). Multi-tenant server hosts
	 * (http, ws-server) inject a provider bound to a server-level per-user store
	 * so connections survive per-request agent rebuild.
	 */
	mcpConnectionProvider?: McpConnectionProvider;
	/**
	 * Host-supplied logger for non-fatal internal errors (extension factory failures, event-handler
	 * exceptions, branch-summarisation fall-through). Defaults to `console.error` when unset.
	 */
	logger?: BodhiPiLogger;
}

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

function metaWithNotFoundSlugs(notFoundSlugs: string[]): { _meta?: Record<string, unknown> } {
	if (notFoundSlugs.length === 0) return {};
	return { _meta: { "bodhi-pi": { mcp: { notFoundSlugs } } } };
}

export function createBodhiPiAgent(config: BodhiPiConfig) {
	if (!config.sessionStore) {
		throw new Error("BodhiPiConfig.sessionStore is required (no default fallback)");
	}
	if (!config.filesystem) {
		throw new Error("BodhiPiConfig.filesystem is required (no default fallback)");
	}
	return (conn: AgentSideConnection): AcpAgent => new BodhiPiAcpAgent(config, conn);
}

type ExtHandler = (params: Record<string, unknown>) => Promise<Record<string, unknown>>;

class BodhiPiAcpAgent implements AcpAgent {
	private sessions = new Map<string, SessionState>();
	private readonly events: EventDispatcher;
	private readonly logger: BodhiPiLogger;
	private readonly modelRegistry: ModelRegistry;
	private readonly kvService: KvService;
	private readonly mcpService: McpService;
	private readonly settingsService: SettingsService;
	private readonly sessionInfoService: SessionInfoService;
	private readonly compactionOrchestrator: CompactionOrchestrator;
	private readonly sessionGraphService: SessionGraphService;
	private extensionRunner?: ExtensionRunner;
	private extensionRunnerReady?: Promise<void>;
	private readonly extHandlers: Map<string, ExtHandler>;

	constructor(
		private readonly config: BodhiPiConfig,
		private readonly conn: AgentSideConnection,
	) {
		const logger: BodhiPiLogger = config.logger ?? console;
		this.logger = logger;
		this.events = new EventDispatcher(config.eventHandlers, logger);

		this.modelRegistry = new ModelRegistry({
			...pickDefined({
				hostModels: config.models,
				defaultModelId: config.defaultModelId,
				getApiKey: config.getApiKey,
				kvStore: config.kvStore,
			}),
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
			...pickDefined({ kvStore: config.kvStore }),
			events: this.events,
		});
		this.mcpService = new McpService({
			...pickDefined({ kvStore: config.kvStore }),
			events: this.events,
			conn: this.conn,
			sessions: this.sessions,
			logger,
			supportsStdio: config.supportsMcpStdio ?? true,
			provider: config.mcpConnectionProvider ?? createInProcessMcpConnectionProvider(),
			appendEntry: this.appendEntry.bind(this),
		});
		this.settingsService = new SettingsService({
			filesystem: config.filesystem,
			...pickDefined({ globalFilesystem: config.globalFilesystem }),
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
			subscribeToAgent: (sid, sess, outcome) =>
				subscribeToAgent(
					{ conn: this.conn, events: this.events, appendEntry: this.appendEntry.bind(this) },
					sid,
					sess,
					outcome,
				),
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
			...this.mcpService.register(),
			...this.settingsService.register(),
			...this.sessionInfoService.register(),
			...this.compactionOrchestrator.register(),
		]);
	}

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
				mcpCapabilities: { http: true, sse: false },
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
		// New session: no prior `mcp_inclusion_set` entry, so restoredSlugs=null.
		const { notFoundSlugs } = await this.mcpService.hydrate(record.id, params.mcpServers, null);
		await this.events.emit({
			type: "session_start",
			sessionId: record.id,
			cwd: record.cwd,
			reason: "new",
		});
		return {
			sessionId: record.id,
			configOptions: await this.modelRegistry.buildAllConfigOptions(record.id),
			...metaWithNotFoundSlugs(notFoundSlugs),
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
		const { notFoundSlugs } = await this.mcpService.hydrate(
			params.sessionId,
			params.mcpServers,
			restored.mcpInclusion,
		);
		await this.events.emit({
			type: "session_start",
			sessionId: params.sessionId,
			cwd: params.cwd,
			reason: "load",
		});
		return {
			configOptions: await this.modelRegistry.buildAllConfigOptions(params.sessionId),
			...metaWithNotFoundSlugs(notFoundSlugs),
		};
	}

	async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
		await this.ensureExtensionRunner();
		// Per ACP spec: rehydrate without replaying history.
		const restored = await rehydrateSessionFn(this.bootstrapDeps(), params.sessionId, params.cwd);
		await this.advertiseSlashable(params.sessionId);
		const { notFoundSlugs } = await this.mcpService.hydrate(
			params.sessionId,
			params.mcpServers,
			restored.mcpInclusion,
		);
		await this.events.emit({
			type: "session_start",
			sessionId: params.sessionId,
			cwd: params.cwd,
			reason: "resume",
		});
		return {
			configOptions: await this.modelRegistry.buildAllConfigOptions(params.sessionId),
			...metaWithNotFoundSlugs(notFoundSlugs),
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
		await this.mcpService.closeSession(params.sessionId);
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
		await this.mcpService.closeSession(sessionId);
		this.sessions.delete(sessionId);
		await this.config.sessionStore.delete(sessionId);
		await this.events.emit({ type: "session_shutdown", sessionId });
		return {};
	}

	setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
		return this.modelRegistry.setSessionConfigOption(params);
	}

	async prompt(params: PromptRequest): Promise<PromptResponse> {
		const session = this.sessions.get(params.sessionId);
		if (!session) {
			throw new RequestError(-32602, `session ${params.sessionId} is not loaded. Call session/load first.`);
		}
		return runPromptLoop(this.promptLoopDeps(), session, params);
	}

	private promptLoopDeps(): PromptLoopDeps {
		return {
			conn: this.conn,
			events: this.events,
			modelRegistry: this.modelRegistry,
			compactionOrchestrator: this.compactionOrchestrator,
			appendEntry: this.appendEntry.bind(this),
		};
	}

	async cancel(params: CancelNotification): Promise<void> {
		const session = this.sessions.get(params.sessionId);
		if (!session) return;
		session.runtime.cancelled = true;
		session.runtime.piAgent.abort();
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

	/** When `sessionId` is omitted, refresh every loaded session — implicit `registerCommand` is global. */
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
