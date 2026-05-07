/**
 * Shared bounded-accumulation helper for `read` / `ls` / `find` / `grep`.
 *
 * Each of those tools collects strings (paths, matches, dir entries, lines)
 * with two stop conditions:
 *
 *   - count cap: stop after `maxItems` items.
 *   - byte cap:  stop when `joined.length >= maxBytes` (with newline separators).
 *
 * This module centralises the accumulator + the truncation footer so the
 * tools themselves only have to yield strings and pass a unit noun.
 */

export type StoppedReason = "items" | "bytes" | null;

export interface AccumulateOptions {
	maxItems: number;
	maxBytes: number;
}

export interface AccumulateResult {
	lines: string[];
	stopped: StoppedReason;
}

/**
 * Pull strings from `source` into an array, stopping at either limit.
 * Each item contributes `item.length + 1` toward the byte budget (the +1 is
 * the joining newline). The item that would put us over the byte cap is
 * dropped, not partially included.
 */
export async function accumulateBounded(
	source: AsyncIterable<string>,
	{ maxItems, maxBytes }: AccumulateOptions,
): Promise<AccumulateResult> {
	const lines: string[] = [];
	let bytes = 0;
	for await (const item of source) {
		if (lines.length >= maxItems) {
			return { lines, stopped: "items" };
		}
		if (bytes + item.length + 1 > maxBytes) {
			return { lines, stopped: "bytes" };
		}
		lines.push(item);
		bytes += item.length + 1;
	}
	return { lines, stopped: null };
}

export interface FooterOptions {
	/** Number of items actually shown. */
	shown: number;
	/** Total items if known up front; omit when unknown (find/grep). */
	total?: number;
	/** Why we stopped. */
	stopped: "items" | "bytes";
	/** Noun for the items: "lines" / "matches" / "entries" / "results". */
	item: string;
	/** Output byte cap (in bytes). */
	maxBytes: number;
	/** Item cap (count). Used in the items-limit message. */
	maxItems: number;
}

/**
 * Standard truncation footer used by every tool. Emit format:
 *
 *   [Truncated: showing 10 of 50 results; 10-results limit]
 *   [Truncated: showing 17 entries; 50KB output limit]
 */
export function truncationFooter(opts: FooterOptions): string {
	const head =
		opts.total !== undefined
			? `showing ${opts.shown} of ${opts.total} ${opts.item}`
			: `showing ${opts.shown} ${opts.item}`;
	const reason =
		opts.stopped === "items"
			? `${opts.maxItems}-${opts.item} limit`
			: `${Math.floor(opts.maxBytes / 1024)}KB output limit`;
	return `[Truncated: ${head}; ${reason}]`;
}
