import { type AgentSideConnection, RequestError } from "@agentclientprotocol/sdk";
import type { AgentMessage, AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { randomUUID } from "@/_internal/uuid.js";
import type { BodhiPiLogger } from "@/acp/agent.js";
import type { PromptLoopDeps } from "@/acp/prompt-loop.js";
import { runPromptLoop } from "@/acp/prompt-loop.js";
import type { EventDispatcher } from "@/events/dispatcher.js";
import type { McpService } from "@/mcp/mcp-service.js";
import { extractText } from "@/sessions/_shared.js";
import { buildSessionContext } from "@/sessions/build-context.js";
import { cloneTranscriptSlice } from "@/sessions/clone-slice.js";
import type { SessionEntry, SubagentBatchEntry, SubagentCompleteEntry, SubagentLinkEntry } from "@/sessions/entries.js";
import { requireLiveSession } from "@/sessions/resolution.js";
import type { BootstrapDeps } from "@/sessions/session-bootstrap.js";
import type { SessionState } from "@/sessions/session-state.js";
import type { SessionStore } from "@/sessions/session-store.js";
import { EXT_SUBAGENT_CHILDREN, EXT_SUBAGENT_LIST, EXT_SUBAGENT_RUN } from "@/wire/constants.js";
import { SUBAGENT_FORK_FILTER } from "./_clone-slice-filter.js";
import { BatchProgressAccumulator } from "./batch-progress-accumulator.js";
import { buildChildSessionState } from "./build-child-state.js";
import { profileToSummary, type SubagentProfile } from "./types.js";

type ExtHandler = (params: Record<string, unknown>) => Promise<Record<string, unknown>>;
type AppendEntry = (sessionId: string, session: SessionState, entry: SessionEntry) => Promise<void>;

export const SUBAGENT_MAX_DEPTH = 2;
/** Max chars captured from the child's final assistant message into the parent's tool_result body. */
export const SUBAGENT_SUMMARY_MAX_CHARS = 4000;
/** Max chars shown in the parent's progress UI when a child invokes a tool. */
export const SUBAGENT_PROGRESS_TOOL_PREVIEW_CHARS = 80;
/** Default maximum number of children spawnable in a single `subagent_batch` dispatch. */
export const SUBAGENT_DEFAULT_MAX_BATCH_CONCURRENCY = 5;

export interface SubagentServiceDeps {
	sessions: Map<string, SessionState>;
	sessionStore: SessionStore;
	events: EventDispatcher;
	conn: AgentSideConnection;
	logger: BodhiPiLogger;
	mcpService: McpService;
	bootstrapDeps: () => BootstrapDeps;
	promptLoopDeps: () => PromptLoopDeps;
	appendEntry: AppendEntry;
	maxBatchConcurrency?: number;
}

interface ActiveRun {
	parentSessionId: string;
	profile: SubagentProfile;
	toolCallId: string;
	onUpdate?: AgentToolUpdateCallback;
	toolCount: number;
	startTime: number;
}

export interface SubagentSpawnInput {
	parentSessionId: string;
	profile: SubagentProfile;
	task: string;
	toolCallId: string;
	modelOverride?: string;
	signal?: AbortSignal;
	onUpdate?: AgentToolUpdateCallback;
	/** Pre-computed fork slice. When provided, `spawn` skips the per-child slice computation. */
	inheritedMessages?: AgentMessage[];
	/** When provided, `spawn` reuses this child session id instead of creating a new one. */
	preCreatedChildSessionId?: string;
}

export interface SubagentSpawnResult {
	childSessionId: string;
	status: "completed" | "cancelled" | "failed";
	summary: string;
	durationMs: number;
	toolCount: number;
	error?: string;
}

export interface SubagentSpawnBatchInput {
	parentSessionId: string;
	batchToolCallId: string;
	tasks: Array<{ profile: SubagentProfile; task: string; modelOverride?: string }>;
	failFast?: boolean;
	signal?: AbortSignal;
	onUpdate?: AgentToolUpdateCallback;
}

export interface SubagentSpawnBatchResult {
	batchToolCallId: string;
	results: SubagentSpawnResult[];
}

export class SubagentService {
	private readonly sessions: Map<string, SessionState>;
	private readonly sessionStore: SessionStore;
	private readonly events: EventDispatcher;
	private readonly conn: AgentSideConnection;
	private readonly logger: BodhiPiLogger;
	private readonly mcpService: McpService;
	private readonly bootstrapDeps: () => BootstrapDeps;
	private readonly promptLoopDeps: () => PromptLoopDeps;
	private readonly appendEntry: AppendEntry;
	private readonly maxBatchConcurrency: number;
	private readonly activeRuns = new Map<string, ActiveRun>();
	private readonly batchAccumulators = new Map<string, BatchProgressAccumulator>();

	constructor(deps: SubagentServiceDeps) {
		this.sessions = deps.sessions;
		this.sessionStore = deps.sessionStore;
		this.events = deps.events;
		this.conn = deps.conn;
		this.logger = deps.logger;
		this.mcpService = deps.mcpService;
		this.bootstrapDeps = deps.bootstrapDeps;
		this.promptLoopDeps = deps.promptLoopDeps;
		this.appendEntry = deps.appendEntry;
		this.maxBatchConcurrency = deps.maxBatchConcurrency ?? SUBAGENT_DEFAULT_MAX_BATCH_CONCURRENCY;

		this.events.appendHandlers("tool_execution_start", [
			async (e) => {
				const run = this.activeRuns.get(e.sessionId);
				if (!run) return;
				run.toolCount += 1;
				const accumulator = this.batchAccumulators.get(e.sessionId);
				if (accumulator) {
					accumulator.recordToolStart(e.sessionId, e.toolName);
					return;
				}
				if (!run.onUpdate) return;
				const preview = formatToolPreview(e.toolName, e.args);
				run.onUpdate({
					content: [{ type: "text", text: `→ ${preview}` }],
					details: {
						kind: "subagent_progress",
						childSessionId: e.sessionId,
						profile: run.profile.name,
						lastTool: e.toolName,
						toolCount: run.toolCount,
						status: "running",
					},
				});
			},
		]);

		this.events.appendHandlers("message_end", [
			async (e) => {
				const run = this.activeRuns.get(e.sessionId);
				if (!run) return;
				if (this.batchAccumulators.has(e.sessionId)) return;
				if (!run.onUpdate) return;
				if (e.message.role !== "assistant") return;
				const text = extractText(e.message).trim();
				if (!text) return;
				const snippet = text.length > 160 ? `${text.slice(0, 160)}…` : text;
				run.onUpdate({
					content: [{ type: "text", text: `[${run.profile.name}] ${snippet}` }],
					details: {
						kind: "subagent_progress",
						childSessionId: e.sessionId,
						profile: run.profile.name,
						toolCount: run.toolCount,
						status: "running",
					},
				});
			},
		]);
	}

	register(): Array<[string, ExtHandler]> {
		return [
			[EXT_SUBAGENT_LIST, this.handleList.bind(this)],
			[EXT_SUBAGENT_RUN, this.handleRun.bind(this)],
			[EXT_SUBAGENT_CHILDREN, this.handleChildren.bind(this)],
		];
	}

	async spawn(input: SubagentSpawnInput): Promise<SubagentSpawnResult> {
		const parent = this.sessions.get(input.parentSessionId);
		if (!parent) {
			throw new RequestError(-32603, `subagent.spawn: parent session ${input.parentSessionId} not loaded`);
		}

		const depth = parent.runtime.subagentDepth + 1;
		if (depth > SUBAGENT_MAX_DEPTH) {
			throw new RequestError(-32603, `subagent.spawn: max depth ${SUBAGENT_MAX_DEPTH} exceeded (would be ${depth})`);
		}

		let childSessionId: string;
		if (input.preCreatedChildSessionId !== undefined) {
			childSessionId = input.preCreatedChildSessionId;
		} else {
			const childRecord = await this.sessionStore.create({
				cwd: parent.cwd,
				parentSessionId: input.parentSessionId,
				subagent: { profileName: input.profile.name },
			});
			childSessionId = childRecord.id;
		}

		const linkEntry: SubagentLinkEntry = {
			type: "subagent_link",
			id: randomUUID(),
			parentId: null,
			timestamp: Date.now(),
			parentSessionId: input.parentSessionId,
			profileName: input.profile.name,
			task: input.task,
			toolCallId: input.toolCallId,
			depth,
			contextMode: input.profile.context,
		};
		await this.sessionStore.append(childSessionId, linkEntry);
		await this.sessionStore.setLeafId(childSessionId, linkEntry.id);

		let inheritedMessages: AgentMessage[] = input.inheritedMessages ?? [];
		if (input.profile.context === "fork" && input.inheritedMessages === undefined) {
			const parentRecord = await this.sessionStore.load(input.parentSessionId);
			if (!parentRecord) {
				throw new RequestError(
					-32603,
					`subagent.spawn: parent session ${input.parentSessionId} record disappeared mid-spawn`,
				);
			}
			const sliced = cloneTranscriptSlice(parentRecord.entries, {
				leafOrFromEntryId: parentRecord.leafId,
				excludeEntryTypes: SUBAGENT_FORK_FILTER,
			});
			inheritedMessages = buildSessionContext({ entries: sliced, leafId: null }).messages;
		}

		await buildChildSessionState(this.bootstrapDeps(), {
			childSessionId,
			parentSessionState: parent,
			profile: input.profile,
			leafId: linkEntry.id,
			depth,
			messages: inheritedMessages,
			...(input.modelOverride !== undefined ? { modelOverride: input.modelOverride } : {}),
		});

		await this.mcpService.hydrate(childSessionId, undefined, []);

		const startTime = Date.now();
		const activeRun: ActiveRun = {
			parentSessionId: input.parentSessionId,
			profile: input.profile,
			toolCallId: input.toolCallId,
			...(input.onUpdate !== undefined ? { onUpdate: input.onUpdate } : {}),
			toolCount: 0,
			startTime,
		};
		this.activeRuns.set(childSessionId, activeRun);

		const onAbort = (): void => {
			const childState = this.sessions.get(childSessionId);
			childState?.runtime.piAgent.abort();
			const child = this.sessions.get(childSessionId);
			if (child) child.runtime.cancelled = true;
		};
		if (input.signal) input.signal.addEventListener("abort", onAbort);

		await this.events.emit({
			type: "subagent_start",
			parentSessionId: input.parentSessionId,
			childSessionId,
			profileName: input.profile.name,
			task: input.task,
			toolCallId: input.toolCallId,
			depth,
			contextMode: input.profile.context,
		});

		let status: "completed" | "cancelled" | "failed" = "failed";
		let summary = "";
		let errorMessage: string | undefined;

		try {
			const promptResponse = await runPromptLoop(this.promptLoopDeps(), this.sessions.get(childSessionId)!, {
				sessionId: childSessionId,
				prompt: [{ type: "text", text: input.task }],
			});
			if (promptResponse.stopReason === "cancelled") {
				status = "cancelled";
			} else if (promptResponse.stopReason === "end_turn" || promptResponse.stopReason === "max_tokens") {
				status = "completed";
			} else {
				status = "failed";
				errorMessage = `stopReason=${promptResponse.stopReason}`;
			}
		} catch (err) {
			status = "failed";
			errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			if (input.signal) input.signal.removeEventListener("abort", onAbort);
			this.activeRuns.delete(childSessionId);
		}

		summary = await this.readLastAssistantText(childSessionId);
		const durationMs = Date.now() - startTime;
		const toolCount = activeRun.toolCount;

		const completeEntry: SubagentCompleteEntry = {
			type: "subagent_complete",
			id: randomUUID(),
			parentId: this.sessions.get(childSessionId)?.runtime.leafId ?? null,
			timestamp: Date.now(),
			status,
			summary,
			durationMs,
			...(errorMessage !== undefined ? { error: errorMessage } : {}),
		};
		try {
			await this.sessionStore.append(childSessionId, completeEntry);
			await this.sessionStore.setLeafId(childSessionId, completeEntry.id);
		} catch (err) {
			this.logger.error("[bodhi-pi subagent] failed to append complete entry", err);
		}

		await this.events.emit({
			type: "subagent_end",
			parentSessionId: input.parentSessionId,
			childSessionId,
			profileName: input.profile.name,
			status,
			durationMs,
			toolCount,
			contextMode: input.profile.context,
			...(summary ? { summary } : {}),
			...(errorMessage !== undefined ? { error: errorMessage } : {}),
		});

		this.evictChild(childSessionId);

		return {
			childSessionId,
			status,
			summary,
			durationMs,
			toolCount,
			...(errorMessage !== undefined ? { error: errorMessage } : {}),
		};
	}

	private async readLastAssistantText(sessionId: string): Promise<string> {
		const record = await this.sessionStore.load(sessionId);
		if (!record) return "";
		for (let i = record.entries.length - 1; i >= 0; i--) {
			const entry = record.entries[i];
			if (entry.type !== "message") continue;
			if (entry.message.role !== "assistant") continue;
			const text = extractText(entry.message).trim();
			if (!text) continue;
			return text.length > SUBAGENT_SUMMARY_MAX_CHARS
				? `${text.slice(0, SUBAGENT_SUMMARY_MAX_CHARS)}\n\n[... ${text.length - SUBAGENT_SUMMARY_MAX_CHARS} more characters truncated]`
				: text;
		}
		return "";
	}

	private evictChild(sessionId: string): void {
		const session = this.sessions.get(sessionId);
		if (!session) return;
		session.runtime.piAgent.abort();
		this.mcpService.closeSession(sessionId);
		this.sessions.delete(sessionId);
	}

	get batchConcurrencyCap(): number {
		return this.maxBatchConcurrency;
	}

	async spawnBatch(input: SubagentSpawnBatchInput): Promise<SubagentSpawnBatchResult> {
		const parent = this.sessions.get(input.parentSessionId);
		if (!parent) {
			throw new RequestError(-32603, `subagent.spawnBatch: parent session ${input.parentSessionId} not loaded`);
		}
		if (input.tasks.length === 0) {
			throw new RequestError(-32602, "subagent.spawnBatch: tasks must be a non-empty array");
		}
		if (input.tasks.length > this.maxBatchConcurrency) {
			throw new RequestError(
				-32602,
				`subagent.spawnBatch: batch size ${input.tasks.length} exceeds maxBatchConcurrency=${this.maxBatchConcurrency}; reduce tasks or raise config.subagents.maxBatchConcurrency`,
			);
		}

		const failFast = input.failFast === true;
		const startTime = Date.now();

		let cachedForkMessages: AgentMessage[] | undefined;
		if (input.tasks.some((t) => t.profile.context === "fork")) {
			const parentRecord = await this.sessionStore.load(input.parentSessionId);
			if (!parentRecord) {
				throw new RequestError(
					-32603,
					`subagent.spawnBatch: parent session ${input.parentSessionId} record disappeared mid-spawn`,
				);
			}
			const sliced = cloneTranscriptSlice(parentRecord.entries, {
				leafOrFromEntryId: parentRecord.leafId,
				excludeEntryTypes: SUBAGENT_FORK_FILTER,
			});
			cachedForkMessages = buildSessionContext({ entries: sliced, leafId: null }).messages;
		}

		const childSessionIds: string[] = [];
		for (const t of input.tasks) {
			const rec = await this.sessionStore.create({
				cwd: parent.cwd,
				parentSessionId: input.parentSessionId,
				subagent: { profileName: t.profile.name },
			});
			childSessionIds.push(rec.id);
		}

		await this.events.emit({
			type: "subagent_batch_start",
			parentSessionId: input.parentSessionId,
			batchToolCallId: input.batchToolCallId,
			childSessionIds: [...childSessionIds],
			profileNames: input.tasks.map((t) => t.profile.name),
			tasks: input.tasks.map((t) => t.task),
			failFast,
		});

		let accumulator: BatchProgressAccumulator | undefined;
		if (input.onUpdate) {
			accumulator = new BatchProgressAccumulator({
				batchToolCallId: input.batchToolCallId,
				onUpdate: input.onUpdate,
				children: input.tasks.map((t, i) => ({
					childSessionId: childSessionIds[i],
					profile: t.profile.name,
				})),
			});
			for (const id of childSessionIds) this.batchAccumulators.set(id, accumulator);
		}

		const batchAC = new AbortController();
		const wrappedSignals = input.tasks.map(() =>
			input.signal ? AbortSignal.any([input.signal, batchAC.signal]) : batchAC.signal,
		);

		const promises = input.tasks.map((t, i) => {
			accumulator?.markRunning(childSessionIds[i]);
			return this.spawn({
				parentSessionId: input.parentSessionId,
				profile: t.profile,
				task: t.task,
				toolCallId: `${input.batchToolCallId}#${i}`,
				preCreatedChildSessionId: childSessionIds[i],
				signal: wrappedSignals[i],
				...(t.modelOverride !== undefined ? { modelOverride: t.modelOverride } : {}),
				...(t.profile.context === "fork" && cachedForkMessages !== undefined
					? { inheritedMessages: cachedForkMessages }
					: {}),
			}).then((result) => {
				accumulator?.recordChildEnd(childSessionIds[i], result.status);
				if (failFast && result.status !== "completed" && !batchAC.signal.aborted) batchAC.abort();
				return result;
			});
		});

		let results: SubagentSpawnResult[];
		try {
			results = await Promise.all(promises);
		} finally {
			for (const id of childSessionIds) this.batchAccumulators.delete(id);
		}
		const durationMs = Date.now() - startTime;

		const batchEntry: SubagentBatchEntry = {
			type: "subagent_batch",
			id: randomUUID(),
			parentId: null,
			timestamp: Date.now(),
			batchToolCallId: input.batchToolCallId,
			childSessionIds: results.map((r) => r.childSessionId),
			profileNames: input.tasks.map((t) => t.profile.name),
			statuses: results.map((r) => r.status),
			durationMs,
		};
		try {
			await this.appendEntry(input.parentSessionId, parent, batchEntry);
		} catch (err) {
			this.logger.error("[bodhi-pi subagent] failed to append batch entry on parent", err);
		}

		await this.events.emit({
			type: "subagent_batch_end",
			parentSessionId: input.parentSessionId,
			batchToolCallId: input.batchToolCallId,
			childSessionIds: results.map((r) => r.childSessionId),
			profileNames: input.tasks.map((t) => t.profile.name),
			statuses: results.map((r) => r.status),
			durationMs,
		});

		return { batchToolCallId: input.batchToolCallId, results };
	}

	buildBatchToolResult(batch: SubagentSpawnBatchResult, profileNames: string[]): AgentToolResult<unknown> {
		const lines: string[] = [];
		lines.push(`<subagent_batch_result count="${batch.results.length}" batchToolCallId="${batch.batchToolCallId}">`);
		batch.results.forEach((r, i) => {
			const profile = profileNames[i] ?? "?";
			lines.push(
				`<child index="${i}" profile="${profile}" status="${r.status}" childSessionId="${r.childSessionId}" durationMs="${r.durationMs}" toolCount="${r.toolCount}">`,
			);
			if (r.error !== undefined) {
				lines.push(`<error>${r.error}</error>`);
			}
			lines.push(r.summary || "(no text output)");
			lines.push("</child>");
		});
		lines.push("</subagent_batch_result>");
		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: {
				kind: "subagent_batch_result",
				batchToolCallId: batch.batchToolCallId,
				children: batch.results.map((r, i) => ({
					childSessionId: r.childSessionId,
					profile: profileNames[i] ?? "?",
					status: r.status,
					durationMs: r.durationMs,
					toolCount: r.toolCount,
					...(r.error !== undefined ? { error: r.error } : {}),
				})),
			},
		};
	}

	buildToolResult(result: SubagentSpawnResult, profile: SubagentProfile): AgentToolResult<unknown> {
		let body: string;
		switch (result.status) {
			case "completed":
				body = `<subagent_result>\n${result.summary || "(no text output)"}\n</subagent_result>`;
				break;
			case "cancelled":
				body = `<subagent_result status="cancelled">\n${result.summary || ""}\n</subagent_result>`;
				break;
			case "failed":
				body = `<subagent_error>\n${result.error ?? "unknown error"}\n${result.summary ? `\n${result.summary}` : ""}\n</subagent_error>`;
				break;
			default: {
				const _exhaustive: never = result.status;
				throw new Error(`buildToolResult: unexpected status ${_exhaustive as string}`);
			}
		}
		const header = `childSessionId: ${result.childSessionId} (load to inspect full transcript)\n\n`;
		return {
			content: [{ type: "text", text: `${header}${body}` }],
			details: {
				kind: "subagent_result",
				childSessionId: result.childSessionId,
				profile: profile.name,
				status: result.status,
				durationMs: result.durationMs,
				toolCount: result.toolCount,
				...(result.error !== undefined ? { error: result.error } : {}),
			},
		};
	}

	private async handleList(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const { session } = requireLiveSession(this.sessions, EXT_SUBAGENT_LIST, params);
		return { profiles: session.subagentProfiles.map(profileToSummary) };
	}

	private async handleRun(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const { sessionId, session } = requireLiveSession(this.sessions, EXT_SUBAGENT_RUN, params);
		const agent = typeof params.agent === "string" ? params.agent : undefined;
		const task = typeof params.task === "string" ? params.task : undefined;
		if (!agent) throw new RequestError(-32602, `${EXT_SUBAGENT_RUN}: agent must be a string`);
		if (!task) throw new RequestError(-32602, `${EXT_SUBAGENT_RUN}: task must be a non-empty string`);
		const profile = session.subagentProfiles.find((p) => p.name === agent);
		if (!profile) {
			throw new RequestError(
				-32602,
				`${EXT_SUBAGENT_RUN}: unknown agent ${agent}; available: ${session.subagentProfiles.map((p) => p.name).join(", ") || "(none)"}`,
			);
		}
		const result = await this.spawn({
			parentSessionId: sessionId,
			profile,
			task,
			toolCallId: `slash-${randomUUID()}`,
			...(typeof params.model === "string" ? { modelOverride: params.model } : {}),
		});
		return {
			childSessionId: result.childSessionId,
			status: result.status,
			durationMs: result.durationMs,
			toolCount: result.toolCount,
			...(result.summary ? { summary: result.summary } : {}),
			...(result.error !== undefined ? { error: result.error } : {}),
		};
	}

	private async handleChildren(params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const { sessionId } = requireLiveSession(this.sessions, EXT_SUBAGENT_CHILDREN, params);
		const result = await this.sessionStore.list({
			parentSessionId: sessionId,
			includeSubagentChildren: true,
		});
		return { children: result.sessions };
	}
}

function formatToolPreview(toolName: string, args: unknown): string {
	if (!args || typeof args !== "object") return toolName;
	const path = (args as { path?: unknown }).path;
	if (typeof path === "string" && path.length > 0) {
		const trimmed =
			path.length > SUBAGENT_PROGRESS_TOOL_PREVIEW_CHARS
				? `…${path.slice(-SUBAGENT_PROGRESS_TOOL_PREVIEW_CHARS)}`
				: path;
		return `${toolName} ${trimmed}`;
	}
	return toolName;
}
