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
import {
	type AfterToolCallContext,
	type AfterToolCallResult,
	Agent,
	type AgentMessage,
	type AgentTool,
	type BeforeToolCallContext,
	type BeforeToolCallResult,
	type Agent as PiAgent,
} from "@mariozechner/pi-agent-core";
import type { Api, Model, StopReason as PiStopReason, ProviderResponse } from "@mariozechner/pi-ai";
import { loadProjectCommands } from "@/commands/discovery.js";
import { expandPromptTemplate, type PromptTemplate } from "@/commands/prompt-templates.js";
import { EventDispatcher } from "@/events/dispatcher.js";
import type { BodhiPiEventHandlers } from "@/events/types.js";
import { mergeCommands, mergeTools } from "@/extensions/merge.js";
import { ExtensionRunner } from "@/extensions/runner.js";
import type { RegisteredExtension } from "@/extensions/types.js";
import type { Filesystem } from "@/filesystem/filesystem.js";
import type { ScriptExecutor } from "@/script-executor/script-executor.js";
import { buildSessionContext, walkPath } from "@/sessions/build-context.js";
import {
	type CompactionSettings,
	DEFAULT_COMPACTION_SETTINGS,
	prepareCompaction,
	runCompaction,
} from "@/sessions/compaction.js";
import type { CompactionEntry, SessionEntry } from "@/sessions/entries.js";
import type { SessionStore } from "@/sessions/session-store.js";
import { loadProjectSkills } from "@/skills/discovery.js";
import { expandSkillCommand } from "@/skills/invocation.js";
import type { Skill } from "@/skills/skill.js";
import { composeSystemPrompt } from "@/skills/system-prompt.js";
import { createBuiltinTools, toolKindFor } from "@/tools/index.js";
import { BODHI_PI_VERSION } from "@/version.js";
import {
	EXT_DELETE_SESSION,
	EXT_SESSION_CLONE,
	EXT_SESSION_COMPACT,
	EXT_SESSION_ENTRIES,
	EXT_SESSION_FORK,
	EXT_SESSION_NAVIGATE,
	EXT_SESSION_TREE,
	MODEL_CONFIG_ID,
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
	/** Not persisted; reread from config on every load/resume. */
	systemPrompt?: string;
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
}

interface SessionState {
	piAgent: PiAgent;
	currentModelId: string;
	cwd: string;
	tools: AgentTool[];
	/** Discovered once at session hydration; refresh requires `session/close` + `session/load`. */
	commands: PromptTemplate[];
	skills: Skill[];
	/** Set by `cancel()`; read by `prompt()` to return `stopReason: "cancelled"`. Reset before each prompt. */
	cancelled: boolean;
	/** Current head of the session DAG; `null` for a fresh session. Bumped on every entry append. */
	leafId: string | null;
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
	private readonly compactionSettings: CompactionSettings;
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
		this.compactionSettings = { ...DEFAULT_COMPACTION_SETTINGS, ...(config.compaction ?? {}) };
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
			configOptions: [this.buildModelConfigOption(this.config.defaultModelId)],
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
			configOptions: [this.buildModelConfigOption(restored.currentModelId)],
		};
	}

	async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
		await this.ensureExtensionRunner();
		// Per ACP spec: rehydrate without replaying history.
		const restored = await this.rehydrateSession(params.sessionId, params.cwd);
		await this.advertiseSlashable(params.sessionId);
		await this.events.emitSessionStart({
			type: "session_start",
			sessionId: params.sessionId,
			cwd: params.cwd,
			reason: "resume",
		});
		return {
			configOptions: [this.buildModelConfigOption(restored.currentModelId)],
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
		throw new RequestError(-32601, `Method not found: ${method}`);
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

		await this.config.sessionStore.setLeafId?.(sessionId, targetEntryId);

		const session = this.sessions.get(sessionId);
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
		const preparation = prepareCompaction(path, this.compactionSettings);
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

	private async resolveApiKeyForCompaction(provider: string): Promise<string | undefined> {
		const hostKey = this.config.getApiKey(provider);
		if (hostKey !== undefined) return hostKey;
		const ext = await this.extensionRunner?.resolveProviderKey(provider);
		return ext ?? undefined;
	}

	async setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
		const session = this.sessions.get(params.sessionId);
		if (!session) {
			throw new RequestError(-32602, `unknown session: ${params.sessionId}`);
		}
		if (params.configId !== MODEL_CONFIG_ID) {
			throw new RequestError(-32602, `unknown configId: ${params.configId}`);
		}
		if (typeof params.value !== "string") {
			throw new RequestError(-32602, `model config requires string value, got ${typeof params.value}`);
		}
		const newModel = this.findModel(params.value);
		const previousModelId = session.currentModelId;
		// pi-ai's streamSimple reads state.model per turn, so mutating here
		// routes the next prompt to the new model.
		session.piAgent.state.model = newModel;
		session.currentModelId = params.value;
		await this.appendEntry(params.sessionId, session, {
			type: "model_change",
			id: randomUUID(),
			parentId: session.leafId,
			timestamp: Date.now(),
			provider: newModel.provider,
			modelId: newModel.id,
		});
		await this.events.emitModelSelect({
			type: "model_select",
			sessionId: params.sessionId,
			fromModelId: previousModelId,
			toModelId: params.value,
		});
		return {
			configOptions: [this.buildModelConfigOption(params.value)],
		};
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
		await this._buildSessionState(sessionId, restoredModel, cwd, ctx.messages, leafId);
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
	): Promise<void> {
		const builtinTools = createBuiltinTools({
			filesystem: this.config.filesystem,
			cwd,
			...(this.config.scriptExecutor ? { scriptExecutor: this.config.scriptExecutor } : {}),
		});
		const projectCommands = await loadProjectCommands(this.config.filesystem, cwd);
		const skills = await loadProjectSkills(this.config.filesystem, cwd);
		// Merge extension tools/commands. Builtins + project commands win on collision.
		const tools = this.extensionRunner ? mergeTools(builtinTools, this.extensionRunner.getTools()) : builtinTools;
		const commands = this.extensionRunner
			? mergeCommands(projectCommands, this.extensionRunner.getCommands())
			: projectCommands;
		const composedSystemPrompt = composeSystemPrompt(this.config.systemPrompt, skills);
		const events = this.events;
		const extRunner = this.extensionRunner;
		const hostGetApiKey = this.config.getApiKey;
		const piAgent = new Agent({
			initialState: {
				model,
				...(messages.length > 0 ? { messages } : {}),
				tools,
				...(composedSystemPrompt !== undefined ? { systemPrompt: composedSystemPrompt } : {}),
			},
			getApiKey: async (provider: string) => {
				const hostKey = hostGetApiKey(provider);
				if (hostKey !== undefined) return hostKey;
				if (extRunner) return await extRunner.resolveProviderKey(provider);
				return undefined;
			},
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
		});
		this.sessions.set(sessionId, {
			piAgent,
			currentModelId: model.id,
			cwd,
			tools,
			commands,
			skills,
			cancelled: false,
			leafId,
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
