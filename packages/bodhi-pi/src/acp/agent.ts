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
import { Agent, type AgentMessage, type AgentTool, type Agent as PiAgent } from "@mariozechner/pi-agent-core";
import type { Api, Model, StopReason as PiStopReason } from "@mariozechner/pi-ai";
import { loadProjectCommands } from "../commands/discovery.js";
import { expandPromptTemplate, type PromptTemplate } from "../commands/prompt-templates.js";
import type { Filesystem } from "../filesystem/filesystem.js";
import type { ScriptExecutor } from "../script-executor/script-executor.js";
import type { SessionStore } from "../sessions/session-store.js";
import { loadProjectSkills } from "../skills/discovery.js";
import { expandSkillCommand } from "../skills/invocation.js";
import type { Skill } from "../skills/skill.js";
import { composeSystemPrompt } from "../skills/system-prompt.js";
import { createBuiltinTools, toolKindFor } from "../tools/index.js";
import { BODHI_PI_VERSION } from "../version.js";
import { EXT_DELETE_SESSION, MODEL_CONFIG_ID } from "./constants.js";
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

	constructor(
		private readonly config: BodhiPiConfig,
		private readonly conn: AgentSideConnection,
	) {}

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
					"bodhi-pi": { sessionDelete: true },
				},
			},
			authMethods: [],
		};
	}

	async authenticate(_params: AuthenticateRequest): Promise<AuthenticateResponse> {
		return {};
	}

	async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
		const record = await this.config.sessionStore.create({ cwd: params.cwd });
		const defaultModel = this.findModel(this.config.defaultModelId);
		await this._buildSessionState(record.id, defaultModel, record.cwd);
		await this.advertiseSlashable(record.id);
		return {
			sessionId: record.id,
			configOptions: [this.buildModelConfigOption(this.config.defaultModelId)],
		};
	}

	async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
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
		return {
			configOptions: [this.buildModelConfigOption(restored.currentModelId)],
		};
	}

	async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
		// Per ACP spec: rehydrate without replaying history.
		const restored = await this.rehydrateSession(params.sessionId, params.cwd);
		await this.advertiseSlashable(params.sessionId);
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
			return {};
		}
		throw new RequestError(-32601, `Method not found: ${method}`);
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
		// pi-ai's streamSimple reads state.model per turn, so mutating here
		// routes the next prompt to the new model.
		session.piAgent.state.model = newModel;
		session.currentModelId = params.value;
		await this.config.sessionStore.append(params.sessionId, {
			type: "model_change",
			id: randomUUID(),
			timestamp: Date.now(),
			provider: newModel.provider,
			modelId: newModel.id,
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
		const promptText = expandPromptTemplate(expandSkillCommand(text, session.skills), session.commands);

		// Reset so a prior cancel doesn't bleed into this prompt.
		session.cancelled = false;
		let lastAssistantStopReason: PiStopReason | undefined;
		let lastAssistantErrorMessage: string | undefined;

		const sessionId = params.sessionId;
		const conn = this.conn;
		const store = this.config.sessionStore;

		const unsubscribe = session.piAgent.subscribe(async (event) => {
			switch (event.type) {
				case "message_update": {
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
				case "tool_execution_end": {
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
					const role = event.message.role;
					if (role !== "user" && role !== "assistant" && role !== "toolResult") return;
					if (role === "assistant") {
						const msg = event.message as { stopReason?: PiStopReason; errorMessage?: string };
						lastAssistantStopReason = msg.stopReason;
						lastAssistantErrorMessage = msg.errorMessage;
					}
					await store.append(sessionId, {
						type: "message",
						id: randomUUID(),
						timestamp: Date.now(),
						message: event.message,
					});
					return;
				}
			}
		});

		try {
			await session.piAgent.prompt(promptText);
			await session.piAgent.waitForIdle();
			if (session.cancelled) {
				return { stopReason: "cancelled", userMessageId: params.messageId ?? null };
			}
			if (lastAssistantStopReason === "error") {
				throw new RequestError(-32603, lastAssistantErrorMessage ?? "model error");
			}
			const stopReason = mapStopReason(lastAssistantStopReason);
			return { stopReason, userMessageId: params.messageId ?? null };
		} finally {
			unsubscribe();
		}
	}

	async cancel(params: CancelNotification): Promise<void> {
		const session = this.sessions.get(params.sessionId);
		if (!session) return;
		session.cancelled = true;
		session.piAgent.abort();
	}

	private findModel(id: string): Model<Api> {
		const m = this.config.models.find((x) => x.id === id);
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
			options: this.config.models.map((m) => ({
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

		const lastModelChange = [...record.entries].reverse().find((e) => e.type === "model_change");
		const modelId = lastModelChange?.modelId ?? this.config.defaultModelId;
		const restoredModel = this.findModel(modelId);

		const messages: AgentMessage[] = record.entries
			.filter((e): e is Extract<typeof e, { type: "message" }> => e.type === "message")
			.map((e) => e.message);
		await this._buildSessionState(sessionId, restoredModel, cwd, messages);
		return { entries: record.entries, currentModelId: modelId };
	}

	// Skills must load before Agent construction so the composed systemPrompt
	// (base + <available_skills>) is in the initial state.
	private async _buildSessionState(
		sessionId: string,
		model: Model<Api>,
		cwd: string,
		messages: AgentMessage[] = [],
	): Promise<void> {
		const tools = createBuiltinTools({
			filesystem: this.config.filesystem,
			cwd,
			...(this.config.scriptExecutor ? { scriptExecutor: this.config.scriptExecutor } : {}),
		});
		const commands = await loadProjectCommands(this.config.filesystem, cwd);
		const skills = await loadProjectSkills(this.config.filesystem, cwd);
		const composedSystemPrompt = composeSystemPrompt(this.config.systemPrompt, skills);
		const piAgent = new Agent({
			initialState: {
				model,
				...(messages.length > 0 ? { messages } : {}),
				tools,
				...(composedSystemPrompt !== undefined ? { systemPrompt: composedSystemPrompt } : {}),
			},
			getApiKey: this.config.getApiKey,
		});
		this.sessions.set(sessionId, {
			piAgent,
			currentModelId: model.id,
			cwd,
			tools,
			commands,
			skills,
			cancelled: false,
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
