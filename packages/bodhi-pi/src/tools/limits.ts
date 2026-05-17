// `_MAX_BYTES` is UTF-8 bytes (read/run_script — byteLengthUtf8).
// `_MAX_CHARS` is JS string length (ls/find/grep — accumulateBounded).
export const READ_MAX_LINES = 2000;
export const READ_MAX_BYTES = 50_000;
export const FIND_MAX_MATCHES = 1000;
export const FIND_MAX_CHARS = 50_000;
export const GREP_MAX_MATCHES = 100;
export const GREP_MAX_CHARS = 50_000;
export const GREP_MAX_LINE_LENGTH = 500;
export const LS_MAX_ENTRIES = 500;
export const LS_MAX_CHARS = 50_000;
export const RUN_SCRIPT_MAX_BYTES = 50_000;
export const WALK_MAX_ENTRIES = 50_000;
