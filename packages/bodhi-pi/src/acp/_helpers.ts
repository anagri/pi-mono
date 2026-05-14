import { RequestError } from "@agentclientprotocol/sdk";
import type { SessionRecord, SessionStore } from "@/sessions/session-store.js";
import type { SessionState } from "./session-state.js";

/**
 * Shared validation helpers used by `BodhiPiAcpAgent` and every domain service. Constructed
 * once in the agent's constructor with the live `sessions` Map + `sessionStore` references and
 * passed through to services via the dependency bag.
 */
export class AgentHelpers {
	constructor(
		private readonly sessions: Map<string, SessionState>,
		private readonly sessionStore: SessionStore,
	) {}

	validateSessionId(method: string, params: Record<string, unknown>): string {
		const sessionId = params.sessionId;
		if (typeof sessionId !== "string") {
			throw new RequestError(-32602, `${method}: sessionId must be a string`);
		}
		return sessionId;
	}

	/** For handlers that don't require a sessionId; off-session ext calls (e.g. KV auth writes) pass it through opportunistically. */
	optionalSessionId(params: Record<string, unknown>): string | undefined {
		const sessionId = params.sessionId;
		return typeof sessionId === "string" ? sessionId : undefined;
	}

	requireSession(method: string, params: Record<string, unknown>): SessionState {
		const sessionId = this.validateSessionId(method, params);
		const session = this.sessions.get(sessionId);
		if (!session) {
			throw new RequestError(-32602, `session ${sessionId} is not loaded. Call session/load first.`);
		}
		return session;
	}

	/** For handlers that load fresh from the store rather than the live runtime map. */
	async requireSessionRecord(
		method: string,
		params: Record<string, unknown>,
	): Promise<{ sessionId: string; record: SessionRecord }> {
		const sessionId = this.validateSessionId(method, params);
		const record = await this.sessionStore.load(sessionId);
		if (!record) throw new RequestError(-32602, `unknown session: ${sessionId}`);
		return { sessionId, record };
	}

	/** Throws `-32602` when `params[key]` is missing, not a string, or empty. */
	requireStringParam(method: string, params: Record<string, unknown>, key: string): string {
		const value = params[key];
		if (typeof value !== "string" || value.length === 0) {
			throw new RequestError(-32602, `${method}: ${key} must be a non-empty string`);
		}
		return value;
	}
}
