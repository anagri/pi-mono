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
import type { AgentMessage, Agent as PiAgent } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import { createAgentSession } from "../core/agent-session.js";
import type { SessionStore } from "../sessions/session-store.js";

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
}

interface SessionState {
	piAgent: PiAgent;
	currentModelId: string;
	cwd: string;
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
		const piAgent = createAgentSession({
			initialState: { model: defaultModel },
			getApiKey: this.config.getApiKey,
		});
		this.sessions.set(record.id, {
			piAgent,
			currentModelId: this.config.defaultModelId,
			cwd: record.cwd,
		});
		return {
			sessionId: record.id,
			configOptions: [this.buildModelConfigOption(this.config.defaultModelId)],
		};
	}

	async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
		const restored = await this.rehydrateSession(params.sessionId, params.cwd);

		// Stream history back via session/update notifications, in order.
		for (const entry of restored.entries) {
			if (entry.type !== "message") continue;
			const role = entry.message.role;
			const text = extractText(entry.message);
			if (!text) continue;
			if (role === "user") {
				await this.conn.sessionUpdate({
					sessionId: params.sessionId,
					update: {
						sessionUpdate: "user_message_chunk",
						content: { type: "text", text },
					},
				});
			} else if (role === "assistant") {
				await this.conn.sessionUpdate({
					sessionId: params.sessionId,
					update: {
						sessionUpdate: "agent_message_chunk",
						content: { type: "text", text },
					},
				});
			}
			// toolResult / tool_call replays land in M3.x when tools exist.
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
				updatedAt: new Date(s.createdAt).toISOString(),
			})),
			nextCursor: result.nextCursor ?? null,
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

		const unsubscribePersist = session.piAgent.subscribe(async (event) => {
			if (event.type !== "message_end") return;
			const role = event.message.role;
			if (role !== "user" && role !== "assistant" && role !== "toolResult") return;
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
			return { stopReason: "end_turn" };
		} finally {
			unsubscribeStream();
			unsubscribePersist();
		}
	}

	async cancel(params: CancelNotification): Promise<void> {
		this.sessions.get(params.sessionId)?.piAgent.abort();
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

		// Recreate pi-agent with restored messages (no tool/custom messages in M2.1).
		const messages: AgentMessage[] = record.entries
			.filter((e): e is Extract<typeof e, { type: "message" }> => e.type === "message")
			.map((e) => e.message);
		const piAgent = createAgentSession({
			initialState: { model: restoredModel, messages },
			getApiKey: this.config.getApiKey,
		});
		this.sessions.set(sessionId, { piAgent, currentModelId: modelId, cwd });
		return { entries: record.entries, currentModelId: modelId };
	}
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
