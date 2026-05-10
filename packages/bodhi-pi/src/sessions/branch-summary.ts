import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Api, Message, Model } from "@mariozechner/pi-ai";
import { completeSimple } from "@mariozechner/pi-ai";
import type { CompactionDetails, SessionEntry } from "./entries.js";

/**
 * Cross-branch detection for `/goto`.
 *
 * Returns the abandoned-tail entries (chronological) and the common-ancestor
 * id IFF navigating from `oldLeafId` to `targetEntryId` crosses branches —
 * i.e. `targetEntryId`'s parentId chain does NOT include `oldLeafId`. Returns
 * `undefined` for forward navigation (target is a descendant of oldLeaf or
 * equal), meaning no summary is needed.
 */
export function detectCrossBranch(
	entries: SessionEntry[],
	oldLeafId: string | null,
	targetEntryId: string,
): { abandonedTail: SessionEntry[]; commonAncestorId: string | null } | undefined {
	if (!oldLeafId || oldLeafId === targetEntryId) return undefined;
	const byId = new Map<string, SessionEntry>();
	for (const entry of entries) byId.set(entry.id, entry);

	const targetChain = new Set<string>();
	let cur: SessionEntry | undefined = byId.get(targetEntryId);
	while (cur) {
		targetChain.add(cur.id);
		cur = cur.parentId ? byId.get(cur.parentId) : undefined;
	}
	if (targetChain.has(oldLeafId)) return undefined;

	const abandonedTail: SessionEntry[] = [];
	let commonAncestorId: string | null = null;
	cur = byId.get(oldLeafId);
	while (cur) {
		if (targetChain.has(cur.id)) {
			commonAncestorId = cur.id;
			break;
		}
		abandonedTail.unshift(cur);
		cur = cur.parentId ? byId.get(cur.parentId) : undefined;
	}
	if (abandonedTail.length === 0) return undefined;
	return { abandonedTail, commonAncestorId };
}

interface FileOps {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
}

function extractFileOps(message: AgentMessage, ops: FileOps): void {
	if (message.role !== "assistant") return;
	for (const block of message.content) {
		if (block.type !== "toolCall") continue;
		const args = (block.arguments as Record<string, unknown> | undefined) ?? undefined;
		if (!args || typeof args.path !== "string") continue;
		if (block.name === "read") ops.read.add(args.path);
		else if (block.name === "write") ops.written.add(args.path);
		else if (block.name === "edit") ops.edited.add(args.path);
	}
}

function serializeConversation(messages: Message[]): string {
	const parts: string[] = [];
	for (const msg of messages) {
		if (msg.role === "user") {
			const c =
				typeof msg.content === "string"
					? msg.content
					: msg.content
							.filter((b): b is { type: "text"; text: string } => b.type === "text")
							.map((b) => b.text)
							.join("");
			if (c) parts.push(`[User]: ${c}`);
		} else if (msg.role === "assistant") {
			const text: string[] = [];
			const toolCalls: string[] = [];
			for (const b of msg.content) {
				if (b.type === "text") text.push(b.text);
				else if (b.type === "toolCall") {
					const args = b.arguments as Record<string, unknown>;
					toolCalls.push(`${b.name}(${JSON.stringify(args)})`);
				}
			}
			if (text.length > 0) parts.push(`[Assistant]: ${text.join("\n")}`);
			if (toolCalls.length > 0) parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
		} else if (msg.role === "toolResult") {
			const c = msg.content
				.filter((b): b is { type: "text"; text: string } => b.type === "text")
				.map((b) => b.text)
				.join("");
			if (c) parts.push(`[Tool result]: ${c.slice(0, 800)}`);
		}
	}
	return parts.join("\n\n");
}

const BRANCH_SUMMARY_SYSTEM_PROMPT = `You summarize an abandoned conversation branch. The user navigated away from this tail to a different branch; produce a tight checkpoint of what was tried and what was learned, so the new branch can reference it if needed.

Format:
## What was attempted
- [bulleted list]

## Outcome
- [what worked / what didn't]

## Notes for the new branch
- [carry-overs that matter]

Keep it concise. Preserve exact file paths, function names, and error messages.`;

export interface BranchSummaryResult {
	summary: string;
	details?: CompactionDetails;
}

/**
 * Run the LLM call to summarize an abandoned branch's tail. Caller is
 * responsible for persisting the resulting `BranchSummaryEntry` and updating
 * the session's leaf.
 */
export async function runBranchSummary(
	abandonedTail: SessionEntry[],
	model: Model<Api>,
	apiKey: string,
	signal?: AbortSignal,
): Promise<BranchSummaryResult> {
	const messages: AgentMessage[] = [];
	const fileOps: FileOps = { read: new Set(), written: new Set(), edited: new Set() };
	for (const entry of abandonedTail) {
		if (entry.type === "message") {
			messages.push(entry.message);
			extractFileOps(entry.message, fileOps);
		}
	}
	if (messages.length === 0) return { summary: "" };

	const conversationText = serializeConversation(messages as Message[]);
	const promptText = `<abandoned-branch>\n${conversationText}\n</abandoned-branch>\n\n${BRANCH_SUMMARY_SYSTEM_PROMPT}`;
	const summarizationMessages: Message[] = [
		{ role: "user", content: [{ type: "text", text: promptText }], timestamp: Date.now() },
	];
	const response = await completeSimple(
		model,
		{ systemPrompt: BRANCH_SUMMARY_SYSTEM_PROMPT, messages: summarizationMessages },
		{ maxTokens: 4000, ...(signal ? { signal } : {}), apiKey },
	);
	if (response.stopReason === "error") {
		throw new Error(`branch summary failed: ${response.errorMessage ?? "unknown error"}`);
	}
	const summary = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");

	const modified = new Set<string>([...fileOps.edited, ...fileOps.written]);
	const readFiles = [...fileOps.read].filter((f) => !modified.has(f)).sort();
	const modifiedFiles = [...modified].sort();
	const details: CompactionDetails = { readFiles, modifiedFiles };
	return { summary, details };
}
