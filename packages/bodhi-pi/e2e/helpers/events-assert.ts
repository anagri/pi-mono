import { expect } from "vitest";
import type { BodhiPiEvent, BodhiPiEventType } from "@/index.js";

/**
 * Strict subsequence: every entry of `expected` must appear in `actual` in the
 * given order, but `actual` may interleave other entries between them. On miss,
 * fails with the matched-prefix diagnostic so authors can see how far the
 * sequence got before diverging.
 */
export function expectSubsequence(actual: readonly string[], expected: readonly string[], message?: string): void {
	let i = 0;
	for (const t of actual) {
		if (t === expected[i]) i++;
		if (i === expected.length) return;
	}
	const prefix = expected.slice(0, i);
	const missing = expected.slice(i);
	const lead = message ? `${message}: ` : "";
	expect.fail(
		`${lead}expected subsequence not found.\n  matched (${i}/${expected.length}): ${JSON.stringify(prefix)}\n  missing: ${JSON.stringify(missing)}\n  actual:  ${JSON.stringify(actual)}`,
	);
}

export function countOfType(events: readonly BodhiPiEvent[], type: BodhiPiEventType): number {
	let n = 0;
	for (const e of events) if (e.type === type) n++;
	return n;
}

/**
 * Block until every `agent_start` observed in `events` has a matching `agent_end`.
 *
 * Within a single channel (in-memory direct push, http SSE in-order frames, cli
 * stderr line stream) ordering is preserved, so once the matching `agent_end`
 * lands, every event emitted before it on the same channel is already present.
 * This barrier is the cross-runtime sync point tests use between `prompt()` and
 * assertions — required for cli (separate stderr/stdout pipes), no-op for
 * in-memory/http (same channel as the prompt response).
 */
export async function waitForAgentEndBalance(
	events: readonly BodhiPiEvent[],
	opts: { timeoutMs?: number; idleMs?: number } = {},
): Promise<void> {
	const timeoutMs = opts.timeoutMs ?? 2000;
	const idleMs = opts.idleMs ?? 50;
	const deadline = Date.now() + timeoutMs;
	let lastSeenCount = -1;
	let stableSince = 0;
	while (Date.now() < deadline) {
		const starts = countOfType(events, "agent_start");
		const ends = countOfType(events, "agent_end");
		if (starts > 0 && ends >= starts) {
			if (events.length === lastSeenCount) {
				if (Date.now() - stableSince >= idleMs) return;
			} else {
				lastSeenCount = events.length;
				stableSince = Date.now();
			}
		}
		await new Promise((r) => setTimeout(r, 10));
	}
	const starts = countOfType(events, "agent_start");
	const ends = countOfType(events, "agent_end");
	throw new Error(
		`waitForAgentEndBalance: timed out after ${timeoutMs}ms (agent_start=${starts}, agent_end=${ends}, total events=${events.length})`,
	);
}
