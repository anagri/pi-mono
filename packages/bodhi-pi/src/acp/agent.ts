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
import { createEvent } from "@/events/factory.js";
import type { BodhiPiEventHandlers } from "@/events/types.js";
import { ExtensionRunnerHost } from "@/extensions/extension-runner-host.js";
import { mergeCommands } from "@/extensions/merge.js";
import type { ExtensionRunner } from "@/extensions/runner.js";
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
import { SubagentService } from "@/subagents/subagent-service.js";
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
	 * Multi-tenant routing token. When set, `_bodhi-pi/mcp/oauth/start` emits a state token of the
	 * form `<base64url(tenantId)>.<random>` so a process-wide `/oauth/callback` handler can route
	 * the redirect to the right user's kvStore. Single-tenant hosts (CLI, browser) leave this unset.
	 */
	tenantId?: string;
	/**
	 * Host-supplied logger for non-fatal internal errors (extension factory failures, event-handler
	 * exceptions, branch-summarisation fall-through). Defaults to `console.error` when unset.
	 */
	logger?: BodhiPiLogger;
	/** Sub-agent service knobs. */
	subagents?: {
		/** Max children dispatchable in a single `subagent_batch` call. Defaults to 5. */
		maxBatchConcurrency?: number;
	};
}

export interface BodhiPiLogger {
	error(message: string, ...args: unknown[]): void;
	warn(message: string, ...args: unknown[]): void;
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
	private readonly subagentService: SubagentService;
	private readonly extensionRunnerHost: ExtensionRunnerHost;
	private readonly extHandlers: Map<string, ExtHandler>;

	constructor(
		private readonly config: BodhiPiConfig,
		private readonly conn: AgentSideConnection,
	) {
		const logger: BodhiPiLogger = config.logger ?? console;
		this.logger = logger;
		this.events = new EventDispatcher(config.eventHandlers, logger);

		this.extensionRunnerHost = new ExtensionRunnerHost({
			conn: this.conn,
			sessionStore: config.sessionStore,
			events: this.events,
			logger,
			factories: config.extensionFactories,
			requestSlashableRefresh: (sessionId) => this.refreshSlashable(sessionId),
		});

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
			extensionRunner: () => this.extensionRunnerHost.current(),
		});

		wireInternalEventHandlers({
			events: this.events,
			conn: this.conn,
			sessions: this.sessions,
			modelRegistry: this.modelRegistry,
			logger,
		});

		this.kvService = new KvService({
			...pickDefined({ kvStore: config.kvStore }),
			events: this.events,
		});
		this.mcpService = new McpService({
			...pickDefined({ kvStore: config.kvStore, tenantId: config.tenantId }),
			events: this.events,
			sessions: this.sessions,
			logger,
			supportsStdio: config.supportsMcpStdio ?? true,
			provider:
				config.mcpConnectionProvider ??
				createInProcessMcpConnectionProvider(config.kvStore ? { kvStore: config.kvStore } : {}),
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

		this.subagentService = new SubagentService({
			sessions: this.sessions,
			sessionStore: config.sessionStore,
			events: this.events,
			conn: this.conn,
			logger,
			mcpService: this.mcpService,
			bootstrapDeps: () => this.bootstrapDeps(),
			promptLoopDeps: () => this.promptLoopDeps(),
			appendEntry: this.appendEntry.bind(this),
			...(config.subagents?.maxBatchConcurrency !== undefined
				? { maxBatchConcurrency: config.subagents.maxBatchConcurrency }
				: {}),
		});

		this.extHandlers = new Map<string, ExtHandler>([
			[EXT_DELETE_SESSION, this.handleSessionDelete.bind(this)],
			...this.sessionGraphService.register(),
			...this.kvService.register(),
			...this.mcpService.register(),
			...this.settingsService.register(),
			...this.sessionInfoService.register(),
			...this.compactionOrchestrator.register(),
			...this.subagentService.register(),
		]);
	}

	private async appendEntry(sessionId: string, session: SessionState, entry: SessionEntry): Promise<void> {
		entry.parentId = session.runtime.leafId;
		await this.config.sessionStore.append(sessionId, entry);
		session.runtime.leafId = entry.id;
		await this.config.sessionStore.setLeafId(sessionId, entry.id);
	}

	private ensureExtensionRunner(): Promise<ExtensionRunner | undefined> {
		return this.extensionRunnerHost.ensure();
	}

	private bootstrapDeps(): BootstrapDeps {
		return {
			config: this.config,
			events: this.events,
			conn: this.conn,
			sessions: this.sessions,
			modelRegistry: this.modelRegistry,
			compactionOrchestrator: this.compactionOrchestrator,
			extensionRunner: () => this.extensionRunnerHost.current(),
			subagentService: this.subagentService,
		};
	}

	async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
		// Build the runner here (not lazily at first session/new) so initialize can surface any
		// optional-extension factory failures via _meta. Required-extension failures still throw,
		// aborting initialize — Hosts that opted in via `required:true` get a hard failure rather
		// than a degraded agent.
		try {
			await this.ensureExtensionRunner();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			throw new RequestError(-32603, `bodhi-pi initialize failed: ${message}`);
		}
		const failed = this.extensionRunnerHost.getExtensionErrorNames();
		const bodhiPiMeta: Record<string, unknown> = {
			version: BODHI_PI_VERSION,
			available: this.computeAvailability(),
		};
		if (failed.length > 0) bodhiPiMeta.extensions = { failed };
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
				_meta: { "bodhi-pi": bodhiPiMeta },
			},
			authMethods: [],
		};
	}

	/**
	 * Per-namespace availability flags derived from the injected adapter set. Clients can use these
	 * to disable/hide UX surfaces (e.g. an MCP panel when `kv:false` means MCP entries can't be
	 * persisted). The flags are computed at agent construction; they don't change per session.
	 */
	private computeAvailability(): {
		kv: boolean;
		mcp: boolean;
		terminal: boolean;
		scriptExecutor: boolean;
		settings: boolean;
		subagent: boolean;
	} {
		return {
			kv: this.config.kvStore !== undefined,
			// MCP entries persist in the kvStore — without one, /mcp add and hydration are non-functional.
			mcp: this.config.kvStore !== undefined,
			terminal: this.config.terminal !== undefined,
			scriptExecutor: this.config.scriptExecutor !== undefined,
			settings: true,
			// SubagentService is unconditionally registered (bundled built-ins always present); per-session profile count is reachable via `_bodhi-pi/subagent/list`.
			subagent: true,
		};
	}

	async authenticate(_params: AuthenticateRequest): Promise<AuthenticateResponse> {
		return {};
	}

	async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
		await this.ensureExtensionRunner();
		const record = await this.config.sessionStore.create({ cwd: params.cwd });
		await buildSessionStateFn(this.bootstrapDeps(), { sessionId: record.id, model: null, cwd: record.cwd });
		const { notFoundSlugs } = await this.finalizeSessionBoot({
			sessionId: record.id,
			cwd: record.cwd,
			reason: "new",
			mcpServers: params.mcpServers,
			restoredSlugs: null, // new session: no prior mcp_inclusion_set entry.
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
		await this.replayHistoryForLoad(params.sessionId, restored.entries);
		const { notFoundSlugs } = await this.finalizeSessionBoot({
			sessionId: params.sessionId,
			cwd: params.cwd,
			reason: "load",
			mcpServers: params.mcpServers,
			restoredSlugs: restored.mcpInclusion,
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
		const { notFoundSlugs } = await this.finalizeSessionBoot({
			sessionId: params.sessionId,
			cwd: params.cwd,
			reason: "resume",
			mcpServers: params.mcpServers,
			restoredSlugs: restored.mcpInclusion,
		});
		return {
			configOptions: await this.modelRegistry.buildAllConfigOptions(params.sessionId),
			...metaWithNotFoundSlugs(notFoundSlugs),
		};
	}

	/**
	 * Shared tail of new/load/resume: announce slash commands, hydrate MCP, emit session_start.
	 * Returns the hydration result so the caller can lift `notFoundSlugs` into the response meta.
	 */
	private async finalizeSessionBoot(opts: {
		sessionId: string;
		cwd: string;
		reason: "new" | "load" | "resume";
		mcpServers: Parameters<McpService["hydrate"]>[1];
		restoredSlugs: string[] | null;
	}): Promise<{ notFoundSlugs: string[] }> {
		await this.advertiseSlashable(opts.sessionId);
		const result = await this.mcpService.hydrate(opts.sessionId, opts.mcpServers, opts.restoredSlugs);
		await this.events.emit(
			createEvent("session_start", {
				sessionId: opts.sessionId,
				cwd: opts.cwd,
				reason: opts.reason,
			}),
		);
		return result;
	}

	/**
	 * Stream session history back via `session/update` notifications, pairing each assistant
	 * `tool_use` block with its persisted `tool_result`. Only invoked from `loadSession` —
	 * `resumeSession` deliberately skips replay per ACP spec.
	 */
	private async replayHistoryForLoad(sessionId: string, entries: readonly SessionEntry[]): Promise<void> {
		const toolResultsById = new Map<string, ReturnType<typeof toolResultContentForAcp>>();
		const toolResultIsError = new Map<string, boolean>();
		for (const entry of entries) {
			if (entry.type !== "message") continue;
			if (!isToolResultMessage(entry.message)) continue;
			toolResultsById.set(entry.message.toolCallId, toolResultContentForAcp(entry.message));
			toolResultIsError.set(entry.message.toolCallId, entry.message.isError);
		}

		for (const entry of entries) {
			if (entry.type !== "message") continue;
			const role = entry.message.role;
			if (role === "user") {
				const text = extractText(entry.message);
				if (text) {
					await this.conn.sessionUpdate({
						sessionId,
						update: { sessionUpdate: "user_message_chunk", content: { type: "text", text } },
					});
				}
			} else if (role === "assistant") {
				const text = extractText(entry.message);
				if (text) {
					await this.conn.sessionUpdate({
						sessionId,
						update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
					});
				}
				for (const toolCall of extractToolCalls(entry.message)) {
					await this.conn.sessionUpdate({
						sessionId,
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
							sessionId,
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
		await this.events.emit(createEvent("session_shutdown", { sessionId: params.sessionId }));
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
		await this.events.emit(createEvent("session_shutdown", { sessionId }));
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
		const runner = this.extensionRunnerHost.current();
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
