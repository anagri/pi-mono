import {
	type Agent as AcpAgent,
	type AgentSideConnection,
	type AuthenticateRequest,
	type AuthenticateResponse,
	type CancelNotification,
	type InitializeRequest,
	type InitializeResponse,
	type NewSessionRequest,
	type NewSessionResponse,
	type PromptRequest,
	type PromptResponse,
	RequestError,
	type SessionConfigOption,
	type SessionNotification,
	type SetSessionConfigOptionRequest,
	type SetSessionConfigOptionResponse,
} from "@agentclientprotocol/sdk";
import type { Agent as PiAgent } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import { createAgentSession } from "../core/agent-session.js";

const MODEL_CONFIG_ID = "model";

export interface BodhiPiConfig {
	/** Models the host wants to expose. Each entry's id/name drives the ACP option list. */
	models: Model<Api>[];
	/** id of the default model — must be one of models[i].id. */
	defaultModelId: string;
	/** Resolves API key per provider name (e.g., "anthropic", "openai"). */
	getApiKey: (provider: string) => string | undefined;
}

interface SessionState {
	piAgent: PiAgent;
	currentModelId: string;
}

/**
 * Returns the `toAgent` callback expected by `AgentSideConnection`.
 *
 *     const conn = new AgentSideConnection(createBodhiPiAgent(cfg), stream);
 */
export function createBodhiPiAgent(config: BodhiPiConfig) {
	if (!config.models.find((m) => m.id === config.defaultModelId)) {
		throw new Error(`defaultModelId "${config.defaultModelId}" not in models registry`);
	}
	return (conn: AgentSideConnection): AcpAgent => new BodhiPiAcpAgent(config, conn);
}

class BodhiPiAcpAgent implements AcpAgent {
	private sessions = new Map<string, SessionState>();
	private nextId = 0;

	constructor(
		private readonly config: BodhiPiConfig,
		private readonly conn: AgentSideConnection,
	) {}

	async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
		return {
			protocolVersion: 1,
			agentCapabilities: {
				loadSession: false,
				promptCapabilities: { image: false, audio: false, embeddedContext: false },
				mcpCapabilities: { http: false, sse: false },
			},
			authMethods: [],
		};
	}

	async authenticate(_params: AuthenticateRequest): Promise<AuthenticateResponse> {
		return {};
	}

	async newSession(_params: NewSessionRequest): Promise<NewSessionResponse> {
		const sessionId = `bodhi_${++this.nextId}`;
		const defaultModel = this.findModel(this.config.defaultModelId);
		const piAgent = createAgentSession({
			initialState: { model: defaultModel },
			getApiKey: this.config.getApiKey,
		});
		this.sessions.set(sessionId, {
			piAgent,
			currentModelId: this.config.defaultModelId,
		});
		return {
			sessionId,
			configOptions: [this.buildModelConfigOption(this.config.defaultModelId)],
		};
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
		return {
			configOptions: [this.buildModelConfigOption(params.value)],
		};
	}

	async prompt(params: PromptRequest): Promise<PromptResponse> {
		const session = this.sessions.get(params.sessionId);
		if (!session) throw new Error(`unknown session: ${params.sessionId}`);

		const text = params.prompt
			.filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
			.map((b) => b.text)
			.join("");

		const unsubscribe = session.piAgent.subscribe(async (event) => {
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

		try {
			await session.piAgent.prompt(text);
			await session.piAgent.waitForIdle();
			return { stopReason: "end_turn" };
		} finally {
			unsubscribe();
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
}
