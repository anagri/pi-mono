import type {
	Agent,
	AuthenticateRequest,
	AuthenticateResponse,
	CancelNotification,
	InitializeRequest,
	InitializeResponse,
	NewSessionRequest,
	NewSessionResponse,
	PromptRequest,
	PromptResponse,
} from "@agentclientprotocol/sdk";
import { RequestError } from "@agentclientprotocol/sdk";

export const AGENT_NAME = "bodhi-pi-ws";
export const AGENT_VERSION = "0.0.1";
export const PROTOCOL_VERSION = 1;

/**
 * Minimal AcpAgent stub for M1: handles `initialize` only.
 * All other methods reject with method-not-found until later milestones wire bodhi-pi.
 */
export class HandshakeAgent implements Agent {
	async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
		return {
			protocolVersion: PROTOCOL_VERSION,
			agentInfo: { name: AGENT_NAME, version: AGENT_VERSION },
			authMethods: [],
			agentCapabilities: {},
		};
	}

	async authenticate(_params: AuthenticateRequest): Promise<AuthenticateResponse | undefined> {
		// Auth happens at WS upgrade-time (subprotocol bearer); ACP authenticate is a no-op.
		return undefined;
	}

	async newSession(_params: NewSessionRequest): Promise<NewSessionResponse> {
		throw RequestError.methodNotFound("session/new");
	}

	async prompt(_params: PromptRequest): Promise<PromptResponse> {
		throw RequestError.methodNotFound("session/prompt");
	}

	async cancel(_params: CancelNotification): Promise<void> {
		// no-op until prompt is wired
	}
}
