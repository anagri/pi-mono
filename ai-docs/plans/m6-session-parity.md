# Sessions Feature Parity — bodhi-pi ↔ coding-agent

**Status:** Plan
**Source report:** `ai-docs/parity-post-extension.md` §3.1, §3.2 (compaction, fork, branch tree)
**Reference impl:** `packages/coding-agent` (pi-coding-agent v0.73.0)

---

## 1. Context

`bodhi-pi` reached extension parity in M5.2, but its session model is a **flat append-only log** (`message`, `model_change`, `extension`). coding-agent's session model is a **DAG** (every entry has `parentId`, sessions have a `leafId`, branches converge), which unlocks: manual & automatic compaction (long-running sessions don't blow context), `/fork` to re-edit a prior turn, `/clone` for safe experimentation, `/tree` to navigate branches, and `/name` for human-readable session labels.

Today none of this exists in `bodhi-pi`. The agreed direction (after grilling): **adopt the coding-agent functional model wholesale** — same entry types, same algorithm, same UX semantics — and prove it across every host (cli, web, ws-frontend, http, chrome-ext) using each host's existing e2e harness. Auto-compact's threshold logic is best tested with a faux provider in core integration tests where context-window can be rigged deterministically; per-host e2e covers only the visible commands (`/compact`, `/fork`, `/clone`, `/tree`, `/name`, `/session`, `/export`).

The downstream PoCs (-web, -ws-frontend, -http, -chrome-ext) are intentionally PoCs, not production apps. When a feature needs UI state for tests, we expose it via `data-testid`/`data-*` attributes on the existing EventsPanel/ChatPage page objects — same pattern as M11/M14. All user interaction is via slash commands typed into the prompt input; no buttons, modals, or pickers.

---

## 2. Goals & Non-Goals

### In scope (v1)
- Tree-shaped session model with `parentId` on every entry, `leafId` on the session
- New entry types from coding-agent: `compaction`, `branch_summary`, `custom`, `custom_message`, `label`, `session_info` (in addition to existing `message`, `model_change`)
- Slash commands: `/compact [instructions]`, `/fork <entryId>`, `/clone`, `/tree`, `/name <text>`, `/session`, `/export`
- Auto-compaction with soft (`reserveTokens`) and hard (overflow) thresholds
- `SessionInfo.name` + pagination cursor wired through `session/list`
- Drop & recreate SQLite + Dexie session schemas (PoC stance — existing dev sessions discarded)
- `bodhi-pi/PARITY.md` listing what shipped and what was deferred

### Out of scope (deferred, captured in PARITY.md)
- `/import` — `/export` returns full conversation in ACP response; host decides what to do with it (clipboard, file, etc.). `/import` requires reverse-engineering the shape and security checks; defer.
- HTML export — host concern, separate package later
- Thinking levels (`thinking_level_change` entry exists in shape but `setSessionConfigOption("thinking", ...)` not wired)
- `/share` (gist upload), `/login`/`/logout`, OAuth refresh
- Sub-agents, package manager, multimodal images
- Programmatic SDK wrapper (`createAgentSession`)
- Pluggable ops / SSH file execution

---

## 3. Architectural Design

### 3.1 Tree model adoption

**Every entry gains `parentId: string | null`.** The session has a `leafId: string | null` pointing at the current head. Linear conversation = each entry's parentId is the previous entry's id. Branching = two entries share a parentId. Replay walks from `leafId` backwards to root via parentId, then reverses for chronological order.

**`SessionRecord` shape (core):**
```ts
interface SessionRecord {
  id: string;
  cwd: string;
  parentSessionId?: string;     // set on fork; points at source session
  leafId: string | null;        // current head; null for empty session
  name?: string;                // last session_info entry's name
  createdAt: number;
  updatedAt: number;
  entries: SessionEntry[];      // append-order; replay walks via parentId
}
```

**Entry union (core):**
```ts
type SessionEntry =
  | MessageEntry
  | ModelChangeEntry
  | CompactionEntry
  | BranchSummaryEntry
  | SessionInfoEntry      // { type:"session_info", name?: string }
  | LabelEntry            // { type:"label", targetId, label? }
  | CustomEntry           // extension data; replaces today's `extension`
  | CustomMessageEntry;   // extension display content

interface BaseEntry { id: string; parentId: string | null; timestamp: number; }
interface MessageEntry extends BaseEntry { type: "message"; message: AgentMessage }
interface ModelChangeEntry extends BaseEntry { type: "model_change"; provider: string; modelId: string }
interface CompactionEntry extends BaseEntry {
  type: "compaction";
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details?: { readFiles: string[]; modifiedFiles: string[] };
  fromHook?: boolean;
}
interface BranchSummaryEntry extends BaseEntry {
  type: "branch_summary";
  fromId: string | null;
  summary: string;
  details?: { readFiles: string[]; modifiedFiles: string[] };
  fromHook?: boolean;
}
interface CustomEntry extends BaseEntry {
  type: "custom";
  extensionName: string;
  customType: string;
  data?: unknown;
}
```

> **Migration of existing `extension` entry:** rename `extension` → `custom` (matches coding-agent). Adapters drop & recreate tables (PoC stance).

### 3.2 Hydration paths

Two paths today, both call `_buildSessionState` in `packages/bodhi-pi/src/acp/agent.ts:646-750`:
- **`loadSession`** — replays history as `sessionUpdate` notifications
- **`resumeSession`** — rehydrates state without UI replay

Both must be rewritten to:
1. Walk from `leafId` to root via parentId, collecting entries
2. Find latest `compaction` entry on the path (if any)
3. Build LLM context: emit `summary` as a synthesized assistant message, then messages from `firstKeptEntryId` onwards, then post-compaction messages
4. Latest `model_change` on the path → restored model
5. Latest `session_info` with `name` → SessionInfo.name
6. For `loadSession`: also emit a `compaction_marker` sessionUpdate (custom kind in ACP `sessionUpdate.update`) so the UI can render "Summarized N messages" — pre-compaction messages are NOT replayed to the UI

**Helper to add:** `buildSessionContext(record: SessionRecord, leafId?: string): { messages: AgentMessage[]; modelChange?: ModelChangeEntry; name?: string }` in `packages/bodhi-pi/src/sessions/build-context.ts`. Mirrors `coding-agent/src/core/session-manager.ts:buildSessionContext`.

### 3.3 New ACP surface

All as `_bodhi-pi/...` extension methods (matches existing `_bodhi-pi/session/delete` pattern):

| Method | Params | Returns |
|---|---|---|
| `_bodhi-pi/session/compact` | `{ sessionId, customInstructions? }` | `{ summary, firstKeptEntryId, tokensBefore }` |
| `_bodhi-pi/session/fork` | `{ sessionId, entryId, position?: "before"\|"at" }` | `{ newSessionId, selectedText? }` |
| `_bodhi-pi/session/clone` | `{ sessionId }` | `{ newSessionId }` (alias for fork at leaf with position=at) |
| `_bodhi-pi/session/tree` | `{ sessionId }` | `{ leafId, nodes: TreeNode[] }` (nodes have id, parentId, type, label) |
| `_bodhi-pi/session/navigate` | `{ sessionId, targetEntryId, generateSummary?: boolean }` | `{ leafId, branchSummaryEntryId? }` |
| `_bodhi-pi/session/setName` | `{ sessionId, name }` | `{ ok: true }` |
| `_bodhi-pi/session/stats` | `{ sessionId }` | `{ messageCount, toolCallCount, tokens, file? }` |
| `_bodhi-pi/session/export` | `{ sessionId, format?: "jsonl" }` | `{ format, content }` (full JSONL string) |

`session/list` already returns `nextCursor`; wire it through SQLite/Dexie. Keep `cursor` opaque (base64url of `{ updatedAt, id }`).

### 3.4 Auto-compaction

Triggered after `agent_end` event in core, before the next prompt is accepted.

```ts
// packages/bodhi-pi/src/sessions/auto-compact.ts
async function checkAutoCompact(session: SessionState, settings: CompactionSettings): Promise<void> {
  if (!settings.enabled) return;
  const usage = session.lastUsage; // populated from after_provider_response event
  if (!usage) return;
  const contextTokens = usage.input + usage.output + (usage.cacheRead ?? 0);
  if (contextTokens > session.contextWindow - settings.reserveTokens) {
    await runCompaction(session, { reason: "threshold" });
  }
}
```

**Hard threshold (overflow):** `prompt` handler catches provider context-overflow errors via `isContextOverflow(err, contextWindow)`, runs compaction with `reason: "overflow"`, sets `willRetry: true`, retries the same prompt once.

**Settings (defaults match coding-agent):**
```ts
interface CompactionSettings {
  enabled: boolean;        // default true
  reserveTokens: number;   // default 16384
  keepRecentTokens: number;// default 20000
}
```

Sourced from `BodhiPiConfig.compaction` (host injects), with sensible defaults. No file-system settings.json yet (Phase 7 of original roadmap; out of scope here).

### 3.5 Slash command surface (per host)

Routing: same as today. Core advertises commands via `availableCommandsUpdate`. Hosts dispatch by name; built-ins call the corresponding ACP method, custom slash commands expand to prompt text.

| Command | Arg | ACP call | Notes |
|---|---|---|---|
| `/compact` | `[instructions]` | `_bodhi-pi/session/compact` | Streams `compaction_start`/`_end` notifications |
| `/fork` | `<entryId>` | `_bodhi-pi/session/fork` (position=before) | Returns `newSessionId` + selected user text; host sends `loadSession` for new id, pre-fills composer with selectedText |
| `/clone` | — | `_bodhi-pi/session/clone` | Returns `newSessionId`; host loads new session |
| `/tree` | — | `_bodhi-pi/session/tree` then `/navigate <id>` follow-up | Two-step: list, then navigate |
| `/name` | `<text>` | `_bodhi-pi/session/setName` | |
| `/session` | — | `_bodhi-pi/session/stats` | Renders inline in chat |
| `/export` | — | `_bodhi-pi/session/export` | Returns JSONL string; CLI writes to stdout, web/http/chrome-ext copies to clipboard via `navigator.clipboard.writeText` |

**Entry-id surfacing for `/fork <entryId>`:**
- **CLI:** Each rendered user/assistant message gets a trailing `[entry: ab12cd34]` in dim color (8-char prefix is enough; full UUID accepted)
- **Web/ws-frontend/http/chrome-ext:** Each message bubble gets `data-entry-id="<uuid>"`. ChatPage page objects expose `messageEntryId(role, index): Promise<string>`. EventsPanel already shows full entry IDs in lifecycle rows (`message_update` events) — tests can capture from there.

---

## 4. Per-Package Changes

### 4.1 `packages/bodhi-pi` (core)

**New files:**
- `src/sessions/entries.ts` — Entry union types (move from `session-store.ts`)
- `src/sessions/build-context.ts` — `buildSessionContext()` walking parentId chain
- `src/sessions/compaction.ts` — `runCompaction()`, `findCutPoint()`, `generateSummary()`, `SUMMARIZATION_PROMPT`, `UPDATE_SUMMARIZATION_PROMPT` (port from coding-agent verbatim where possible)
- `src/sessions/auto-compact.ts` — threshold check + overflow detection
- `src/sessions/branch-summary.ts` — `generateBranchSummary()`
- `src/sessions/fork.ts` — `forkSession()`, `cloneSession()` (operate on `SessionStore`)
- `src/sessions/tree.ts` — `buildTree()` returning navigable nodes

**Modified files:**
- `src/sessions/session-store.ts` — extend interface: `setLeafId()`, `appendEntryWithParent()`, `forkRecord()` (copy entries up to a parent point into new sessionId)
- `src/acp/agent.ts` — wire new `_bodhi-pi/session/*` extension methods; rewrite `_buildSessionState` to use `buildSessionContext`; add auto-compact hook in prompt handler
- `src/acp/constants.ts` — new `EXT_*` constants
- `src/index.ts` — export new public types

**Test additions (`bodhi-pi/test/`, faux provider, in-memory store):**
- `compaction.test.ts` — manual /compact, summary entry shape, replay after compact (loadSession emits summary marker + kept messages)
- `auto-compact.test.ts` — threshold trigger, overflow trigger + retry, disabled toggle
- `fork-clone.test.ts` — fork at user message, fork at leaf (clone), parentSessionId pointer, selectedText return
- `tree.test.ts` — tree traversal, navigate to alt branch generates branch_summary
- `name-stats.test.ts` — setName, stats computation
- `export.test.ts` — JSONL output shape (header + linearized branch entries)

**E2e additions (`bodhi-pi/e2e/`, gpt-4o-mini):**
- `compaction.e2e.ts` — long-ish conversation, /compact, continue, assert model still has context via summary
- `fork-clone.e2e.ts` — fork a real conversation, edit, continue independently
- `tree-name.e2e.ts` — branch + navigate + name

### 4.2 `packages/bodhi-pi-node`

**Schema migration (drop & recreate):**
```ts
// drizzle/0002_session_tree.sql (or new migration name)
DROP TABLE IF EXISTS session_entries;
DROP TABLE IF EXISTS sessions;
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  cwd TEXT NOT NULL,
  parent_session_id TEXT,
  leaf_id TEXT,
  name TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX sessions_cwd_updated_id_idx ON sessions(cwd, updated_at, id);
CREATE TABLE session_entries (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  entry_id TEXT NOT NULL,
  parent_id TEXT,
  type TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY(session_id, ordinal)
);
CREATE INDEX session_entries_lookup_idx ON session_entries(session_id, entry_id);
```

**Modified:** `src/sessions/sqlite-session-store.ts` — implement `setLeafId`, `appendEntryWithParent`, `forkRecord` (transactional copy: all entries with target parentId chain → new session_id).

**Tests (`bodhi-pi-node/test/`):**
- `sqlite-tree.test.ts` — fork copies right entries, leafId persists, parentSessionId preserved on reload

### 4.3 `packages/bodhi-pi-browser`

**Dexie schema bump:**
```ts
db.version(2).stores({
  sessions: "&id, cwd, updatedAt, parentSessionId",
  entries: "++pk, sessionId, [sessionId+ordinal], [sessionId+entryId]",
}).upgrade(tx => tx.table("sessions").clear().then(() => tx.table("entries").clear()));
// PoC stance: clear on upgrade
```

**Modified:** `src/sessions/dexie-session-store.ts` — same interface additions as Node.

**Tests (`bodhi-pi-browser/src/**/*.test.ts`, fake-indexeddb):**
- `dexie-tree.test.ts` — same shape as sqlite-tree

### 4.4 `packages/bodhi-pi-cli`

**Modified:** `src/repl/commands.ts` — add cases for `/compact`, `/fork`, `/clone`, `/tree`, `/name`, `/session`, `/export`. Renderer prints `[entry: <8-char>]` on each user/assistant message.

**Modified:** `src/repl/render.ts` (or wherever message render lives) — append entry id suffix.

**E2e (`bodhi-pi-cli/e2e/`):**
- `compaction.e2e.ts` — `/compact`, then continue; assert agent still recalls earlier facts
- `fork.e2e.ts` — capture an entry id from chat, `/fork <id>`, edit user message, run, assert independence from original session
- `clone.e2e.ts` — `/clone`, continue independently
- `tree.e2e.ts` — fork → /tree shows branches → navigate
- `name-session-export.e2e.ts` — `/name`, `/session` stats, `/export` writes valid JSONL

### 4.5 `packages/bodhi-pi-web`

**Modified:**
- `src/ui/commands.ts` — same commands as CLI
- `src/ui/MessageList.tsx` (or equivalent) — add `data-entry-id` to each message bubble
- `src/ui/EventsPanel.tsx` — already shows full entry IDs in lifecycle rows; add `data-entry-id` to message_update rows for test convenience
- `src/ui/ChatPage.tsx` — handle `compaction_marker` sessionUpdate kind: render a small "Summarized N messages" banner with `data-testid="compaction-marker"` and `data-summary-text`
- For `/export`: receive content, call `navigator.clipboard.writeText`, render confirmation

**E2e (`bodhi-pi-web/e2e/`):** parallel to CLI e2e:
- `compaction.spec.ts`, `fork.spec.ts`, `clone.spec.ts`, `tree.spec.ts`, `name-session-export.spec.ts`
- ChatPage gains `messageEntryId(role, index)` helper
- EventsPanel matches additional event kinds (`compaction_start`, `compaction_end`, `branch_summary_generated`)

### 4.6 `packages/bodhi-pi-ws-frontend`

Same change set as bodhi-pi-web (commands.ts, message bubbles get `data-entry-id`, EventsPanel covers new events, /export goes to clipboard).

**E2e (`bodhi-pi-ws-frontend/e2e/`):**
- `m13-compaction.spec.ts`, `m13-fork.spec.ts`, `m13-clone.spec.ts`, `m13-tree.spec.ts`, `m13-name-session-export.spec.ts` (milestone-prefix matches existing convention)

### 4.7 `packages/bodhi-pi-http`

Same as web/ws-frontend at the React frontend layer (`packages/bodhi-pi-http/src/frontend/src/ui/commands.ts`, message-list `data-entry-id`).

**E2e (`bodhi-pi-http/test/specs/`):** same 5 specs adapted to http transport.

### 4.8 `packages/bodhi-pi-chrome-ext`

Same as web (sharing `bodhi-pi-browser` adapter). Ensure clipboard works via Chrome extension permissions; if not, render `/export` content into a textarea the user can copy from manually (data-testid for tests).

**E2e:** same 5 specs as web, adapted to extension harness if one exists. If no e2e harness today, document that and capture as PARITY.md gap (per "skip blocked features" memory).

### 4.9 `packages/bodhi-pi/PARITY.md` (new file)

Lists, for each coding-agent session feature: implemented in v1, deferred (with reason), or excluded by design (host concern). Include:
- ✅ /compact (manual + auto, soft + hard thresholds)
- ✅ /fork, /clone, /tree, /name, /session
- ✅ /export (returns JSONL string in ACP response)
- ⏭ /import — deferred; round-trip needed but lower priority
- ⏭ HTML export — host concern, separate package
- ⏭ /share, /login, /logout, OAuth refresh — auth out of scope
- ⏭ Thinking levels — separate milestone (M7)
- ⏭ Configurable summary model — defer; current model only
- ❌ Sub-agents, package manager, multimodal — excluded by design

---

## 5. Implementation Phases

Each phase: complete the 6-step matrix from `bodhi-pi-package-matrix` (extended to cover all 5 hosts), commit, then move on. Hosts beyond -cli/-web (i.e., -ws-frontend, -http, -chrome-ext) follow the same e2e shape — slash command in, expected state out via existing EventsPanel/data-testid attributes.

### Phase A — Foundation (schema + entry types + replay)
**Why first:** every later feature depends on parentId/leafId. No user-visible commands yet.

1. Core: extend SessionEntry union, add `buildSessionContext`, rewrite hydration in `_buildSessionState`
2. Core integration tests: hydration with mixed entry types, parentId chain walk, leafId update on append
3. -node: SQLite schema rebuild + migration; tests
4. -browser: Dexie schema bump; tests
5. -cli: render `[entry: <8>]` on messages; smoke e2e (existing chat.e2e still passes)
6. -web/-ws-frontend/-http/-chrome-ext: `data-entry-id` on bubbles; existing e2e still passes
7. **Commit.**

### Phase B — `/compact` (manual)
1. Core: `runCompaction()`, `_bodhi-pi/session/compact` handler, emit `compaction_start`/`compaction_end` notifications
2. Core integration test: faux provider returns rigged summary, assert CompactionEntry shape + replay correctness
3. Core e2e: long conversation, /compact, continue
4. -cli: /compact slash + e2e
5. -web/-ws-frontend/-http/-chrome-ext: /compact slash, render `compaction_marker` banner; e2e per host
6. **Commit.**

### Phase C — Auto-compaction
1. Core: `auto-compact.ts`, hook into prompt handler post `agent_end`, overflow detection + retry
2. Core integration test: rigged contextWindow + faux usage → threshold trigger; rigged provider error → overflow trigger + retry
3. **No per-host e2e** (per user direction — too flaky to force-real-LLM thresholds)
4. **Commit.**

### Phase D — `/fork` and `/clone`
1. Core: `forkSession()`, `cloneSession()`, ACP handlers; on fork-before-user-msg return `selectedText`
2. Core integration tests: parentSessionId pointer, entry copy correctness, leafId on new session
3. -node + -browser: store-level `forkRecord` impl + tests
4. -cli e2e: capture entry id, /fork <id>, verify independence
5. -web/-ws-frontend/-http/-chrome-ext e2e: same flow with `messageEntryId(role, idx)` helper
6. **Commit.**

### Phase E — `/tree` + branch_summary on navigation
1. Core: `buildTree()`, `navigate()` handler, `generateBranchSummary()` when crossing branches
2. Core integration tests: tree shape, summary generated only on cross-branch navigation
3. Per-host e2e: fork twice, /tree lists nodes, navigate, assert active branch updated
4. **Commit.**

### Phase F — `/name`, `/session`, `/export`
1. Core: setName (writes session_info entry), stats (computed), export (JSONL serialization)
2. Tests + per-host e2e
3. PARITY.md created with full status matrix
4. **Commit.**

---

## 6. Test Strategy Summary

| Layer | Where | What to assert |
|---|---|---|
| Core unit/integration | `bodhi-pi/test/` (vitest, faux provider, in-memory store) | Algorithm correctness: cut-point selection, summary entry shape, replay walks parentId chain, threshold/overflow triggers fire, fork copies right subset of entries |
| Core real-LLM e2e | `bodhi-pi/e2e/` (gpt-4o-mini) | End-to-end: model still recalls earlier facts after /compact; fork really diverges |
| -node unit | `bodhi-pi-node/test/` | SQLite tree integrity, transactional fork |
| -browser unit | `bodhi-pi-browser/src/**/*.test.ts` (fake-indexeddb) | Dexie tree integrity |
| -cli e2e | `bodhi-pi-cli/e2e/` (gpt-4o-mini, real adapters) | All slash commands work; entry-id rendering helps test capture |
| -web e2e | `bodhi-pi-web/e2e/` (Playwright + gpt-4o-mini) | Same commands, ChatPage page object captures entry ids; EventsPanel surfaces compaction events |
| -ws-frontend e2e | `bodhi-pi-ws-frontend/e2e/` | Same; per-test server spawn |
| -http e2e | `bodhi-pi-http/test/specs/` | Same; per-turn rebuild path still works after compaction |
| -chrome-ext e2e | `bodhi-pi-chrome-ext/e2e/` (if harness exists; else PARITY note) | Same |

**Auto-compact: core integration only.** Per-host e2e exercises only manual `/compact`.

---

## 7. Critical Files to Modify (cheat sheet)

**Core (bodhi-pi):**
- `src/sessions/session-store.ts` — extend interface (setLeafId, appendEntryWithParent, forkRecord)
- `src/sessions/build-context.ts` *(new)* — parentId-chain walker, compaction-aware
- `src/sessions/compaction.ts` *(new)* — port from `coding-agent/src/core/compaction/compaction.ts`
- `src/sessions/auto-compact.ts` *(new)* — threshold + overflow
- `src/sessions/fork.ts`, `tree.ts`, `branch-summary.ts` *(new)*
- `src/acp/agent.ts:204-750` — newSession, loadSession, resumeSession, prompt; new `_bodhi-pi/session/*` extension methods; auto-compact hook
- `src/acp/constants.ts` — new `EXT_*` constants

**Adapters:**
- `bodhi-pi-node/src/sessions/sqlite-session-store.ts` + `schema.ts` + new drizzle migration
- `bodhi-pi-browser/src/sessions/dexie-session-store.ts` (Dexie version bump + clear-on-upgrade)

**Hosts (per host: commands dispatcher + message-list entry-id rendering + e2e specs):**
- `bodhi-pi-cli/src/repl/commands.ts`, `render.ts`, `e2e/`
- `bodhi-pi-web/src/ui/commands.ts`, `MessageList.tsx`, `EventsPanel.tsx`, `e2e/`
- `bodhi-pi-ws-frontend/src/ui/commands.ts`, `MessageList.tsx`, `EventsPanel.tsx`, `e2e/`
- `bodhi-pi-http/src/frontend/src/ui/commands.ts`, frontend MessageList, `test/specs/`
- `bodhi-pi-chrome-ext/src/ui/...`, `e2e/` (if present)

**New top-level doc:**
- `packages/bodhi-pi/PARITY.md`

**Reference (port from):**
- `packages/coding-agent/src/core/compaction/compaction.ts`
- `packages/coding-agent/src/core/compaction/branch-summarization.ts`
- `packages/coding-agent/src/core/session-manager.ts:buildSessionContext`
- `packages/coding-agent/src/core/agent-session-runtime.ts:fork`
- `packages/coding-agent/test/compaction.test.ts` (test-shape reference)

---

## 8. Verification

After each phase:

```bash
# Core
pnpm --filter bodhi-pi test
pnpm --filter bodhi-pi e2e        # gpt-4o-mini, requires OPENAI_API_KEY

# Adapters
pnpm --filter bodhi-pi-node test
pnpm --filter bodhi-pi-browser test

# Hosts (each with its own pattern)
pnpm --filter bodhi-pi-cli e2e
pnpm --filter bodhi-pi-web e2e
pnpm --filter bodhi-pi-ws-frontend e2e
pnpm --filter bodhi-pi-http test
pnpm --filter bodhi-pi-chrome-ext e2e   # if harness present
```

**Per-feature manual smoke (CLI, after Phase F):**
1. Start REPL: `pnpm --filter bodhi-pi-cli start`
2. Have a 5-turn conversation; capture an entry id from `[entry: ...]`
3. `/name "test session"`, `/session` shows stats with name
4. `/compact` summarizes; continue, model recalls earlier
5. `/fork <id>`, edit composer, run; original session intact via `/sessions`
6. `/clone`, continue both branches independently
7. `/tree` lists branches; navigate
8. `/export` writes JSONL to stdout; `head -1` shows session header

**Web manual smoke:** repeat in browser; verify `data-entry-id` on bubbles (via DevTools), `/export` lands in clipboard, `compaction_marker` banner renders after `/compact`.

---

## 9. Open Risks

- **Token counting source.** pi-agent-core emits usage in `after_provider_response` events; need to confirm shape and that cache hits are included. If usage is unreliable, auto-compact threshold check may misfire. Mitigation: log usage in core integration tests and assert pre/post values.
- **Replay UX for compaction marker.** ACP doesn't have a standard `sessionUpdate.kind` for "summarization". We'll use a custom kind (`bodhi-pi/compaction_marker`) that hosts opt into rendering. Hosts that don't render it just skip — pre-compaction history is still hidden either way.
- **Cross-runtime fork semantics for ZenFS-mounted FSA.** Browser host's filesystem is workspace-rooted; forking copies session entries but cwd stays the same FSA mount. Should be fine because cwd is logical; verify no path-jail surprises.
- **Chrome extension test harness.** May not exist. If so, document in PARITY.md and skip per "skip blocked features" memory rather than building a harness inside this milestone.
