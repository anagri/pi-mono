import { randomUUID } from "node:crypto";
import {
	type Agent as AcpAgent,
	type AgentSideConnection,
	type AuthenticateRequest,
	type AuthenticateResponse,
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
	type SessionNotification,
	type SetSessionConfigOptionRequest,
	type SetSessionConfigOptionResponse,
} from "@agentclientprotocol/sdk";
import type { AgentMessage, AgentTool, Agent as PiAgent } from "@mariozechner/pi-agent-core";
import type { Api, Model, StopReason as PiStopReason } from "@mariozechner/pi-ai";
import { createAgentSession } from "../core/agent-session.js";
import type { Filesystem } from "../filesystem/filesystem.js";
import type { SessionStore } from "../sessions/session-store.js";
import { createBuiltinTools, toolKindFor } from "../tools/index.js";
import { BODHI_PI_VERSION } from "../version.js";

type AcpStopReason = PromptResponse["stopReason"];

const MODEL_CONFIG_ID = "model";
const EXT_DELETE_SESSION = "_bodhi-pi/session/delete";

export interface BodhiPiConfig {
	/** Models the host wants to expose. Each entry's id/name drives the ACP option list. */
	models: Model<Api>[];
	/** id of the default model — must be one of models[i].id. */
	defaultModelId: string;
	/** Resolves API key per provider name (e.g., "anthropic", "openai"). */
	getApiKey: (provider: string) => string | undefined;
	/** Persistence store. Mandatory; no default fallback. */
	sessionStore: SessionStore;
	/** Filesystem the agent uses for read/write/edit/ls/find/grep. Mandatory; no default fallback. */
	filesystem: Filesystem;
}

interface SessionState {
	piAgent: PiAgent;
	currentModelId: string;
	cwd: string;
	tools: AgentTool[];
	/** Set by `cancel()`; read by `prompt()` to return `stopReason: "cancelled"`. Reset before each prompt. */
	cancelled: boolean;
}

/**
 * Returns the `toAgent` callback expected by `AgentSideConnection`.
 *
 *     const conn = new AgentSideConnection(createBodhiPiAgent(cfg), stream);
 */
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
		const tools = createBuiltinTools({ filesystem: this.config.filesystem, cwd: record.cwd });
		const piAgent = createAgentSession({
			initialState: { model: defaultModel, tools },
			getApiKey: this.config.getApiKey,
		});
		this.sessions.set(record.id, {
			piAgent,
			currentModelId: this.config.defaultModelId,
			cwd: record.cwd,
			tools,
			cancelled: false,
		});
		return {
			sessionId: record.id,
			configOptions: [this.buildModelConfigOption(this.config.defaultModelId)],
		};
	}

	async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
		const restored = await this.rehydrateSession(params.sessionId, params.cwd);

		// Stream history back via session/update notifications, in order.
		// For each persisted message we emit text chunks AND replay any tool calls /
		// tool results found in its content blocks.
		const toolResultsById = new Map<string, ToolResultMessageLike>();
		for (const entry of restored.entries) {
			if (entry.type !== "message") continue;
			if (entry.message.role === "toolResult") {
				const tr = entry.message as ToolResultMessageLike;
				toolResultsById.set(tr.toolCallId, tr);
			}
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
				// Replay tool_use blocks from this assistant message paired with the
				// corresponding toolResult (if persisted).
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
					const result = toolResultsById.get(toolCall.id);
					if (result) {
						await this.conn.sessionUpdate({
							sessionId: params.sessionId,
							update: {
								sessionUpdate: "tool_call_update",
								toolCallId: toolCall.id,
								status: result.isError ? "failed" : "completed",
								content: toolResultContentForAcp(result),
							},
						});
					}
				}
			}
		}

		return {
			configOptions: [this.buildModelConfigOption(restored.currentModelId)],
		};
	}

	async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
		// Same rehydration as loadSession, but no history replay (per ACP spec).
		const restored = await this.rehydrateSession(params.sessionId, params.cwd);
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
		// Per ACP session/close RFD: cancel any ongoing work + free runtime resources.
		// The persisted record stays in the store for future session/load.
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
		// Mutate the pi-agent's active model. pi-ai's streamSimple reads
		// state.model per turn, so the next prompt routes here.
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

		// Reset cancel flag at the start of every prompt so a previous cancel doesn't bleed in.
		session.cancelled = false;
		let lastAssistantStopReason: PiStopReason | undefined;
		let lastAssistantErrorMessage: string | undefined;

		const unsubscribeStream = session.piAgent.subscribe(async (event) => {
			if (event.type !== "message_update") return;
			const sub = event.assistantMessageEvent;
			if (sub.type !== "text_delta") return;
			const update: SessionNotification = {
				sessionId: params.sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: sub.delta },
				},
			};
			await this.conn.sessionUpdate(update);
		});

		const unsubscribeTools = session.piAgent.subscribe(async (event) => {
			if (event.type === "tool_execution_start") {
				await this.conn.sessionUpdate({
					sessionId: params.sessionId,
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
			if (event.type === "tool_execution_end") {
				const resultContent = Array.isArray(event.result?.content) ? event.result.content : [];
				await this.conn.sessionUpdate({
					sessionId: params.sessionId,
					update: {
						sessionUpdate: "tool_call_update",
						toolCallId: event.toolCallId,
						status: event.isError ? "failed" : "completed",
						content: agentToolContentForAcp(resultContent),
					},
				});
			}
		});

		const unsubscribePersist = session.piAgent.subscribe(async (event) => {
			if (event.type !== "message_end") return;
			const role = event.message.role;
			if (role !== "user" && role !== "assistant" && role !== "toolResult") return;
			if (role === "assistant") {
				const msg = event.message as { stopReason?: PiStopReason; errorMessage?: string };
				lastAssistantStopReason = msg.stopReason;
				lastAssistantErrorMessage = msg.errorMessage;
			}
			await this.config.sessionStore.append(params.sessionId, {
				type: "message",
				id: randomUUID(),
				timestamp: Date.now(),
				message: event.message,
			});
		});

		try {
			await session.piAgent.prompt(text);
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
			unsubscribeStream();
			unsubscribeTools();
			unsubscribePersist();
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

		// Restore latest model from history; fall back to default.
		const lastModelChange = [...record.entries].reverse().find((e) => e.type === "model_change");
		const modelId = lastModelChange?.modelId ?? this.config.defaultModelId;
		const restoredModel = this.findModel(modelId);

		// Recreate pi-agent with restored messages and a fresh tool-set bound to cwd.
		const messages: AgentMessage[] = record.entries
			.filter((e): e is Extract<typeof e, { type: "message" }> => e.type === "message")
			.map((e) => e.message);
		const tools = createBuiltinTools({ filesystem: this.config.filesystem, cwd });
		const piAgent = createAgentSession({
			initialState: { model: restoredModel, messages, tools },
			getApiKey: this.config.getApiKey,
		});
		this.sessions.set(sessionId, { piAgent, currentModelId: modelId, cwd, tools, cancelled: false });
		return { entries: record.entries, currentModelId: modelId };
	}
}

/** Minimal shape of pi-ai's `ToolResultMessage` we need for ACP replay. */
interface ToolResultMessageLike {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	isError: boolean;
}

interface ToolCallBlock {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

/** Pull plain-text payload from an AgentMessage for ACP replay chunks. */
function extractText(message: AgentMessage): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c): c is { type: "text"; text: string } => {
			return typeof c === "object" && c !== null && (c as { type?: unknown }).type === "text";
		})
		.map((c) => c.text)
		.join("");
}

/** Pull tool-call blocks from an assistant `AgentMessage`. */
function extractToolCalls(message: AgentMessage): ToolCallBlock[] {
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return [];
	const out: ToolCallBlock[] = [];
	for (const c of content) {
		if (typeof c !== "object" || c === null) continue;
		const block = c as { type?: unknown; id?: unknown; name?: unknown; arguments?: unknown };
		if (block.type !== "toolCall") continue;
		if (typeof block.id !== "string" || typeof block.name !== "string") continue;
		const args = (block.arguments && typeof block.arguments === "object" ? block.arguments : {}) as Record<
			string,
			unknown
		>;
		out.push({ id: block.id, name: block.name, arguments: args });
	}
	return out;
}

/** Convert a pi-ai `ToolResultMessage.content` array into an ACP `ToolCallContent` array. */
function toolResultContentForAcp(result: ToolResultMessageLike): ToolCallContentBlock[] {
	return agentToolContentForAcp(result.content);
}

interface ToolCallContentBlock {
	type: "content";
	content: { type: "text"; text: string };
}

function agentToolContentForAcp(blocks: Array<{ type: string; text?: string }>): ToolCallContentBlock[] {
	const text = blocks
		.filter((b) => b.type === "text" && typeof b.text === "string")
		.map((b) => b.text as string)
		.join("");
	if (!text) return [];
	return [{ type: "content", content: { type: "text", text } }];
}

/** Heuristic: pull a "path" string out of validated tool args for the ACP `title` hint. */
function formatLocationHint(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const path = (args as { path?: unknown }).path;
	return typeof path === "string" ? path : "";
}

/**
 * Map pi-agent-core's `StopReason` to ACP's `stopReason` enum.
 *
 *   - `"aborted"` → `"cancelled"`
 *   - `"length"` → `"max_tokens"`
 *   - `"stop"` / `"toolUse"` → `"end_turn"`
 *   - `"error"` is handled separately by the caller (throws `RequestError`).
 *   - undefined falls back to `"end_turn"`.
 */
function mapStopReason(sr: PiStopReason | undefined): AcpStopReason {
	switch (sr) {
		case "aborted":
			return "cancelled";
		case "length":
			return "max_tokens";
		case "stop":
		case "toolUse":
			return "end_turn";
		default:
			return "end_turn";
	}
}
