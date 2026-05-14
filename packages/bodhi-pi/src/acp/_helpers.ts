import { RequestError } from "@agentclientprotocol/sdk";
import type { SessionRecord, SessionStore } from "@/sessions/session-store.js";
import { validateSessionId } from "@/wire/validators.js";
import type { SessionState } from "./session-state.js";

/**
 * Session-store bridge methods. Held by the agent and threaded into each domain service.
 * Commit 2 deletes this class once the agent resolves sessions at the dispatch boundary.
 */
export class AgentHelpers {
	constructor(
		private readonly sessions: Map<string, SessionState>,
		private readonly sessionStore: SessionStore,
	) {}

	requireSession(method: string, params: Record<string, unknown>): SessionState {
		const sessionId = validateSessionId(method, params);
		const session = this.sessions.get(sessionId);
		if (!session) {
			throw new RequestError(-32602, `session ${sessionId} is not loaded. Call session/load first.`);
		}
		return session;
	}

	async requireSessionRecord(
		method: string,
		params: Record<string, unknown>,
	): Promise<{ sessionId: string; record: SessionRecord }> {
		const sessionId = validateSessionId(method, params);
		const record = await this.sessionStore.load(sessionId);
		if (!record) throw new RequestError(-32602, `unknown session: ${sessionId}`);
		return { sessionId, record };
	}
}
