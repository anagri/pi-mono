/**
 * Truncation limits for built-in tools.
 *
 * Constants ported from coding-agent (`src/core/tools/truncate.ts:11-13`) so
 * model behaviour is consistent across both agents.
 */
export const READ_MAX_LINES = 2000;
export const READ_MAX_BYTES = 50_000;
export const FIND_MAX_RESULTS = 1000;
export const FIND_MAX_BYTES = 50_000;
export const GREP_MAX_MATCHES = 100;
export const GREP_MAX_BYTES = 50_000;
export const GREP_MAX_LINE_LENGTH = 500;
export const LS_MAX_ENTRIES = 500;
export const LS_MAX_BYTES = 50_000;
