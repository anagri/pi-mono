import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Message, Model, Usage } from "@earendil-works/pi-ai";
import {
	computeFileLists,
	extractFileOpsFromMessage,
	type FileOps,
	formatFileOperations,
	newFileOps,
	runSummarizationLLM,
	serializeConversation,
} from "./_shared.js";
import type { CompactionDetails, CompactionEntry, SessionEntry } from "./entries.js";

export interface CompactionSettings {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
};

export interface CompactionResult {
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	details?: CompactionDetails;
}

export function calculateContextTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function getAssistantUsage(msg: AgentMessage): Usage | undefined {
	if (msg.role !== "assistant") return undefined;
	const a = msg as AssistantMessage;
	if (a.stopReason === "aborted" || a.stopReason === "error") return undefined;
	return a.usage;
}

export function getLastAssistantUsage(entries: SessionEntry[]): Usage | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "message") {
			const u = getAssistantUsage(entry.message);
			if (u) return u;
		}
	}
	return undefined;
}

/**
 * Conservative chars/4 heuristic — used only for trailing-message estimates
 * after the last assistant `Usage`. Source of truth is the model's own usage.
 */
export function estimateTokens(message: AgentMessage): number {
	let chars = 0;
	if (message.role === "user") {
		const c = message.content;
		if (typeof c === "string") chars = c.length;
		else for (const b of c) if (b.type === "text") chars += b.text.length;
	} else if (message.role === "assistant") {
		for (const b of message.content) {
			if (b.type === "text") chars += b.text.length;
			else if (b.type === "thinking") chars += b.thinking.length;
			else if (b.type === "toolCall") chars += b.name.length + JSON.stringify(b.arguments).length;
		}
	} else if (message.role === "toolResult") {
		for (const b of message.content) {
			if (b.type === "text") chars += b.text.length;
			else if (b.type === "image") chars += 4800;
		}
	}
	return Math.ceil(chars / 4);
}

export interface ContextUsageEstimate {
	tokens: number;
	usageTokens: number;
	trailingTokens: number;
}

export function estimateContextTokens(messages: AgentMessage[]): ContextUsageEstimate {
	let lastUsage: Usage | undefined;
	let lastUsageIndex = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		const u = getAssistantUsage(messages[i]);
		if (u) {
			lastUsage = u;
			lastUsageIndex = i;
			break;
		}
	}
	if (!lastUsage) {
		let est = 0;
		for (const m of messages) est += estimateTokens(m);
		return { tokens: est, usageTokens: 0, trailingTokens: est };
	}
	const usageTokens = calculateContextTokens(lastUsage);
	let trailing = 0;
	for (let i = lastUsageIndex + 1; i < messages.length; i++) trailing += estimateTokens(messages[i]);
	return { tokens: usageTokens + trailing, usageTokens, trailingTokens: trailing };
}

export function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean {
	if (!settings.enabled) return false;
	return contextTokens > contextWindow - settings.reserveTokens;
}

/**
 * Valid cut-points: user/assistant message entries. Tool-result messages are
 * never cut points because they must follow their tool call.
 */
function findValidCutPoints(entries: SessionEntry[], startIndex: number, endIndex: number): number[] {
	const out: number[] = [];
	for (let i = startIndex; i < endIndex; i++) {
		const entry = entries[i];
		if (entry.type === "message") {
			const role = entry.message.role;
			if (role === "user" || role === "assistant") out.push(i);
		} else if (entry.type === "branch_summary" || entry.type === "custom_message") {
			out.push(i);
		}
	}
	return out;
}

function findTurnStartIndex(entries: SessionEntry[], entryIndex: number, startIndex: number): number {
	for (let i = entryIndex; i >= startIndex; i--) {
		const entry = entries[i];
		if (entry.type === "branch_summary" || entry.type === "custom_message") return i;
		if (entry.type === "message" && entry.message.role === "user") return i;
	}
	return -1;
}

export interface CutPointResult {
	firstKeptEntryIndex: number;
	turnStartIndex: number;
	isSplitTurn: boolean;
}

/**
 * Walk backwards accumulating message tokens until `keepRecentTokens` reached;
 * then anchor to the closest valid cut point at or after that position.
 * Mirrors coding-agent's findCutPoint.
 */
export function findCutPoint(
	entries: SessionEntry[],
	startIndex: number,
	endIndex: number,
	keepRecentTokens: number,
): CutPointResult {
	const cutPoints = findValidCutPoints(entries, startIndex, endIndex);
	if (cutPoints.length === 0) {
		return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
	}

	let accumulated = 0;
	let cutIndex = cutPoints[0];
	for (let i = endIndex - 1; i >= startIndex; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		accumulated += estimateTokens(entry.message);
		if (accumulated >= keepRecentTokens) {
			for (let c = 0; c < cutPoints.length; c++) {
				if (cutPoints[c] >= i) {
					cutIndex = cutPoints[c];
					break;
				}
			}
			break;
		}
	}

	while (cutIndex > startIndex) {
		const prev = entries[cutIndex - 1];
		if (prev.type === "compaction" || prev.type === "message") break;
		cutIndex--;
	}

	const cutEntry = entries[cutIndex];
	const isUserMessage = cutEntry.type === "message" && cutEntry.message.role === "user";
	const turnStartIndex = isUserMessage ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);
	return {
		firstKeptEntryIndex: cutIndex,
		turnStartIndex,
		isSplitTurn: !isUserMessage && turnStartIndex !== -1,
	};
}

export interface CompactionPreparation {
	firstKeptEntryId: string;
	messagesToSummarize: AgentMessage[];
	turnPrefixMessages: AgentMessage[];
	isSplitTurn: boolean;
	tokensBefore: number;
	previousSummary?: string;
	fileOps: FileOps;
	settings: CompactionSettings;
}

function getMessageForCompaction(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "message") return entry.message;
	return undefined;
}

/**
 * Slice entries into messages-to-summarize and (for split turns) turn-prefix
 * messages, anchored on `firstKeptEntryId`. Returns `undefined` if the path
 * is already a fresh compaction (no work to do) or has no valid cut.
 */
export function prepareCompaction(
	pathEntries: SessionEntry[],
	settings: CompactionSettings,
): CompactionPreparation | undefined {
	if (pathEntries.length === 0) return undefined;
	if (pathEntries[pathEntries.length - 1].type === "compaction") return undefined;

	let prevCompactionIndex = -1;
	for (let i = pathEntries.length - 1; i >= 0; i--) {
		if (pathEntries[i].type === "compaction") {
			prevCompactionIndex = i;
			break;
		}
	}

	let previousSummary: string | undefined;
	let boundaryStart = 0;
	if (prevCompactionIndex >= 0) {
		const prev = pathEntries[prevCompactionIndex] as CompactionEntry;
		previousSummary = prev.summary;
		const idx = pathEntries.findIndex((e) => e.id === prev.firstKeptEntryId);
		boundaryStart = idx >= 0 ? idx : prevCompactionIndex + 1;
	}
	const boundaryEnd = pathEntries.length;

	const allMessages: AgentMessage[] = [];
	for (const entry of pathEntries) {
		if (entry.type === "message") allMessages.push(entry.message);
	}
	const tokensBefore = estimateContextTokens(allMessages).tokens;

	const cutPoint = findCutPoint(pathEntries, boundaryStart, boundaryEnd, settings.keepRecentTokens);
	const firstKept = pathEntries[cutPoint.firstKeptEntryIndex];
	if (!firstKept?.id) return undefined;

	const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;
	const messagesToSummarize: AgentMessage[] = [];
	for (let i = boundaryStart; i < historyEnd; i++) {
		const m = getMessageForCompaction(pathEntries[i]);
		if (m) messagesToSummarize.push(m);
	}
	const turnPrefixMessages: AgentMessage[] = [];
	if (cutPoint.isSplitTurn) {
		for (let i = cutPoint.turnStartIndex; i < cutPoint.firstKeptEntryIndex; i++) {
			const m = getMessageForCompaction(pathEntries[i]);
			if (m) turnPrefixMessages.push(m);
		}
	}

	const ops = newFileOps();
	for (const m of messagesToSummarize) extractFileOpsFromMessage(m, ops);
	if (cutPoint.isSplitTurn) for (const m of turnPrefixMessages) extractFileOpsFromMessage(m, ops);

	return {
		firstKeptEntryId: firstKept.id,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn: cutPoint.isSplitTurn,
		tokensBefore,
		...(previousSummary !== undefined ? { previousSummary } : {}),
		fileOps: ops,
		settings,
	};
}

const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI coding assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish?]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use the same format as the original summary. Keep each section concise.`;

const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise.`;

async function generateSummary(
	currentMessages: AgentMessage[],
	model: Model<Api>,
	reserveTokens: number,
	apiKey: string,
	customInstructions?: string,
	previousSummary?: string,
	signal?: AbortSignal,
): Promise<string> {
	let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
	if (customInstructions) basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`;
	const conversationText = serializeConversation(currentMessages as Message[]);
	let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
	if (previousSummary) promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
	promptText += basePrompt;
	return runSummarizationLLM(model, SUMMARIZATION_SYSTEM_PROMPT, promptText, {
		apiKey,
		maxTokens: Math.floor(0.8 * reserveTokens),
		...(signal ? { signal } : {}),
		errorPrefix: "Summarization failed",
	});
}

async function generateTurnPrefixSummary(
	messages: AgentMessage[],
	model: Model<Api>,
	reserveTokens: number,
	apiKey: string,
	signal?: AbortSignal,
): Promise<string> {
	const conversationText = serializeConversation(messages as Message[]);
	const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`;
	return runSummarizationLLM(model, SUMMARIZATION_SYSTEM_PROMPT, promptText, {
		apiKey,
		maxTokens: Math.floor(0.5 * reserveTokens),
		...(signal ? { signal } : {}),
		errorPrefix: "Turn prefix summarization failed",
	});
}

/**
 * Run an LLM-backed compaction. Returns the new summary + first-kept entry id;
 * caller persists a `CompactionEntry` and updates `leafId`.
 */
export async function runCompaction(
	preparation: CompactionPreparation,
	model: Model<Api>,
	apiKey: string,
	customInstructions?: string,
	signal?: AbortSignal,
): Promise<CompactionResult> {
	const {
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn,
		tokensBefore,
		previousSummary,
		fileOps,
		settings,
	} = preparation;

	let summary: string;
	if (isSplitTurn && turnPrefixMessages.length > 0) {
		const [historyResult, turnPrefixResult] = await Promise.all([
			messagesToSummarize.length > 0
				? generateSummary(
						messagesToSummarize,
						model,
						settings.reserveTokens,
						apiKey,
						customInstructions,
						previousSummary,
						signal,
					)
				: Promise.resolve("No prior history."),
			generateTurnPrefixSummary(turnPrefixMessages, model, settings.reserveTokens, apiKey, signal),
		]);
		summary = `${historyResult}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixResult}`;
	} else {
		summary = await generateSummary(
			messagesToSummarize,
			model,
			settings.reserveTokens,
			apiKey,
			customInstructions,
			previousSummary,
			signal,
		);
	}

	const details: CompactionDetails = computeFileLists(fileOps);
	summary += formatFileOperations(details.readFiles, details.modifiedFiles);

	return { summary, firstKeptEntryId, tokensBefore, details };
}
