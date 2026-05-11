# Phase F — Session-management follow-ups

**Status:** Plan
**Source:** `ai-docs/parity-post-extension.md` §3.1 + `packages/bodhi-pi/PARITY.md`
**Builds on:** Phases A–E (commits `4a6fcd17`, `02d2dd84`, `2afca28b`, `73bb349f`, `3141906c`, `f42ea24c`)

---

## 1. Context

Phase A–E shipped the bulk of coding-agent's session-management surface (`/compact`, `/fork`, `/clone`, `/entries`, `/tree`, `/goto`, `/name`, `/session`, `/export`, threshold auto-compact). The PARITY report still flags four follow-ups that fit the current pipeline cleanly:

1. **Pagination cursor in `session/list`** — the `nextCursor` field is already returned end-to-end (all four stores encode `{updatedAt,id}` cursors); only the host `/sessions` dispatchers don't loop for additional pages.
2. **`leaf_id` persistence in SQLite stores** — `setLeafId` is interface-optional and currently a no-op in all three SQLite stores; that's why http's per-turn rebuild loses `/goto` state. PARITY.md flags this explicitly.
3. **Branch summarization on cross-branch `/goto`** — `BranchSummaryEntry` shape exists, `buildSessionContext` already renders it as a synthesized user message at replay; only the trigger + LLM call are missing in `handleSessionNavigate`.
4. **Provider-overflow auto-compaction** — Phase E ships threshold-based compaction; the hard-overflow path (catch context-overflow error → compact → retry once) is the missing leg. pi-ai already exports `isContextOverflow(message, contextWindow?)` from `@mariozechner/pi-ai`.

Deferred per user direction: `/import` (no obvious cross-runtime source), session-cwd switching, skill `allowed-tools` runtime enforcement (deferred to permissions phase).

---

## 2. Scope (4 sub-features × 5 hosts)

| Sub-feature | Core work | Adapter work | Host work | Test layer |
|---|---|---|---|---|
| **F.1** Cursor pagination | none (already done) | none | All 5 hosts: loop until `nextCursor` is undefined OR show "more" indicator | core test verifies `nextCursor` semantics; per-host e2e seeds N sessions and asserts UI surfaces them |
| **F.2** SQLite `leaf_id` | none (interface ready) | drop-and-recreate schema in 3 SQLite stores; implement `setLeafId`; thread `leaf_id` through `load()` + `forkRecord()` | none (CLI/web/ws-frontend already correct in-memory; http now works after this lands) | adapter unit tests + bodhi-pi-http integration test for `/goto` cross-request persistence |
| **F.3** Branch summarization | new helper `runBranchSummary()` (port from coding-agent); cross-branch detection + entry append in `handleSessionNavigate` | none | none (`/goto` slash already present) | core integration test (faux LLM + cross-branch /goto); per-host e2e: extend the existing `/tree`+`/goto` specs to assert a `branch_summary` node appears |
| **F.4** Overflow auto-compact | catch context-overflow in prompt error path; one-shot retry | none | none | core integration test only |

**Estimated diff:** ~600 lines across core + adapters + 5 hosts; no new ACP methods.

---

## 3. Architectural design

### F.1 Pagination cursor

**Already wired:**
- `BodhiPiAcpAgent.listSessions` (`packages/bodhi-pi/src/acp/agent.ts:358`) passes `cursor` through and returns `nextCursor` when present.
- All three SQLite stores (`bodhi-pi-node`, `bodhi-pi-ws-server`, `bodhi-pi-http`) encode/decode base64url `{updatedAt,id}` cursors with `lt(updatedAt) OR (eq(updatedAt) AND lt(id))` tie-break and a `LIMIT PAGE_SIZE+1` over-fetch.
- Dexie store: identical cursor semantics in browser.
- `bodhi-pi-http`'s frontend `acp-http-client.ts:listSessions(params)` already accepts `cursor`.

**What's missing — host dispatchers iterate / surface more pages:**

- `bodhi-pi-cli/src/repl/commands.ts` `/sessions` — currently uses `ctx.sessionStore.list({cwd})` (whitebox); refactor to `ctx.clientConn.listSessions({cwd})` for blackbox parity, then loop while `nextCursor` is set, printing all pages (small REPL — no need to paginate by user input). Existing `// (more — use /sessions with cursor support TBD)` comment is the placeholder.
- `bodhi-pi-browser/src/ui/commands.ts` `/sessions` — same: loop until `nextCursor` is undefined; concatenate sessions into one system message.
- `bodhi-pi-ws-frontend/src/ui/commands.ts` — same.
- `bodhi-pi-http/src/frontend/ui/commands.ts` — same.

**Why "loop till empty" instead of paginated UI:** PoC scope. Even an active dev session is unlikely to exceed the SQLite store's `PAGE_SIZE = 50`, but if it does the user wants to see all of them in `/sessions` output. Real apps add their own UI.

### F.2 SQLite `leaf_id` persistence

**Drop-and-recreate (per user choice):**

Three SQLite packages, two migration patterns:

- `bodhi-pi-node/`: drizzle-kit-managed migrations under `drizzle/0000_sessions_table.sql`. Add `drizzle/0001_drop_recreate_with_leaf_id.sql` with explicit DROP+CREATE. `drizzle.config.ts` is already set up. Update `src/sessions/schema.ts` to add `leafId: text("leaf_id")`.
- `bodhi-pi-ws-server/` and `bodhi-pi-http/`: monolithic `SCHEMA_SQL` in `src/sessions/migrate.ts` (`bodhi-pi-http/src/server/sessions/migrate.ts`). Switch the relevant `CREATE TABLE IF NOT EXISTS` to `DROP TABLE IF EXISTS sessions; DROP TABLE IF EXISTS session_entries; CREATE TABLE sessions (..., leaf_id TEXT, ...);`. The migrate.ts comment already says "when we hit our first destructive change … graduate to versioned migrations" — this IS that moment, but for PoC stance we keep the inline pattern.

**Store impl deltas (each of the three SQLite stores):**

```ts
// load() — add leaf_id to the projection and SessionRecord shape:
const record: SessionRecord = {
  id: row.id, cwd: row.cwd, createdAt, updatedAt,
  leafId: row.leafId ?? null,    // NEW
  entries: ...,
};

// setLeafId — currently absent; add as a real impl:
setLeafId(sessionId, entryId) {
  db.update(sessions).set({ leafId: entryId }).where(eq(sessions.id, sessionId)).run();
  return Promise.resolve();
},

// forkRecord — at the existing INSERT for the new sessions row, also set leaf_id
// to the last copied entry id (the new session's leaf). All three stores
// already compute this; add to the values object.
```

Dexie store: schema is `id, cwd, updatedAt`. Add `leafId` to the index spec and to the row shape; update `setLeafId` and `forkRecord` similarly.

In-memory store (`bodhi-pi/src/sessions/in-memory-session-store.ts`): already implements `setLeafId` correctly; no change.

**http handler unchanged:** `_bodhi-pi/session/navigate` already calls `setLeafId?.()` (no-op today). Once stores persist, http per-turn `resumeSession` reads `record.leafId` via the existing fallback in `rehydrateSession`.

### F.3 Branch summarization on cross-branch `/goto`

**Cross-branch detection** (in `handleSessionNavigate`, `packages/bodhi-pi/src/acp/agent.ts:535`):

Given `oldLeafId` (current `session.leafId`) and `targetEntryId`:
1. Walk parentId chain from `targetEntryId` back to root → `targetPath` (set of ids).
2. If `oldLeafId` is in `targetPath`, navigation is forward/equal — no summary needed.
3. Otherwise, walk parentId chain from `oldLeafId` back; the first entry whose id appears in `targetPath` is the **common ancestor**.
4. The **abandoned tail** = entries from `oldLeafId` (inclusive) back to but not including the common ancestor. Reverse for chronological order.
5. If the abandoned tail has any user/assistant messages, generate a `BranchSummaryEntry`.

**Generation** (new `packages/bodhi-pi/src/sessions/branch-summary.ts`, ports `coding-agent/src/core/compaction/branch-summarization.ts`):

- `prepareBranchSummary(abandonedTail, settings)` → `{ messagesToSummarize, fileOps }` — same shape as `prepareCompaction` but anchored to a tail rather than a cut-point.
- `runBranchSummary(preparation, model, apiKey)` → `{ summary, fromId, details }` — calls `completeSimple` with the same `SUMMARIZATION_SYSTEM_PROMPT` (reused from `compaction.ts`); appends file-ops via existing `formatFileOperations`.

**Wiring in handleSessionNavigate:**

```ts
// After the existing target-exists check, before setLeafId:
const oldLeaf = session.leafId;
const crossBranch = detectCrossBranch(record.entries, oldLeaf, targetEntryId);
if (crossBranch && oldLeaf) {
  const preparation = prepareBranchSummary(crossBranch.abandonedTail, this.compactionSettings);
  if (preparation && preparation.messagesToSummarize.length > 0) {
    try {
      const apiKey = await this.resolveApiKeyForCompaction(model.provider);
      if (apiKey) {
        const result = await runBranchSummary(preparation, model, apiKey);
        await this.appendEntry(sessionId, session, {
          type: "branch_summary",
          id: randomUUID(),
          parentId: targetEntryId,             // attach to the new branch's leaf
          timestamp: Date.now(),
          fromId: crossBranch.commonAncestorId,
          summary: result.summary,
          ...(result.details ? { details: result.details } : {}),
        });
        // appendEntry advances session.leafId to the branch_summary entry's id;
        // the next setLeafId below would clobber that, so skip it.
        return { leafId: session.leafId };
      }
    } catch {
      // Non-fatal: continue with plain navigate
    }
  }
}
await this.config.sessionStore.setLeafId?.(sessionId, targetEntryId);
session.leafId = targetEntryId;
// ...existing rebuild of piAgent.state.messages
```

**Replay parity:** `buildSessionContext` (`packages/bodhi-pi/src/sessions/build-context.ts:appendIfMessage`) already converts `branch_summary` entries to synthesized user messages — no changes needed there.

### F.4 Provider-overflow auto-compaction recovery

**Trigger point** (in `packages/bodhi-pi/src/acp/agent.ts:782` — the `outcome.stopReason === "error"` branch in `prompt()`):

```ts
if (outcome.stopReason === "error") {
  // Existing emitAgentEnd
  const recovered = await this.tryOverflowRecovery(sessionId, session, promptText, outcome);
  if (recovered) {
    return recovered;     // already emitted agent_end + auto-compact + retried
  }
  throw new RequestError(-32603, outcome.errorMessage ?? "model error");
}
```

**`tryOverflowRecovery`** logic:
1. Get the last assistant message from `session.piAgent.state.messages`. If none or already-attempted (session-scoped flag), return null.
2. Call `isContextOverflow(lastAssistantMsg, model.contextWindow)`. If false, return null.
3. Set `session._overflowRecoveryAttempted = true`.
4. Strip the failed assistant message from `session.piAgent.state.messages` (so the retry doesn't include it as history).
5. Run the same `prepareCompaction` + `runCompaction` + appendEntry sequence we use in `checkAutoCompact`. Pass `customInstructions: undefined` and the same model.
6. Re-run `session.piAgent.prompt(promptText)` and `waitForIdle()`. If the second attempt succeeds, emit a fresh `agent_end` and return the prompt response. If it fails again, return null (caller throws).

**Re-entrancy guard:** `_overflowRecoveryAttempted` lives on `SessionState` (`packages/bodhi-pi/src/acp/agent.ts:111`). Reset to `false` at the start of every `prompt()` call (alongside `session.cancelled = false`).

**No per-host work:** existing prompt handlers swallow the response shape; the retry is transparent.

---

## 4. Per-runtime breakdown (depth-first per the project rule)

Each sub-feature runs through `core → adapter (if any) → cli → web → ws-frontend → http → chrome-ext` with passing tests at every step before moving on.

### F.1 Cursor pagination

| Order | Where | Change | Test |
|---|---|---|---|
| 1 | `bodhi-pi/test/sessions-pagination.test.ts` *(new)* | n/a | Faux harness with rigged `PAGE_SIZE` (use real impl): seed 100 sessions, call `clientConn.listSessions({cwd})` repeatedly with `cursor`, assert all 100 returned with no duplicates and final `nextCursor === undefined`. |
| 2 | `bodhi-pi-cli/src/repl/commands.ts` | switch `/sessions` to `clientConn.listSessions(...)`; loop until `nextCursor` undefined | `bodhi-pi-cli/e2e/sessions-pagination.e2e.ts` *(new)* — seed real SQLite via faux harness with N=51, run `/sessions`, assert all 51 lines present in stdout. |
| 3 | `bodhi-pi-browser/src/ui/commands.ts` (shared by web + chrome-ext) | same loop in web `/sessions` case | `bodhi-pi-web/e2e/sessions-pagination.spec.ts` + `bodhi-pi-chrome-ext/e2e/sessions-pagination.spec.ts` — seed N>PAGE_SIZE sessions via repeated `/new` + send; `/sessions` system message contains all. |
| 4 | `bodhi-pi-ws-frontend/src/ui/commands.ts` | same | `bodhi-pi-ws-frontend/e2e/m13-sessions-pagination.spec.ts` |
| 5 | `bodhi-pi-http/src/frontend/ui/commands.ts` | same loop using `ctx.client.listSessions({cursor})` | `bodhi-pi-http/test/integration/session-list-pagination.test.ts` (faux) — seeds via RPC, walks pages. |

### F.2 SQLite leaf_id (drop-and-recreate)

| Order | Where | Change | Test |
|---|---|---|---|
| 1 | `bodhi-pi-node/src/sessions/schema.ts` + new `drizzle/0001_drop_recreate_with_leaf_id.sql` | add `leaf_id text` column; migration drops + recreates `sessions` and `session_entries` | existing `bodhi-pi-node/test/sqlite-session-store.test.ts` keeps passing; add a `setLeafId persists across reload` test. |
| 2 | `bodhi-pi-node/src/sessions/sqlite-session-store.ts` | implement `setLeafId`; surface `leafId` in `load()`; set leaf_id in `forkRecord` INSERT | unit test extension above. |
| 3 | `bodhi-pi-ws-server/src/sessions/migrate.ts` + `schema.ts` + `sqlite-session-store.ts` | identical changes (DROP+CREATE in `SCHEMA_SQL`); set/load/fork | extension to `bodhi-pi-ws-server/test/sqlite-session-store.test.ts`. |
| 4 | `bodhi-pi-http/src/server/sessions/migrate.ts` + `schema.ts` + `sqlite-session-store.ts` | identical changes | new `bodhi-pi-http/test/integration/session-goto-persistence.test.ts` — faux + multi-request: send turn → `/navigate` to user msg → fresh request `/prompt` → assert subsequent `/entries` reflects the rewound branch. |
| 5 | `bodhi-pi-browser/src/sessions/dexie-session-store.ts` | add `leafId` to row schema + index; implement setLeafId/load/forkRecord | extension to existing dexie tests. |

After F.2 lands, update `packages/bodhi-pi/PARITY.md`: flip `/goto` from "⚠ partial" to ✅, drop the "leaf_id schema work which is deferred" caveat.

### F.3 Branch summarization

| Order | Where | Change | Test |
|---|---|---|---|
| 1 | `bodhi-pi/src/sessions/branch-summary.ts` *(new)* | port `prepareBranchSummary` + `runBranchSummary` from `coding-agent/src/core/compaction/branch-summarization.ts`, adapted to bodhi-pi's Message-only AgentMessage (no custom roles) | n/a (helper only). |
| 2 | `bodhi-pi/src/acp/agent.ts:handleSessionNavigate` | add `detectCrossBranch` helper + branch-summary trigger before `setLeafId` | `bodhi-pi/test/branch-summary.test.ts` *(new)*: faux harness; build A→B→C chain, navigate to fresh user message off A, assert a `branch_summary` entry appears with `summary` matching faux LLM response and `fromId === <common ancestor>`. Also assert NO summary on forward navigation (target's chain includes oldLeaf). |
| 3 | per-host e2e | none new — extend existing `tree-navigate.spec.ts` to send a /goto then `/tree` and check a `branch_summary` node appears (cross-branch case only) | extend in cli, web, ws-frontend, chrome-ext (4 specs). http: no /goto integration today, but after F.2 lands the http `session-goto-persistence.test.ts` can also verify branch_summary. |

### F.4 Overflow auto-compact

| Order | Where | Change | Test |
|---|---|---|---|
| 1 | `bodhi-pi/src/acp/agent.ts` | add `_overflowRecoveryAttempted` to SessionState; reset in `prompt()`; add `tryOverflowRecovery` helper; intercept the existing error branch | `bodhi-pi/test/overflow-recovery.test.ts` *(new)*: faux harness with `setResponses([overflowMsg, summaryMsg, successMsg])`; the overflow message has `stopReason: "error"` + `errorMessage: "prompt is too long: 200000 tokens > 100000 maximum"` (matches Anthropic pattern in pi-ai's overflow.ts); assert `prompt()` returns `end_turn` (not throws), a `compaction` entry exists, and `_overflowRecoveryAttempted` resets on next prompt. Also assert second consecutive overflow → throws (already-attempted guard). |
| 2 | `packages/bodhi-pi/PARITY.md` | flip "Overflow-driven compaction recovery" from ⏭ to ✅ | n/a |

No per-host e2e for F.4 — same rationale as Phase E.

---

## 5. Critical files to touch

```
packages/bodhi-pi/
  src/acp/agent.ts                            # F.3 navigate handler, F.4 prompt error path
  src/sessions/branch-summary.ts              # F.3 NEW (port from coding-agent)
  test/sessions-pagination.test.ts            # F.1 NEW (core)
  test/branch-summary.test.ts                 # F.3 NEW
  test/overflow-recovery.test.ts              # F.4 NEW
  PARITY.md                                   # update F.2 and F.4 status

packages/bodhi-pi-node/
  drizzle/0001_drop_recreate_with_leaf_id.sql # F.2 NEW migration
  src/sessions/schema.ts                      # F.2 add leaf_id column
  src/sessions/sqlite-session-store.ts        # F.2 setLeafId + load + forkRecord
  test/sqlite-session-store.test.ts           # F.2 extend

packages/bodhi-pi-ws-server/
  src/sessions/migrate.ts                     # F.2 SCHEMA_SQL drop+recreate
  src/sessions/schema.ts                      # F.2 add leaf_id
  src/sessions/sqlite-session-store.ts        # F.2 setLeafId + load + forkRecord

packages/bodhi-pi-http/
  src/server/sessions/migrate.ts              # F.2 SCHEMA_SQL drop+recreate
  src/server/sessions/schema.ts               # F.2 add leaf_id
  src/server/sessions/sqlite-session-store.ts # F.2 setLeafId + load + forkRecord
  src/frontend/ui/commands.ts                 # F.1 /sessions loop
  test/integration/session-list-pagination.test.ts  # F.1 NEW
  test/integration/session-goto-persistence.test.ts # F.2 NEW

packages/bodhi-pi-browser/
  src/sessions/dexie-session-store.ts         # F.2 leafId on row + setLeafId + forkRecord
  src/sessions/db.ts                          # F.2 update Dexie schema spec
  src/ui/commands.ts                          # F.1 /sessions loop

packages/bodhi-pi-cli/
  src/repl/commands.ts                        # F.1 /sessions loop (also moves CLI to clientConn — blackbox cleanup)
  e2e/sessions-pagination.e2e.ts              # F.1 NEW
  (extend e2e/tree-navigate.e2e.ts)           # F.3 branch_summary assertion

packages/bodhi-pi-web/
  src/ui/commands.ts is shared via bodhi-pi-browser dist; only e2e changes
  e2e/sessions-pagination.spec.ts             # F.1 NEW
  (extend e2e/tree-navigate.spec.ts)          # F.3 branch_summary assertion

packages/bodhi-pi-ws-frontend/
  src/ui/commands.ts                          # F.1 /sessions loop
  e2e/m13-sessions-pagination.spec.ts         # F.1 NEW
  (extend e2e/m13-tree-navigate.spec.ts)      # F.3 branch_summary assertion

packages/bodhi-pi-chrome-ext/
  e2e/sessions-pagination.spec.ts             # F.1 NEW
  (extend e2e/tree-navigate.spec.ts)          # F.3 branch_summary assertion
```

## 6. Reuse map (existing functions/utilities)

- `buildSessionContext`, `walkPath` (`packages/bodhi-pi/src/sessions/build-context.ts`) — already render `branch_summary` entries; F.3 just needs to write them.
- `prepareCompaction`, `runCompaction`, `formatFileOperations`, `serializeConversation`, `SUMMARIZATION_SYSTEM_PROMPT` (`packages/bodhi-pi/src/sessions/compaction.ts`) — F.3's branch-summary helper reuses the serializer + system prompt; the only new piece is the slicing helper that anchors to the abandoned tail rather than a cut-point.
- `isContextOverflow(message, contextWindow?)` (`@mariozechner/pi-ai`) — F.4 imports verbatim. Three-case detection (error pattern / silent overflow / length+output=0 truncation) is already comprehensive.
- `appendEntry()` (`packages/bodhi-pi/src/acp/agent.ts:181`) — F.3 uses for the branch_summary append; advances `session.leafId` automatically (so the subsequent `setLeafId` is unnecessary in the cross-branch path).
- Existing SQLite cursor encoders (`parseCursor`/cursor encoding lines 51–63 in `bodhi-pi-node`) — F.1 reuses; no new code in adapters.

## 7. Verification

After every step:

```bash
# Per-package, depth-first:
npm --workspace @bodhiapp/bodhi-pi run build
npm --workspace @bodhiapp/bodhi-pi run test
npm --workspace @bodhiapp/bodhi-pi run test:e2e

npm --workspace @bodhiapp/bodhi-pi-node run test
# repeat for bodhi-pi-ws-server, bodhi-pi-http (test, not test:e2e)
npm --workspace @bodhiapp/bodhi-pi-browser run build
npm --workspace bodhi-pi-cli run test:e2e
# ...etc per host
```

After each sub-feature lands across all hosts:

```bash
just test                   # full repo
git checkout packages/ai/src/models.generated.ts   # generated upstream — restore before commit
git commit -m "feat(bodhi-pi): <sub-feature> (Phase F.N)"
```

End-of-Phase F manual smoke (CLI):

1. Seed 60 sessions via repeated `/new` + a 1-token prompt; `/sessions` lists all 60 across pages.
2. `/new`, send 3 turns, `/entries`, `/goto <first user msg>`, send a divergent turn, `/tree` shows a `branch_summary` node attached to the new branch.
3. Verify `/goto` survives a CLI restart against the same SQLite path (F.2 proof).
4. Auto-compact overflow: with a real model (or scripted faux), force a context-overflow error; the next response succeeds and a compaction entry exists.

---

## 8. Open risks

- **F.1 CLI refactor:** moving `/sessions` from `ctx.sessionStore` to `ctx.clientConn` removes a whitebox seam that's been there since Phase A; existing `bodhi-pi-cli/e2e/sessions.e2e.ts` may need a small adjustment. Verify before committing.
- **F.2 drop-and-recreate:** existing dev DBs lose their session history on next boot. Acceptable per the user's PoC stance, but worth a one-line note in the commit body.
- **F.3 cross-branch-detection edge cases:** entries with `parentId === undefined` (legacy entries written before Phase A) may not have a clean ancestor walk. `walkPath`'s array-order fallback covers replay but not branch detection — guard against it (no summary if either chain bottoms out at array-order).
- **F.4 retry semantics:** if the model returns a *different* error on retry (e.g., rate limit), the response should propagate without further compaction. The `_overflowRecoveryAttempted` guard handles re-overflow but the test should also cover non-overflow second errors.
