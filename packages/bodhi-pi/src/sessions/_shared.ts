import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Message, Model } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai";
import type { SessionEntry } from "./entries.js";

/**
 * Build an id → entry lookup over a list of session entries. Used by branch-summary detection
 * and DAG walks to avoid repeated O(n) `entries.find(...)` scans.
 */
export function buildEntryIndex(entries: SessionEntry[]): Map<string, SessionEntry> {
	const byId = new Map<string, SessionEntry>();
	for (const entry of entries) byId.set(entry.id, entry);
	return byId;
}

/**
 * File-operation tracking shared between compaction and branch summarization.
 * Both walk an entry chain, extracting `read`/`write`/`edit` tool calls so the
 * summary can append a list of touched files.
 */
export interface FileOps {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
}

export function newFileOps(): FileOps {
	return { read: new Set(), written: new Set(), edited: new Set() };
}

export function extractFileOpsFromMessage(message: AgentMessage, ops: FileOps): void {
	if (message.role !== "assistant") return;
	for (const block of message.content) {
		if (block.type !== "toolCall") continue;
		const args = (block.arguments as Record<string, unknown> | undefined) ?? undefined;
		if (!args) continue;
		const path = typeof args.path === "string" ? args.path : undefined;
		if (!path) continue;
		switch (block.name) {
			case "read":
				ops.read.add(path);
				break;
			case "write":
				ops.written.add(path);
				break;
			case "edit":
				ops.edited.add(path);
				break;
		}
	}
}

/**
 * Files that were modified (write OR edit) win over read-only — a file that
 * was both read and edited counts as modified. Lists are sorted for stable
 * summary rendering.
 */
export function computeFileLists(ops: FileOps): { readFiles: string[]; modifiedFiles: string[] } {
	const modified = new Set<string>([...ops.edited, ...ops.written]);
	const readFiles = [...ops.read].filter((f) => !modified.has(f)).sort();
	const modifiedFiles = [...modified].sort();
	return { readFiles, modifiedFiles };
}

export function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
	const sections: string[] = [];
	if (readFiles.length > 0) {
		sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	}
	if (modifiedFiles.length > 0) {
		sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
	}
	return sections.length === 0 ? "" : `\n\n${sections.join("\n\n")}`;
}

/**
 * Filter `content` to text blocks and join their `text` fields. Used both for
 * serialization (collecting message text) and for extracting LLM responses.
 */
export function joinTextBlocks(content: ReadonlyArray<{ type: string; text?: string }>, separator = ""): string {
	return content
		.filter((b): b is { type: "text"; text: string } => b.type === "text")
		.map((b) => b.text)
		.join(separator);
}

const TOOL_RESULT_MAX_CHARS = 2000;

function truncateForSummary(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}\n\n[... ${text.length - max} more characters truncated]`;
}

/**
 * Serialize an LLM message array to a single text blob suitable for stuffing
 * into a summarization user-prompt. Tool results are truncated at
 * `TOOL_RESULT_MAX_CHARS` because full content rarely matters for summary
 * quality and bloats the request.
 */
export function serializeConversation(messages: Message[]): string {
	const parts: string[] = [];
	for (const msg of messages) {
		if (msg.role === "user") {
			const c = typeof msg.content === "string" ? msg.content : joinTextBlocks(msg.content);
			if (c) parts.push(`[User]: ${c}`);
		} else if (msg.role === "assistant") {
			const text: string[] = [];
			const thinking: string[] = [];
			const toolCalls: string[] = [];
			for (const b of msg.content) {
				if (b.type === "text") text.push(b.text);
				else if (b.type === "thinking") thinking.push(b.thinking);
				else if (b.type === "toolCall") {
					const args = b.arguments as Record<string, unknown>;
					const argsStr = Object.entries(args)
						.map(([k, v]) => `${k}=${JSON.stringify(v)}`)
						.join(", ");
					toolCalls.push(`${b.name}(${argsStr})`);
				}
			}
			if (thinking.length > 0) parts.push(`[Assistant thinking]: ${thinking.join("\n")}`);
			if (text.length > 0) parts.push(`[Assistant]: ${text.join("\n")}`);
			if (toolCalls.length > 0) parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
		} else if (msg.role === "toolResult") {
			const content = joinTextBlocks(msg.content);
			if (content) parts.push(`[Tool result]: ${truncateForSummary(content, TOOL_RESULT_MAX_CHARS)}`);
		}
	}
	return parts.join("\n\n");
}

export interface RunSummarizationLLMOptions {
	apiKey: string;
	maxTokens: number;
	signal?: AbortSignal;
	/** Prepended to `response.errorMessage` when the LLM returns `stopReason: "error"`. */
	errorPrefix: string;
}

/**
 * Single point of contact for compaction / turn-prefix / branch-summary LLM
 * calls. Wraps `completeSimple` with the canonical user-message envelope, the
 * uniform error rethrow, and text-block extraction.
 */
export async function runSummarizationLLM(
	model: Model<Api>,
	systemPrompt: string,
	userPromptText: string,
	options: RunSummarizationLLMOptions,
): Promise<string> {
	const messages: Message[] = [
		{ role: "user", content: [{ type: "text", text: userPromptText }], timestamp: Date.now() },
	];
	const response = await completeSimple(
		model,
		{ systemPrompt, messages },
		{ maxTokens: options.maxTokens, ...(options.signal ? { signal: options.signal } : {}), apiKey: options.apiKey },
	);
	if (response.stopReason === "error") {
		throw new Error(`${options.errorPrefix}: ${response.errorMessage ?? "unknown error"}`);
	}
	return joinTextBlocks(response.content, "\n");
}
