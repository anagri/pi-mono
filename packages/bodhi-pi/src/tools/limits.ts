/**
 * Truncation limits for built-in tools.
 *
 * Constants ported from coding-agent (`src/core/tools/truncate.ts:11-13`) so
 * model behaviour is consistent across both agents.
 *
 * **Naming convention:** every `_MAX_BYTES` constant is the cap on TOOL OUTPUT
 * size (the string returned to the model), NOT on individual file sizes. To
 * cap an input file's size, use the corresponding line / match / entry cap.
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
