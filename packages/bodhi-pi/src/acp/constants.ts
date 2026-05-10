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
