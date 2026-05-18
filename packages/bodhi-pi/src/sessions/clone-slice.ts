import { walkPath } from "./build-context.js";
import type { SessionEntry } from "./entries.js";

export interface CloneTranscriptSliceOpts {
	leafOrFromEntryId?: string | null;
	excludeTargetEntry?: boolean;
	excludeEntryTypes?: Set<SessionEntry["type"]>;
}

export function cloneTranscriptSlice(entries: SessionEntry[], opts: CloneTranscriptSliceOpts): SessionEntry[] {
	if (entries.length === 0) return [];
	const path = walkPath(entries, opts.leafOrFromEntryId);
	const sliced = opts.excludeTargetEntry ? path.slice(0, -1) : path;
	if (!opts.excludeEntryTypes || opts.excludeEntryTypes.size === 0) return sliced;
	const exclude = opts.excludeEntryTypes;
	return sliced.filter((e) => !exclude.has(e.type));
}
