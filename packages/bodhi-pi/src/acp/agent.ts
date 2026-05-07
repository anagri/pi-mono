import type {
	Agent as AcpAgent,
	AgentSideConnection,
	AuthenticateRequest,
	AuthenticateResponse,
	CancelNotification,
	InitializeRequest,
	InitializeResponse,
	NewSessionRequest,
	NewSessionResponse,
	PromptRequest,
	PromptResponse,
	SessionNotification,
} from "@agentclientprotocol/sdk";
import type { Agent as PiAgent } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import { createAgentSession } from "../core/agent-session.js";

export interface BodhiPiConfig {
	/** Model used for every session created by this agent factory. */
	model: Model<Api>;
	/** Resolves API key per provider name (e.g., "anthropic", "openai"). */
	getApiKey: (provider: string) => string | undefined;
}

/**
 * Returns the `toAgent` callback expected by `AgentSideConnection`.
 *
 *     const conn = new AgentSideConnection(createBodhiPiAgent(cfg), stream);
 */
export function createBodhiPiAgent(config: BodhiPiConfig) {
	return (conn: AgentSideConnection): AcpAgent => new BodhiPiAcpAgent(config, conn);
}

class BodhiPiAcpAgent implements AcpAgent {
	private sessions = new Map<string, PiAgent>();
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
		// No auth methods advertised in M1.2 — should never be called.
		return {};
	}

	async newSession(_params: NewSessionRequest): Promise<NewSessionResponse> {
		const sessionId = `bodhi_${++this.nextId}`;
		const piAgent = createAgentSession({
			initialState: { model: this.config.model },
			getApiKey: this.config.getApiKey,
		});
		this.sessions.set(sessionId, piAgent);
		return { sessionId };
	}

	async prompt(params: PromptRequest): Promise<PromptResponse> {
		const session = this.sessions.get(params.sessionId);
		if (!session) throw new Error(`unknown session: ${params.sessionId}`);

		// M1.2: text-only prompts. Image / audio / embedded resources land later.
		const text = params.prompt
			.filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
			.map((b) => b.text)
			.join("");

		// Forward pi-agent-core text deltas as ACP agent_message_chunk notifications.
		const unsubscribe = session.subscribe(async (event) => {
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
			await session.prompt(text);
			await session.waitForIdle();
			return { stopReason: "end_turn" };
		} finally {
			unsubscribe();
		}
	}

	async cancel(params: CancelNotification): Promise<void> {
		this.sessions.get(params.sessionId)?.abort();
	}
}
