import { randomUUID } from "node:crypto";
import { RequestError } from "@agentclientprotocol/sdk";
import type { AgentLoopTurnUpdate, AgentMessage, Agent as PiAgent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, StopReason as PiStopReason } from "@earendil-works/pi-ai";
import { isContextOverflow } from "@earendil-works/pi-ai";
import type { AgentHelpers } from "@/acp/_helpers.js";
import { EXT_SESSION_COMPACT } from "@/acp/constants.js";
import { mapStopReason } from "@/acp/notifications.js";
import type { SessionState } from "@/acp/session-state.js";
import type { EventDispatcher } from "@/events/dispatcher.js";
import type { StopReason } from "@/events/types.js";
import { detectCrossBranch, runBranchSummary } from "./branch-summary.js";
import { buildSessionContext, walkPath } from "./build-context.js";
import {
	type CompactionResult,
	calculateContextTokens,
	getContextWindow,
	getLastAssistantUsage,
	prepareCompaction,
	runCompaction,
} from "./compaction.js";
import type { BranchSummaryEntry, CompactionEntry, SessionEntry } from "./entries.js";
import type { SessionRecord, SessionStore } from "./session-store.js";

type ExtHandler = (params: Record<string, unknown>) => Promise<Record<string, unknown>>;

type AppendEntry = (sessionId: string, session: SessionState, entry: SessionEntry) => Promise<void>;
type ResolveApiKey = (provider: string) => Promise<string | undefined>;
type SubscribeToAgent = (
	sessionId: string,
	session: SessionState,
	outcome: { stopReason?: PiStopReason; errorMessage?: string },
) => () => void;

export interface CompactionOrchestratorDeps {
	sessions: Map<string, SessionState>;
	sessionStore: SessionStore;
	events: EventDispatcher;
	helpers: AgentHelpers;
	appendEntry: AppendEntry;
	resolveApiKey: ResolveApiKey;
	subscribeToAgent: SubscribeToAgent;
	logger?: { error(message: string, ...args: unknown[]): void };
}

export interface BranchNavigateContext {
	abandonedTail: SessionEntry[];
	commonAncestorId: string | null;
}

/**
 * Owns end-to-end compaction (manual `/compact`, proactive auto-compact after `agent_end`, and
 * provider-context-overflow recovery). The agent delegates `_bodhi-pi/session/compact`, the
 * `prepareNextTurn` hook, and post-prompt auto-compact ticks here. Also exposes a wrapper for
 * cross-branch summarisation used by `SessionGraphService.handleSessionNavigate`.
 */
export class CompactionOrchestrator {
	private readonly sessions: Map<string, SessionState>;
	private readonly sessionStore: SessionStore;
	private readonly events: EventDispatcher;
	private readonly helpers: AgentHelpers;
	private readonly appendEntry: AppendEntry;
	private readonly resolveApiKey: ResolveApiKey;
	private readonly subscribeToAgent: SubscribeToAgent;
	private readonly logger: { error(message: string, ...args: unknown[]): void };

	constructor(deps: CompactionOrchestratorDeps) {
		this.sessions = deps.sessions;
		this.sessionStore = deps.sessionStore;
		this.events = deps.events;
		this.helpers = deps.helpers;
		this.appendEntry = deps.appendEntry;
		this.resolveApiKey = deps.resolveApiKey;
		this.subscribeToAgent = deps.subscribeToAgent;
		this.logger = deps.logger ?? console;
	}

	register(): Array<[string, ExtHandler]> {
		return [[EXT_SESSION_COMPACT, this.handleSessionCompact.bind(this)]];
	}

	/** Build the persisted entry from a successful summarization result. Single source of truth across manual/proactive/recovery paths. */
	private makeCompactionEntry(parentId: string | null | undefined, result: CompactionResult): CompactionEntry {
		return {
			type: "compaction",
			id: randomUUID(),
			parentId,
			timestamp: Date.now(),
			summary: result.summary,
			firstKeptEntryId: result.firstKeptEntryId,
			tokensBefore: result.tokensBefore,
			...(result.details ? { details: result.details } : {}),
		};
	}

	/**
	 * Run a compaction end-to-end (prepare → emit start → summarize → persist entry → rebuild live messages → emit end).
	 * Returns a discriminated union so manual callers can re-throw and background callers can swallow gracefully.
	 */
	async runAndPersistCompaction(
		sessionId: string,
		session: SessionState,
		reason: "manual" | "proactive" | "recovery",
		options: { record?: SessionRecord; customInstructions?: string } = {},
	): Promise<
		| { kind: "skipped"; reason: "no_record" | "nothing_to_compact" | "no_api_key" }
		| { kind: "succeeded"; result: CompactionResult; messages: AgentMessage[] }
		| { kind: "failed"; error: Error }
	> {
		const record = options.record ?? (await this.sessionStore.load(sessionId));
		if (!record) return { kind: "skipped", reason: "no_record" };
		const path = walkPath(record.entries, session.runtime.leafId);
		const preparation = prepareCompaction(path, session.compaction);
		if (!preparation) return { kind: "skipped", reason: "nothing_to_compact" };
		const model = session.runtime.piAgent.state.model;
		const apiKey = await this.resolveApiKey(model.provider);
		if (!apiKey) return { kind: "skipped", reason: "no_api_key" };

		await this.events.emit({ type: "compaction_start", sessionId, reason });
		let result: CompactionResult;
		try {
			result = await runCompaction(preparation, model, apiKey, options.customInstructions);
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err));
			await this.events.emit({
				type: "compaction_end",
				sessionId,
				reason,
				errorMessage: error.message,
			});
			return { kind: "failed", error };
		}

		await this.appendEntry(sessionId, session, this.makeCompactionEntry(session.runtime.leafId, result));
		const refreshed = await this.sessionStore.load(sessionId);
		const messages = refreshed
			? buildSessionContext(refreshed, session.runtime.leafId).messages
			: session.runtime.piAgent.state.messages;
		session.runtime.piAgent.state.messages = messages;

		await this.events.emit({
			type: "compaction_end",
			sessionId,
			reason,
			summary: result.summary,
			firstKeptEntryId: result.firstKeptEntryId,
			tokensBefore: result.tokensBefore,
		});
		return { kind: "succeeded", result, messages };
	}

	private async handleSessionCompact(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const session = this.helpers.requireSession(EXT_SESSION_COMPACT, params);
		const { sessionId, record } = await this.helpers.requireSessionRecord(EXT_SESSION_COMPACT, params);
		const customInstructions = typeof params.customInstructions === "string" ? params.customInstructions : undefined;

		const outcome = await this.runAndPersistCompaction(sessionId, session, "manual", {
			record,
			...(customInstructions !== undefined ? { customInstructions } : {}),
		});
		if (outcome.kind === "skipped") {
			if (outcome.reason === "nothing_to_compact") {
				throw new RequestError(-32603, "nothing to compact (session is empty or already compacted at the leaf)");
			}
			if (outcome.reason === "no_api_key") {
				const provider = session.runtime.piAgent.state.model.provider;
				throw new RequestError(-32603, `no API key available for provider "${provider}"`);
			}
			throw new RequestError(-32603, `compact skipped: ${outcome.reason}`);
		}
		if (outcome.kind === "failed") throw outcome.error;

		const { result } = outcome;
		return {
			summary: result.summary,
			firstKeptEntryId: result.firstKeptEntryId,
			tokensBefore: result.tokensBefore,
			...(result.details ? { details: result.details } : {}),
		};
	}

	/** Called after a successful `prompt()`. Background — swallows skip/failure. */
	async checkAutoCompact(sessionId: string, session: SessionState): Promise<void> {
		await this.runProactiveCompaction(sessionId, session);
	}

	/** Called inside `prepareNextTurn` — returns the rebuilt context for the next pi-agent loop iteration. */
	async maybeProactiveCompact(sessionId: string): Promise<AgentLoopTurnUpdate | undefined> {
		const session = this.sessions.get(sessionId);
		if (!session || session.runtime.cancelled) return undefined;
		const ctx = await this.runProactiveCompaction(sessionId, session);
		if (!ctx) return undefined;
		return {
			context: {
				systemPrompt: session.runtime.piAgent.state.systemPrompt,
				messages: ctx.messages,
				tools: session.runtime.piAgent.state.tools,
			},
		};
	}

	private async runProactiveCompaction(
		sessionId: string,
		session: SessionState,
	): Promise<{ messages: AgentMessage[] } | undefined> {
		const settings = session.compaction;
		if (!settings.enabled) return undefined;
		const record = await this.sessionStore.load(sessionId);
		if (!record) return undefined;
		const path = walkPath(record.entries, session.runtime.leafId);
		const usage = getLastAssistantUsage(path);
		if (!usage) return undefined;
		const contextTokens = calculateContextTokens(usage);
		const contextWindow = getContextWindow(session.runtime.piAgent.state.model);
		if (contextWindow <= 0) return undefined;
		if (contextTokens <= contextWindow - settings.reserveTokens) return undefined;

		const outcome = await this.runAndPersistCompaction(sessionId, session, "proactive", { record });
		if (outcome.kind !== "succeeded") return undefined;
		return { messages: outcome.messages };
	}

	/**
	 * Catch context-overflow errors from the provider, run an emergency compaction, and retry
	 * the same prompt once. Subsequent overflows fall through to the caller's error path.
	 */
	async tryOverflowRecovery(
		sessionId: string,
		session: SessionState,
		promptText: string,
		outcome: { stopReason?: PiStopReason; errorMessage?: string },
		finishTurn: (stopReason: StopReason | undefined, errorMessage: string | undefined) => Promise<void>,
	): Promise<boolean> {
		if (session.runtime.overflowRecoveryAttempted) return false;
		const messages = session.runtime.piAgent.state.messages;
		const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
		if (!lastAssistant) return false;
		const contextWindow = getContextWindow(session.runtime.piAgent.state.model);
		if (!isContextOverflow(lastAssistant as AssistantMessage, contextWindow > 0 ? contextWindow : undefined)) {
			return false;
		}
		session.runtime.overflowRecoveryAttempted = true;

		session.runtime.piAgent.state.messages = messages.slice(0, -1);

		const compactOutcome = await this.runAndPersistCompaction(sessionId, session, "recovery");
		if (compactOutcome.kind !== "succeeded") return false;

		const retryOutcome: { stopReason?: PiStopReason; errorMessage?: string } = {};
		const unsubscribe = this.subscribeToAgent(sessionId, session, retryOutcome);
		try {
			await (session.runtime.piAgent as PiAgent).prompt(promptText);
			await (session.runtime.piAgent as PiAgent).waitForIdle();
		} finally {
			unsubscribe();
		}
		if (retryOutcome.stopReason === "error") {
			outcome.stopReason = retryOutcome.stopReason;
			outcome.errorMessage = retryOutcome.errorMessage;
			return false;
		}
		await finishTurn(mapStopReason(retryOutcome.stopReason), undefined);
		return true;
	}

	/**
	 * Cross-branch summarisation wrapper used by `SessionGraphService.handleSessionNavigate`. Runs
	 * the branch-summary LLM call against the abandoned tail, persists the resulting `branch_summary`
	 * entry, advances the leaf to the new target, and rebuilds the live agent's message stream.
	 * Returns the persisted entry on success; `undefined` when no API key is available, the summary
	 * came back empty, or the LLM call failed. Failures are non-fatal — caller falls through to a
	 * plain navigate.
	 */
	async runBranchSummaryForNavigate(
		sessionId: string,
		session: SessionState,
		targetEntryId: string,
		cross: BranchNavigateContext,
		setLeafId: (sessionId: string, entryId: string) => Promise<void>,
	): Promise<BranchSummaryEntry | undefined> {
		try {
			const apiKey = await this.resolveApiKey(session.runtime.piAgent.state.model.provider);
			if (!apiKey) return undefined;
			const result = await runBranchSummary(cross.abandonedTail, session.runtime.piAgent.state.model, apiKey);
			if (!result.summary) return undefined;

			session.runtime.leafId = targetEntryId;
			await setLeafId(sessionId, targetEntryId);
			const entry: BranchSummaryEntry = {
				type: "branch_summary",
				id: randomUUID(),
				parentId: targetEntryId,
				timestamp: Date.now(),
				fromId: cross.commonAncestorId,
				summary: result.summary,
				...(result.details ? { details: result.details } : {}),
			};
			await this.appendEntry(sessionId, session, entry);
			const refreshed = await this.sessionStore.load(sessionId);
			if (refreshed) {
				const ctx = buildSessionContext(refreshed, session.runtime.leafId);
				session.runtime.piAgent.state.messages = ctx.messages;
			}
			return entry;
		} catch (err) {
			this.logger.error(
				`[bodhi-pi] branch-summary navigate failed; falling through to plain navigate (session=${sessionId})`,
				err,
			);
			return undefined;
		}
	}

	/** Re-export so callers don't need to import branch-summary.ts directly. */
	detectCrossBranch(
		entries: SessionEntry[],
		oldLeafId: string | null,
		targetEntryId: string,
	): BranchNavigateContext | undefined {
		return detectCrossBranch(entries, oldLeafId, targetEntryId);
	}
}
