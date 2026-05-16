/** ACP `SessionConfigOption.id` for the model selector advertised on `session/new`. */
export const MODEL_CONFIG_ID = "model";

/**
 * `data-*` attribute names used by browser-side test-apps to surface
 * ACP wire frames in the DOM. Single source of truth shared by:
 *   - test-apps/browser/src/ui-lib/ui/WirePanel.tsx (emitter)
 *   - bodhi-pi/e2e/helpers/browser/page-frame-reader.ts (e2e reader)
 *   - bodhi-pi/e2e-ui/pages/WirePanel.ts (Playwright reader)
 */
export const WIRE_ROW_ATTRS = {
	direction: "data-frame-direction",
	kind: "data-frame-kind",
	method: "data-frame-method",
	rpcId: "data-frame-rpc-id",
	seq: "data-frame-seq",
} as const;

/** ACP `SessionConfigOption.id` for the reasoning/thinking-level select. Omitted from configOptions when the active model has no thinking support. */
export const THINKING_CONFIG_ID = "thinking";

/** Custom ACP extension method (per `extensibility.mdx` `_`-prefix rule) for permanently deleting a session. */
export const EXT_DELETE_SESSION = "_bodhi-pi/session/delete";

/**
 * Notification method bodhi-pi hosts forward `BodhiPiEvent` records over.
 * Hosts post `{ jsonrpc: "2.0", method: LIFECYCLE_EVENT_METHOD, params: <event> }`
 * from the agent realm; e2e/test-app clients listen for it and route into the
 * lifecycle pane / event recorder.
 */
export const LIFECYCLE_EVENT_METHOD = "_bodhi-pi/lifecycle/event";

/** Manual context compaction. Returns `{ summary, firstKeptEntryId, tokensBefore }`. */
export const EXT_SESSION_COMPACT = "_bodhi-pi/session/compact";

/** Fork from an entry id (position: "before" excludes, "at" includes). Returns `{ newSessionId, selectedText? }`. */
export const EXT_SESSION_FORK = "_bodhi-pi/session/fork";

/** Clone the full chain at the current leaf. Returns `{ newSessionId }`. */
export const EXT_SESSION_CLONE = "_bodhi-pi/session/clone";

/** List the active branch's message entries (`{ id, role, preview }`). Used by hosts to render `/entries`. */
export const EXT_SESSION_ENTRIES = "_bodhi-pi/session/entries";

/** Return the full DAG of session entries (`{ leafId, nodes }`). Used by hosts to render `/tree`. */
export const EXT_SESSION_TREE = "_bodhi-pi/session/tree";

/** Move the session's leaf pointer to a target entry id; subsequent appends branch from there. */
export const EXT_SESSION_NAVIGATE = "_bodhi-pi/session/navigate";

/** Set the session's display name (writes a `session_info` entry). */
export const EXT_SESSION_SET_NAME = "_bodhi-pi/session/setName";

/** Return computed stats `{ messageCount, toolCallCount, leafId, name? }`. */
export const EXT_SESSION_STATS = "_bodhi-pi/session/stats";

/** Serialize the session to JSONL (header line + entry lines on the active branch). */
export const EXT_SESSION_EXPORT = "_bodhi-pi/session/export";

/** Return the per-session resolved config: compaction, retryOptions, appendSystemPrompt, contextFilePaths,
 *  current/default model, thinkingLevel, plus parseError diagnostics. Per-scope settings layers live on
 *  `_bodhi-pi/session/settings/list?scope={global|project|session|effective}`. */
export const EXT_SESSION_CONFIG = "_bodhi-pi/session/config";

/** Read one settings key at the requested scope (global|project|session|effective). */
export const EXT_SESSION_SETTINGS_GET = "_bodhi-pi/session/settings/get";
/** Write one settings key at the requested scope. Default scope is "session". */
export const EXT_SESSION_SETTINGS_SET = "_bodhi-pi/session/settings/set";
/** Remove one settings key at the requested scope. */
export const EXT_SESSION_SETTINGS_UNSET = "_bodhi-pi/session/settings/unset";
/** List settings entries for the requested scope (default: effective merged view). */
export const EXT_SESSION_SETTINGS_LIST = "_bodhi-pi/session/settings/list";

/** Write a KV entry. Params: { key, value, secret? }. */
export const EXT_KV_SET = "_bodhi-pi/kv/set";
/** Read a KV entry. Secret values are masked to "***" in the response. */
export const EXT_KV_GET = "_bodhi-pi/kv/get";
/** List KV entries, optionally prefix-filtered. Secret values masked to "***". */
export const EXT_KV_LIST = "_bodhi-pi/kv/list";
/** Remove a KV entry. */
export const EXT_KV_REMOVE = "_bodhi-pi/kv/remove";

/** Persist a new MCP server entry under `mcp/<slug>`. Params: { url?, command?, args?, env?, auth?, label? }. Returns `{ slug }`. */
export const EXT_MCP_ADD = "_bodhi-pi/mcp/add";
/** Remove `mcp/<slug>` from KV and close any live global connection. Per-session inclusion sets are untouched. */
export const EXT_MCP_REMOVE = "_bodhi-pi/mcp/remove";
/** Establish (or reuse) the global MCP connection for `slug`. Does NOT alter any session's inclusion set. Returns `{ tools }`. */
export const EXT_MCP_CONNECT = "_bodhi-pi/mcp/connect";
/** Close the global MCP connection for `slug`. Tools disappear for every session that includes it; inclusion sets untouched. */
export const EXT_MCP_DISCONNECT = "_bodhi-pi/mcp/disconnect";
/** Disconnect + connect for `slug` (global). */
export const EXT_MCP_RECONNECT = "_bodhi-pi/mcp/reconnect";
/** List MCP entries (slug, label, status, transport, connected). Secret values masked. */
export const EXT_MCP_LIST = "_bodhi-pi/mcp/list";
/** List the tools currently visible to `sessionId` for `slug` (i.e., included AND globally connected). */
export const EXT_MCP_TOOLS = "_bodhi-pi/mcp/tools";
/** Add `slug` to a session's inclusion set. Slug must already exist in kv; if not globally connected, tools surface when it next connects. */
export const EXT_MCP_INCLUDE = "_bodhi-pi/mcp/include";
/** Remove `slug` from a session's inclusion set. No-op if absent. Does NOT close the global connection. */
export const EXT_MCP_EXCLUDE = "_bodhi-pi/mcp/exclude";
/** Start OAuth flow for `slug`. Returns `{ authorizeUrl, state }`. Phase 3. */
export const EXT_MCP_OAUTH_START = "_bodhi-pi/mcp/oauth/start";
/** Finish OAuth flow with `{ code, state }`. Connects globally on success. Returns `{ tools }`. Phase 3. */
export const EXT_MCP_OAUTH_FINISH = "_bodhi-pi/mcp/oauth/finish";
