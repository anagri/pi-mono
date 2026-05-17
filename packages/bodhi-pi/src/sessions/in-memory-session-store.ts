import { randomUUID } from "@/_internal/uuid.js";
import { walkPath } from "./build-context.js";
import type {
	ExtensionEntry,
	ListSessionsRequest,
	ListSessionsResult,
	ReadExtensionEntriesFilter,
	SessionEntry,
	SessionRecord,
	SessionStore,
} from "./session-store.js";

/**
 * In-memory reference SessionStore.
 *
 * Tests use this directly. Production hosts wanting ephemeral mode can import
 * it; they still must pass it explicitly via BodhiPiConfig.sessionStore — there
 * is no silent default fallback at the agent factory.
 */
export function createInMemorySessionStore(): SessionStore {
	const sessions = new Map<string, SessionRecord>();

	return {
		async create({ cwd, parentSessionId }) {
			const now = Date.now();
			const record: SessionRecord = {
				id: randomUUID(),
				cwd,
				createdAt: now,
				updatedAt: now,
				leafId: null,
				...(parentSessionId !== undefined ? { parentSessionId } : {}),
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

		async setLeafId(sessionId: string, entryId: string | null) {
			const record = sessions.get(sessionId);
			if (!record) throw new Error(`session ${sessionId} not found (or deleted)`);
			record.leafId = entryId;
			record.updatedAt = Date.now();
		},

		async forkRecord(sourceSessionId: string, fromEntryId: string, position: "before" | "at") {
			const source = sessions.get(sourceSessionId);
			if (!source) throw new Error(`session ${sourceSessionId} not found (or deleted)`);
			if (!source.entries.some((e) => e.id === fromEntryId)) {
				throw new Error(`entry ${fromEntryId} not found in session ${sourceSessionId}`);
			}
			const chain = walkPath(source.entries, fromEntryId);
			const copied = position === "before" ? chain.slice(0, -1) : chain;
			const now = Date.now();
			const newRecord: SessionRecord = {
				id: randomUUID(),
				cwd: source.cwd,
				createdAt: now,
				updatedAt: now,
				parentSessionId: sourceSessionId,
				leafId: copied.length > 0 ? copied[copied.length - 1].id : null,
				entries: structuredClone(copied),
			};
			sessions.set(newRecord.id, newRecord);
			return { newSessionId: newRecord.id };
		},

		async list({ cwd }: ListSessionsRequest): Promise<ListSessionsResult> {
			// Single-page in-memory store; cursor is ignored. Disk-backed impls
			// must honour `cursor` per the SessionStore.list JSDoc contract.
			const all = [...sessions.values()]
				.filter((r) => (cwd ? r.cwd === cwd : true))
				.sort((a, b) => b.updatedAt - a.updatedAt)
				.map((r) => {
					const latestName = [...r.entries]
						.reverse()
						.find((e): e is Extract<SessionEntry, { type: "session_info" }> => e.type === "session_info")?.name;
					return {
						sessionId: r.id,
						cwd: r.cwd,
						createdAt: r.createdAt,
						updatedAt: r.updatedAt,
						messageCount: r.entries.filter((e) => e.type === "message").length,
						...(latestName !== undefined ? { name: latestName } : {}),
						...(r.parentSessionId !== undefined ? { parentSessionId: r.parentSessionId } : {}),
					};
				});
			return { sessions: all };
		},

		async delete(sessionId) {
			sessions.delete(sessionId);
		},

		async readExtensionEntries(sessionId: string, filter?: ReadExtensionEntriesFilter): Promise<ExtensionEntry[]> {
			const record = sessions.get(sessionId);
			if (!record) return [];
			const all = record.entries.filter((e): e is ExtensionEntry => e.type === "extension");
			const matched = all.filter((e) => {
				if (filter?.extensionName !== undefined && e.extensionName !== filter.extensionName) return false;
				if (filter?.customType !== undefined && e.customType !== filter.customType) return false;
				return true;
			});
			return structuredClone(matched);
		},
	};
}
