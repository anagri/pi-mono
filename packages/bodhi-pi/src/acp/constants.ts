/** ACP `SessionConfigOption.id` for the model selector advertised on `session/new`. */
export const MODEL_CONFIG_ID = "model";

/** Custom ACP extension method (per `extensibility.mdx` `_`-prefix rule) for permanently deleting a session. */
export const EXT_DELETE_SESSION = "_bodhi-pi/session/delete";

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
