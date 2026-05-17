import { type AgentSideConnection, RequestError } from "@agentclientprotocol/sdk";
import { randomUUID } from "@/_internal/uuid.js";
import { walkPath } from "@/sessions/build-context.js";
import type { SessionEntry } from "@/sessions/entries.js";
import { requireLiveSession, requireSessionRecord } from "@/sessions/resolution.js";
import type { SessionState } from "@/sessions/session-state.js";
import type { SessionStore } from "@/sessions/session-store.js";
import { EXT_SESSION_CONFIG, EXT_SESSION_EXPORT, EXT_SESSION_SET_NAME, EXT_SESSION_STATS } from "@/wire/constants.js";
import { validateSessionId } from "@/wire/validators.js";

type ExtHandler = (params: Record<string, unknown>) => Promise<Record<string, unknown>>;

export type AppendEntry = (sessionId: string, session: SessionState, entry: SessionEntry) => Promise<void>;

export interface SessionInfoServiceDeps {
	sessions: Map<string, SessionState>;
	sessionStore: SessionStore;
	conn: AgentSideConnection;
	appendEntry: AppendEntry;
	getDefaultModelId: () => string | undefined;
}

export class SessionInfoService {
	private readonly sessions: Map<string, SessionState>;
	private readonly sessionStore: SessionStore;
	private readonly conn: AgentSideConnection;
	private readonly appendEntry: AppendEntry;
	private readonly getDefaultModelId: () => string | undefined;

	constructor(deps: SessionInfoServiceDeps) {
		this.sessions = deps.sessions;
		this.sessionStore = deps.sessionStore;
		this.conn = deps.conn;
		this.appendEntry = deps.appendEntry;
		this.getDefaultModelId = deps.getDefaultModelId;
	}

	register(): Array<[string, ExtHandler]> {
		return [
			[EXT_SESSION_CONFIG, this.handleSessionConfig.bind(this)],
			[EXT_SESSION_SET_NAME, this.handleSessionSetName.bind(this)],
			[EXT_SESSION_STATS, this.handleSessionStats.bind(this)],
			[EXT_SESSION_EXPORT, this.handleSessionExport.bind(this)],
		];
	}

	async emitSessionInfoUpdate(sessionId: string, title: string | null, updatedAt: string | null): Promise<void> {
		await this.conn.sessionUpdate({
			sessionId,
			update: { sessionUpdate: "session_info_update", title, updatedAt },
		});
	}

	private async handleSessionConfig(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const { sessionId, session } = requireLiveSession(this.sessions, EXT_SESSION_CONFIG, params);
		return {
			sessionId,
			cwd: session.cwd,
			defaultModelId: this.getDefaultModelId() ?? null,
			currentModelId: session.runtime.currentModelId,
			thinkingLevel: session.runtime.thinkingLevel,
			retryOptions: { ...session.retryOptions },
			compaction: { ...session.compaction },
			appendSystemPrompt: session.appendSystemPrompt,
			contextFilePaths: session.contextFiles.map((f) => f.path),
			...(session.settings.globalSettingsParseError !== undefined
				? { globalSettingsParseError: session.settings.globalSettingsParseError }
				: {}),
			...(session.settings.projectSettingsParseError !== undefined
				? { projectSettingsParseError: session.settings.projectSettingsParseError }
				: {}),
		};
	}

	private async handleSessionSetName(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const sessionId = validateSessionId(EXT_SESSION_SET_NAME, params);
		const name = params.name;
		if (typeof name !== "string") {
			throw new RequestError(-32602, `${EXT_SESSION_SET_NAME}: name must be a string`);
		}
		const session = this.sessions.get(sessionId);
		if (!session) {
			throw new RequestError(-32602, `session ${sessionId} is not loaded. Call session/load first.`);
		}
		const timestamp = Date.now();
		await this.appendEntry(sessionId, session, {
			type: "session_info",
			id: randomUUID(),
			parentId: session.runtime.leafId,
			timestamp,
			name,
		});
		await this.emitSessionInfoUpdate(sessionId, name, new Date(timestamp).toISOString());
		return { ok: true, name };
	}

	private async handleSessionStats(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const { record } = await requireSessionRecord(this.sessionStore, EXT_SESSION_STATS, params);
		const path = walkPath(record.entries, record.leafId ?? null);
		let messageCount = 0;
		let toolCallCount = 0;
		let name: string | undefined;
		for (const entry of path) {
			if (entry.type === "message") {
				const role = entry.message.role;
				if (role === "user" || role === "assistant") messageCount++;
				if (role === "assistant") {
					for (const block of entry.message.content) {
						if (block.type === "toolCall") toolCallCount++;
					}
				}
			} else if (entry.type === "session_info" && entry.name !== undefined) {
				name = entry.name;
			}
		}
		const leafId = record.leafId ?? record.entries[record.entries.length - 1]?.id ?? null;
		return {
			messageCount,
			toolCallCount,
			leafId,
			...(name !== undefined ? { name } : {}),
		};
	}

	private async handleSessionExport(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const { record } = await requireSessionRecord(this.sessionStore, EXT_SESSION_EXPORT, params);
		const path = walkPath(record.entries, record.leafId ?? null);
		const lines: string[] = [
			JSON.stringify({
				type: "session",
				version: 1,
				id: record.id,
				cwd: record.cwd,
				createdAt: record.createdAt,
				...(record.parentSessionId !== undefined ? { parentSessionId: record.parentSessionId } : {}),
			}),
		];
		for (const entry of path) lines.push(JSON.stringify(entry));
		return { format: "jsonl", content: lines.join("\n") };
	}
}
