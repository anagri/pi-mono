import { RequestError } from "@agentclientprotocol/sdk";
import { validateSessionId } from "@/wire/validators.js";
import type { SessionState } from "./session-state.js";
import type { SessionRecord, SessionStore } from "./session-store.js";

export function requireLiveSession(
	sessions: Map<string, SessionState>,
	method: string,
	params: Record<string, unknown>,
): { sessionId: string; session: SessionState } {
	const sessionId = validateSessionId(method, params);
	const session = sessions.get(sessionId);
	if (!session) {
		throw new RequestError(-32602, `session ${sessionId} is not loaded. Call session/load first.`);
	}
	return { sessionId, session };
}

export async function requireSessionRecord(
	sessionStore: SessionStore,
	method: string,
	params: Record<string, unknown>,
): Promise<{ sessionId: string; record: SessionRecord }> {
	const sessionId = validateSessionId(method, params);
	const record = await sessionStore.load(sessionId);
	if (!record) throw new RequestError(-32602, `unknown session: ${sessionId}`);
	return { sessionId, record };
}
