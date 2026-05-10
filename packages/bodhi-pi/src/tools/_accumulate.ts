// `maxChars` is JavaScript string length (UTF-16 code units), not UTF-8 bytes.
// `read.ts` is the byte-aware exception (uses `Buffer.byteLength`).

export type StoppedReason = "items" | "bytes" | null;

export interface AccumulateOptions {
	maxItems: number;
	maxChars: number;
}

export interface AccumulateResult {
	lines: string[];
	stopped: StoppedReason;
}

// Each item contributes `item.length + 1` (the +1 is the joining newline).
// Items that would exceed the cap are dropped, not partially included.
export async function accumulateBounded(
	source: AsyncIterable<string>,
	{ maxItems, maxChars }: AccumulateOptions,
): Promise<AccumulateResult> {
	const lines: string[] = [];
	let chars = 0;
	for await (const item of source) {
		if (lines.length >= maxItems) {
			return { lines, stopped: "items" };
		}
		if (chars + item.length + 1 > maxChars) {
			return { lines, stopped: "bytes" };
		}
		lines.push(item);
		chars += item.length + 1;
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
	/** Output char cap. */
	maxChars: number;
	/** Item cap (count). Used in the items-limit message. */
	maxItems: number;
}

export function truncationFooter(opts: FooterOptions): string {
	const head =
		opts.total !== undefined
			? `showing ${opts.shown} of ${opts.total} ${opts.item}`
			: `showing ${opts.shown} ${opts.item}`;
	const reason =
		opts.stopped === "items"
			? `${opts.maxItems}-${opts.item} limit`
			: `${Math.floor(opts.maxChars / 1000)}K chars output limit`;
	return `[Truncated: ${head}; ${reason}]`;
}
