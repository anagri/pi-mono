/**
 * Truncation limits for built-in tools.
 *
 * `_MAX_BYTES` always caps TOOL OUTPUT (the string returned to the model),
 * never input file size. Cap input via the matching line/match/entry limit.
 */
export const READ_MAX_LINES = 2000;
export const READ_MAX_BYTES = 50_000;
export const FIND_MAX_MATCHES = 1000;
export const FIND_MAX_BYTES = 50_000;
export const GREP_MAX_MATCHES = 100;
export const GREP_MAX_BYTES = 50_000;
export const GREP_MAX_LINE_LENGTH = 500;
export const LS_MAX_ENTRIES = 500;
export const LS_MAX_BYTES = 50_000;
export const RUN_SCRIPT_MAX_BYTES = 50_000;
