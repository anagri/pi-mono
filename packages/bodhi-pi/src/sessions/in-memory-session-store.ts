import { randomUUID } from "node:crypto";
import type {
	ListSessionsRequest,
	ListSessionsResult,
	SessionEntry,
	SessionRecord,
	SessionStore,
} from "./session-store.js";

/**
 * Reference in-memory implementation of SessionStore.
 *
 * Tests use this directly. Production hosts wanting ephemeral mode can import
 * it; they still must pass it explicitly via BodhiPiConfig.sessionStore — there
 * is no silent default fallback at the agent factory.
 */
export function createInMemorySessionStore(): SessionStore {
	const sessions = new Map<string, SessionRecord>();

	return {
		async create({ cwd }) {
			const now = Date.now();
			const record: SessionRecord = {
				id: randomUUID(),
				cwd,
				createdAt: now,
				updatedAt: now,
				entries: [],
			};
			sessions.set(record.id, record);
			return structuredClone(record);
		},

		async load(sessionId) {
			const record = sessions.get(sessionId);
			return record ? structuredClone(record) : undefined;
		},

		async append(sessionId: string, entry: SessionEntry) {
			const record = sessions.get(sessionId);
			if (!record) throw new Error(`session ${sessionId} not found (or deleted)`);
			record.entries.push(entry);
			record.updatedAt = Date.now();
		},

		async list({ cwd }: ListSessionsRequest): Promise<ListSessionsResult> {
			// Single-page in-memory store; cursor is ignored. Disk-backed impls
			// must honour `cursor` per the SessionStore.list JSDoc contract.
			const all = [...sessions.values()]
				.filter((r) => (cwd ? r.cwd === cwd : true))
				.sort((a, b) => b.updatedAt - a.updatedAt)
				.map((r) => ({
					sessionId: r.id,
					cwd: r.cwd,
					createdAt: r.createdAt,
					updatedAt: r.updatedAt,
					messageCount: r.entries.filter((e) => e.type === "message").length,
				}));
			return { sessions: all };
		},

		async delete(sessionId) {
			sessions.delete(sessionId);
		},
	};
}
