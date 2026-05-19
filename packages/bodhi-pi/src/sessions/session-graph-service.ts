import { RequestError } from "@agentclientprotocol/sdk";
import type { EventDispatcher } from "@/events/dispatcher.js";
import { createEvent } from "@/events/factory.js";
import {
	EXT_SESSION_CLONE,
	EXT_SESSION_ENTRIES,
	EXT_SESSION_FORK,
	EXT_SESSION_NAVIGATE,
	EXT_SESSION_TREE,
} from "@/wire/constants.js";
import { extractText } from "./_shared.js";
import { buildSessionContext, walkPath } from "./build-context.js";
import type { CompactionOrchestrator } from "./compaction-orchestrator.js";
import { requireSessionRecord } from "./resolution.js";
import type { SessionState } from "./session-state.js";
import type { SessionStore } from "./session-store.js";

type ExtHandler = (params: Record<string, unknown>) => Promise<Record<string, unknown>>;

export interface SessionGraphServiceDeps {
	sessions: Map<string, SessionState>;
	sessionStore: SessionStore;
	events: EventDispatcher;
	compactionOrchestrator: CompactionOrchestrator;
}

export class SessionGraphService {
	private readonly sessions: Map<string, SessionState>;
	private readonly sessionStore: SessionStore;
	private readonly events: EventDispatcher;
	private readonly compactionOrchestrator: CompactionOrchestrator;

	constructor(deps: SessionGraphServiceDeps) {
		this.sessions = deps.sessions;
		this.sessionStore = deps.sessionStore;
		this.events = deps.events;
		this.compactionOrchestrator = deps.compactionOrchestrator;
	}

	register(): Array<[string, ExtHandler]> {
		return [
			[EXT_SESSION_TREE, this.handleSessionTree.bind(this)],
			[EXT_SESSION_NAVIGATE, this.handleSessionNavigate.bind(this)],
			[EXT_SESSION_ENTRIES, this.handleSessionEntries.bind(this)],
			[EXT_SESSION_FORK, this.handleSessionFork.bind(this)],
			[EXT_SESSION_CLONE, this.handleSessionClone.bind(this)],
		];
	}

	private async handleSessionTree(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const { record } = await requireSessionRecord(this.sessionStore, EXT_SESSION_TREE, params);
		const childCount = new Map<string, number>();
		for (const entry of record.entries) {
			if (entry.parentId) childCount.set(entry.parentId, (childCount.get(entry.parentId) ?? 0) + 1);
		}
		const leafId = record.leafId ?? record.entries[record.entries.length - 1]?.id ?? null;
		const nodes = record.entries.map((entry) => {
			let preview = "";
			let role: string | undefined;
			if (entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant")) {
				role = entry.message.role;
				const text = extractText(entry.message).trim();
				preview = text.length > 60 ? `${text.slice(0, 60)}…` : text;
			}
			return {
				id: entry.id,
				parentId: entry.parentId ?? null,
				type: entry.type,
				...(role ? { role } : {}),
				...(preview ? { preview } : {}),
				isLeaf: entry.id === leafId,
				childCount: childCount.get(entry.id) ?? 0,
			};
		});
		return { leafId, nodes };
	}

	private async handleSessionNavigate(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const { sessionId, record } = await requireSessionRecord(this.sessionStore, EXT_SESSION_NAVIGATE, params);
		const targetEntryId = params.targetEntryId;
		if (typeof targetEntryId !== "string") {
			throw new RequestError(-32602, `${EXT_SESSION_NAVIGATE}: targetEntryId must be a string`);
		}
		const target = record.entries.find((e) => e.id === targetEntryId);
		if (!target) throw new RequestError(-32602, `unknown entry: ${targetEntryId}`);

		const session = this.sessions.get(sessionId);
		const oldLeaf = session?.runtime.leafId ?? record.leafId ?? null;

		const cross = this.compactionOrchestrator.detectCrossBranch(record.entries, oldLeaf, targetEntryId);
		if (cross && session && oldLeaf) {
			const summaryEntry = await this.compactionOrchestrator.runBranchSummaryForNavigate(
				sessionId,
				session,
				targetEntryId,
				cross,
				async (sid, eid) => {
					await this.sessionStore.setLeafId(sid, eid);
				},
			);
			if (summaryEntry) {
				await this.events.emit(
					createEvent("branch_summary_created", {
						sessionId,
						abandonedTailLeafId: oldLeaf,
						commonAncestorId: cross.commonAncestorId,
						summary: summaryEntry.summary,
					}),
				);
				await this.events.emit(
					createEvent("session_navigate", {
						sessionId,
						fromLeafId: oldLeaf,
						toLeafId: targetEntryId,
						crossedBranches: true,
					}),
				);
				return { leafId: session.runtime.leafId };
			}
			// Cross-branch but summary failed (LLM error, no API key, etc.): fall
			// through to the plain-navigate path below. `crossedBranches:true`
			// is still emitted so the Client knows context may be lost.
		}

		await this.sessionStore.setLeafId(sessionId, targetEntryId);

		if (session) {
			session.runtime.leafId = targetEntryId;
			const refreshed = await this.sessionStore.load(sessionId);
			if (refreshed) {
				const ctx = buildSessionContext(refreshed, targetEntryId);
				session.runtime.piAgent.state.messages = ctx.messages;
			}
		}
		await this.events.emit(
			createEvent("session_navigate", {
				sessionId,
				fromLeafId: oldLeaf,
				toLeafId: targetEntryId,
				crossedBranches: !!cross,
			}),
		);
		return { leafId: targetEntryId };
	}

	private async handleSessionEntries(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const { record } = await requireSessionRecord(this.sessionStore, EXT_SESSION_ENTRIES, params);
		const path = walkPath(record.entries, record.leafId ?? null);
		const out: { id: string; role: string; preview: string }[] = [];
		for (const entry of path) {
			if (entry.type !== "message") continue;
			const role = entry.message.role;
			if (role !== "user" && role !== "assistant") continue;
			const text = extractText(entry.message).trim();
			const preview = text.length > 60 ? `${text.slice(0, 60)}…` : text;
			out.push({ id: entry.id, role, preview });
		}
		return { entries: out };
	}

	private async handleSessionFork(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const { sessionId, record } = await requireSessionRecord(this.sessionStore, EXT_SESSION_FORK, params);
		const entryId = params.entryId;
		const position = params.position === "at" ? "at" : "before";
		if (typeof entryId !== "string") {
			throw new RequestError(-32602, `${EXT_SESSION_FORK}: entryId must be a string`);
		}
		const target = record.entries.find((e) => e.id === entryId);
		if (!target) throw new RequestError(-32602, `unknown entry: ${entryId}`);
		const { newSessionId } = await this.sessionStore.forkRecord(sessionId, entryId, position);
		await this.events.emit(
			createEvent("session_fork", {
				sessionId,
				newSessionId,
				fromEntryId: entryId,
				position,
			}),
		);
		const out: Record<string, unknown> = { newSessionId };
		if (position === "before" && target.type === "message" && target.message.role === "user") {
			const text = target.message.content;
			const selectedText =
				typeof text === "string"
					? text
					: text
							.filter((b): b is { type: "text"; text: string } => b.type === "text")
							.map((b) => b.text)
							.join("");
			if (selectedText) out.selectedText = selectedText;
		}
		return out;
	}

	private async handleSessionClone(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const { sessionId, record } = await requireSessionRecord(this.sessionStore, EXT_SESSION_CLONE, params);
		const leafId = record.leafId ?? record.entries[record.entries.length - 1]?.id;
		if (!leafId) throw new RequestError(-32603, "cannot clone an empty session");
		const { newSessionId } = await this.sessionStore.forkRecord(sessionId, leafId, "at");
		await this.events.emit(
			createEvent("session_clone", {
				sessionId,
				newSessionId,
				fromLeafId: leafId,
			}),
		);
		return { newSessionId };
	}
}
