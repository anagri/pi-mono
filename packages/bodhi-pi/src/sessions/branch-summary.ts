import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Message, Model } from "@earendil-works/pi-ai";
import {
	computeFileLists,
	extractFileOpsFromMessage,
	newFileOps,
	runSummarizationLLM,
	serializeConversation,
} from "./_shared.js";
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
	const fileOps = newFileOps();
	for (const entry of abandonedTail) {
		if (entry.type === "message") {
			messages.push(entry.message);
			extractFileOpsFromMessage(entry.message, fileOps);
		}
	}
	if (messages.length === 0) return { summary: "" };

	const conversationText = serializeConversation(messages as Message[]);
	const promptText = `<abandoned-branch>\n${conversationText}\n</abandoned-branch>\n\n${BRANCH_SUMMARY_SYSTEM_PROMPT}`;
	const summary = await runSummarizationLLM(model, BRANCH_SUMMARY_SYSTEM_PROMPT, promptText, {
		apiKey,
		maxTokens: 4000,
		...(signal ? { signal } : {}),
		errorPrefix: "branch summary failed",
	});

	const details: CompactionDetails = computeFileLists(fileOps);
	return { summary, details };
}
