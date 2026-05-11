# Phase 0 — Upstream alignment audit (post-0.74 rebase)

**Date:** 2026-05-11
**Codename:** scalable-pelican
**Prompt:** `ai-docs/prompts/group-0-upstream-alignment.md`
**Process:** `ai-docs/prompts/process.md`
**Source diff:** `ai-docs/research/upstream-sync-2026-05-11.md`

---

## Context

Between upstream commits `50993d74` (2026-05-07) and `f348a062` (2026-05-10),
upstream landed an `AgentHarness` abstraction under `packages/agent/src/harness/`
that re-implements primitives bodhi-pi has been building in parallel since
Phase A: `session/*`, `compaction/*`, `skills`, `prompt-templates`,
`system-prompt`, `messages`. The rebase was kept minimal — only the
`@mariozechner/*` → `@earendil-works/*` rename plus two small patches:

1. one subpath import in `bodhi-pi-browser/worker-entry`
2. one test narrowing in `build-context.test.ts` (`"content" in m`)
3. one `as unknown as AgentMessage` cast at a custom-message call site

This phase decides, per harness module, which of bodhi-pi's parallel impls
to keep, swap, or revisit later. It does not refactor sessions wholesale.
The one code-change deliverable is wiring `AgentLoopConfig.prepareNextTurn`
so the post-compaction recovery path no longer requires a second
`agent.loop()` call from bodhi-pi.

**Decided scope (after Q&A):**

| Outcome | Decision |
|---|---|
| #1 Harness audit decision table | **In** — table in `PARITY.md`, rationale appendix in research doc. Default stance: *wait & reuse as reference*. |
| #2 `prepareNextTurn` adoption | **In** — overflow recovery moves inside one `agent.loop()` call. |
| #3 Fireworks compat docs | **Out** — skip, no user has asked. |
| #4 `AgentMessage` widening response | **In, but decision = defer.** Keep the existing cast + `"content" in m` narrowing. Record the decision in the appendix. |
| #5 File upstream module-augmentation bug | **Out** — defer; capture a paragraph in the appendix explaining why. |

No new user-visible feature. No per-host e2e additions. Payoff:
"future syncs are cheaper" + "post-compaction model swap is simpler".

---

## Non-goals (explicit)

- Full migration of `bodhi-pi/sessions`, `skills`, `commands` to harness
  primitives. That follows from this audit's recommendations — and only
  if a later sync settles the upstream churn.
- New `pi-ai` images API (image *output* generation — Group 7 will only
  cover image *input*).
- Adopting the Together provider (consumer-side opt-in only).
- Restoring `tsconfig.base.json` `paths` (file-resolution through
  `node_modules` symlinks works fine post-rename).
- Bash tool / `harness/utils/shell-output.ts` — Phase H (tooling).

---

## Outcome 1 — Harness audit decision table

**Default stance:** *keep parallel impl, revisit on next sync*.
Upstream `harness/session/*` storage layout churned 7× during the rebase
window; adopting now means tracking churn. bodhi-pi's DAG/parentId model,
cursor pagination, cross-branch detection, and per-host stores
(SQLite/Dexie/in-memory) are feature-richer than harness today.

### Table rows (write these into both deliverables)

| Harness module | bodhi-pi parallel | Decision | Rationale (1 line) |
|---|---|---|---|
| `harness/session/{session,repo/*,storage/*}` | `bodhi-pi/src/sessions/{session-store,in-memory-session-store}.ts` + `bodhi-pi-node/sqlite-session-store.ts` + `bodhi-pi-browser/dexie-session-store.ts` | **Keep parallel — revisit next sync** | bodhi-pi has DAG/parentId, cursor pagination, fork-with-chain-walk; harness layout churned 7×. |
| `harness/compaction/compaction.ts` | `bodhi-pi/src/sessions/compaction.ts` | **Keep parallel — reuse as reference** | Heavy overlap (~300 LOC potential win) but `runCompaction` calls `agent.loop()`; adoption needs orchestration migration too. |
| `harness/compaction/branch-summarization.ts` | `bodhi-pi/src/sessions/branch-summary.ts` | **Keep parallel** | Cross-branch detection (`detectCrossBranch`) is bodhi-pi-specific; pure helpers are isomorphic. |
| `harness/messages.ts` (incl. `CustomAgentMessages` augmentation) | inlined `convertToLlm`-equivalent in `acp/agent.ts` + `sessions/build-context.ts` | **Keep parallel; record cast workaround** | The augmentation is the load-bearing piece — see Outcome #4. |
| `harness/prompt-templates.ts` | `bodhi-pi/src/commands/{prompt-templates,discovery}.ts` | **Keep parallel** | bodhi-pi convention (`$1`/`$@`/`${@:N:L}`) is established; compare on next sync. |
| `harness/skills.ts` | `bodhi-pi/src/skills/*` | **Keep parallel** | `allowed-tools` enforcement is a deferred PARITY row; revisit when that lands. |
| `harness/system-prompt.ts` | `bodhi-pi/src/skills/system-prompt.ts:composeSystemPrompt` | **Keep parallel — note for Group 2** | Group 2 (Phase G) adds a coding-agent-flavoured prompt; harness's prompt is generic. |
| `harness/execution-env.ts` + `env/nodejs.ts` | `bodhi-pi/src/filesystem/filesystem.ts` + `script-executor/script-executor.ts` | **Keep parallel — permanent split** | bodhi-pi splits FS / shell / sessions across three injected interfaces by design (browser CSP, sandboxing). |
| `harness/utils/shell-output.ts` | none yet | **Adopt later (Phase H)** | No bash tool today; when it lands, reuse harness semantics. |
| `harness/utils/truncate.ts` | `bodhi-pi/src/tools/_accumulate.ts` (`accumulateBounded`, `truncationFooter`) | **Keep parallel — semantic spot-check** | Both bound output by bytes/lines; confirm `byteLength` vs JS-string-length matches the read.ts pattern. No code change. |

### Two short notes appended to the table

1. **AgentMessage widening (Outcome #4):** decision is to keep the
   existing `as unknown as AgentMessage` cast and the
   `"content" in m && Array.isArray(m.content)` narrowing in
   `build-context.test.ts`. Documented for future-me; revisit if the
   harness widening cascades into more call sites.
2. **Upstream module-augmentation bug (Outcome #5):** deferred. The
   harness in `packages/agent/src/harness/messages.ts:56` augments via
   the relative path `"../types.js"`; downstream consumers (e.g.,
   `packages/web-ui/example/src/custom-messages.ts:21`) augment via the
   package name `"@earendil-works/pi-agent-core"`. TS treats these as
   different canonical modules → augmentations don't merge. We work
   around with one cast. File on next sync if still present.

---

## Outcome 2 — Adopt `prepareNextTurn` for overflow recovery

### Today (`packages/bodhi-pi/src/acp/agent.ts`)

- `prompt()` at line 773 sets `overflowRecoveryAttempted = false`, calls
  `session.piAgent.prompt(promptText)`, then `waitForIdle()`.
- On `stopReason === "error"` the surrounding code at line 832 calls
  `tryOverflowRecovery()` (line 903).
- `tryOverflowRecovery()` guards via `overflowRecoveryAttempted`,
  inspects `isContextOverflow(lastAssistant, contextWindow)` from
  `@earendil-works/pi-ai`, drops the failed assistant message,
  `prepareCompaction()` → `runCompaction()` → appends `CompactionEntry`,
  rebuilds messages via `buildSessionContext()`, then calls
  `session.piAgent.prompt(promptText)` a *second* time.
- Net: two `agent.loop()` invocations from bodhi-pi on the recovery path.

### `prepareNextTurn` timing (confirmed by exploration)

`AgentLoopConfig.prepareNextTurn(ctx: PrepareNextTurnContext)`:

- Defined in `packages/agent/src/agent-loop.ts` around line 226.
- Fires **after** `turn_end` is emitted (line 218), **after** the
  assistant message + tool-result messages have been appended to
  `currentContext.messages`, and **before** the next provider request.
- Returns `AgentLoopTurnUpdate | undefined | Promise<...>` —
  `{context?, model?, thinkingLevel?}`. Returning a new `context` swaps
  state for the next turn inside the **same** `loop()` call.

### Timing nuance to confirm during implementation

`prepareNextTurn` only fires on a *successful* `turn_end`. The current
overflow recovery is triggered by `stopReason === "error"` — a failed
turn does **not** emit `turn_end`. So the migration is not a pure
1-for-1 swap; two viable shapes:

- **Shape A (recommended for this phase): proactive in-loop compaction.**
  Inside `prepareNextTurn`, run `shouldCompact(estimateContextTokens(...),
  contextWindow, settings)` — if true, run compaction synchronously,
  rebuild context, and return the new context. The reactive
  `tryOverflowRecovery` path stays as a safety net (e.g. for sudden
  overflows that token estimation didn't predict). Net win: most
  overflows are prevented mid-loop without bodhi-pi orchestrating a
  second `loop()`.
- **Shape B (deferred): reactive recovery via a new agent-loop hook.**
  Would require an upstream addition like `onTurnError?: ...`. Out of
  scope; mention in the appendix.

**Recommendation:** implement Shape A. Keep `tryOverflowRecovery`
unchanged as a fallback (so `overflow-recovery.test.ts` continues to
exercise the reactive path with a faux provider that bypasses the
proactive estimator). Add one new test asserting the proactive path
fires and swaps context — i.e. the second `agent.loop()` is *not*
called on the proactive scenario.

### Concrete edits

- **`packages/bodhi-pi/src/acp/agent.ts`** — extend the
  `AgentLoopConfig` constructed inside `_buildSessionState()` /
  wherever the `PiAgent` is created with a `prepareNextTurn` callback.
  The callback reads `ctx.context.messages`, computes
  `estimateContextTokens` + `shouldCompact`, and on hit:
  - calls `prepareCompaction(record.entries, settings)` (existing helper)
  - calls `runCompaction(prep, model, apiKey)` (existing helper)
  - appends a `CompactionEntry` via `appendEntry(...)` (existing private)
  - rebuilds context via `buildSessionContext(record, session.leafId)`
  - returns `{context: rebuiltContext}` to swap mid-loop.

  Cancellation: respect `session.cancelled` — if cancelled mid-callback,
  return `undefined` (no swap). Errors from the LLM compaction call:
  swallow + log; return `undefined` so the loop falls through to the
  reactive path on the next overflow error.

- **`packages/bodhi-pi/src/sessions/compaction.ts`** — no signature
  changes; verify `prepareCompaction` + `runCompaction` are reentrant
  per-turn. (They already are — used by both `tryOverflowRecovery` and
  the post-prompt `checkAutoCompact`.)

- **`packages/bodhi-pi/test/`** — add
  `prepare-next-turn-wiring.test.ts`:
  - Faux provider: respond with a normal assistant turn whose `usage`
    pushes estimated tokens past the threshold (use a tiny
    `contextWindow` model just like `overflow-recovery.test.ts`).
  - Assert: (a) a `CompactionEntry` is appended within the same prompt
    cycle; (b) the next provider request's first message contains the
    `<context-summary>` framing (i.e. compaction landed in-loop); (c)
    bodhi-pi did **not** invoke `session.piAgent.prompt` a second time
    — spy on a `piAgent.prompt`-equivalent seam (or assert via call
    count on the faux provider's request log).
- **`packages/bodhi-pi/test/overflow-recovery.test.ts`** — must still
  pass unchanged. If the proactive path inadvertently fires too eagerly
  in this test, gate the proactive callback behind a config flag
  (default on; off in the legacy test) — but first try without a flag,
  since the existing test deliberately constructs an immediate-overflow
  scenario that the estimator can't predict.

### Risk

- The estimator (`estimateContextTokens` + `estimateTokens`) is heuristic
  (chars/4). If it under-counts, the proactive callback won't fire and
  recovery still goes through the reactive path — no regression. If it
  over-counts, compaction fires too often — annoying but not broken.
  Acceptable for this phase.
- The proactive callback adds an LLM call inside `prepareNextTurn`. If
  it throws or the provider 5xxs mid-loop, ensure the throw doesn't
  kill the user's turn — wrap in try/catch, log, return `undefined`.

---

## Outcome 4 — AgentMessage widening: decision = defer

**No code change.** Record in the audit appendix:

- bodhi-pi's contract is `AgentMessage = Message` (user / assistant /
  toolResult only). The harness's `CustomAgentMessages` augmentation
  widens this with `bashExecution` / `branchSummary` /
  `compactionSummary` — none of which bodhi-pi emits.
- Workaround in place: one `as unknown as AgentMessage` cast at the
  custom-message call site, plus `"content" in m && Array.isArray(m.content)`
  narrowing in `build-context.test.ts` (lines 69 + 96 per the rebase
  patch).
- Why defer the opt-out: the cleaner approach (declaring the harness
  roles as `never` in bodhi-pi's own `CustomAgentMessages` augmentation)
  requires deep TS module-augmentation interaction with re-exports —
  non-trivial, and re-exposes to the bug in Outcome #5. Revisit when
  Outcome #5 is filed and resolved upstream.

---

## Critical files

**Read first**

- `packages/bodhi-pi/src/acp/agent.ts` (lines 773–950 — prompt loop +
  overflow recovery + `tryOverflowRecovery` + `_buildSessionState`)
- `packages/bodhi-pi/src/sessions/compaction.ts` — `runCompaction`,
  `prepareCompaction`, `estimateContextTokens`, `shouldCompact`,
  `getLastAssistantUsage` (all reusable as-is)
- `packages/bodhi-pi/src/sessions/build-context.ts` —
  `buildSessionContext`, `walkPath` (reusable)
- `packages/agent/src/agent-loop.ts` — search `prepareNextTurn` (~226)
  for the call-site shape, and `PrepareNextTurnContext` /
  `AgentLoopTurnUpdate` for the types
- `packages/bodhi-pi/test/overflow-recovery.test.ts` — pattern to copy
- `packages/bodhi-pi/test/helpers/harness.ts` — `createTestHarness`,
  `registerFauxProvider`

**Edit (this phase)**

- `packages/bodhi-pi/src/acp/agent.ts` — wire `prepareNextTurn`
- `packages/bodhi-pi/test/prepare-next-turn-wiring.test.ts` — new
- `packages/bodhi-pi/PARITY.md` — new section "Upstream alignment
  (2026-05-11)" + compact audit table linking to research doc
- `ai-docs/research/upstream-sync-2026-05-11.md` — new "Adoption
  decisions" appendix (rationale per row + the two short notes on
  Outcomes 4 & 5)

---

## Verification

End-to-end gate (run from repo root):

1. `npx tsgo --noEmit -p packages/bodhi-pi/tsconfig.json` — types
2. `npm --workspace packages/bodhi-pi test` — unit + integration.
   - `overflow-recovery.test.ts` green (reactive path preserved)
   - `prepare-next-turn-wiring.test.ts` green (proactive path)
3. `just test` — full repo gate. Investigate per-package failures
   individually before declaring a regression.
4. `npm run check` — biome + tsgo + browser smoke (also runs as
   pre-commit; must pass without `--no-verify`).
5. Restore `packages/ai/src/models.generated.ts` (`git checkout
   packages/ai/src/models.generated.ts`) before committing — it's
   regenerated upstream; pre-commit's tsgo trips otherwise.

No per-host e2e additions. No real-LLM e2e in this phase (per prompt).

---

## Commit shape

Single conventional commit:

```
feat(bodhi-pi): adopt prepareNextTurn + audit harness (Phase 0)

- prepareNextTurn wired for proactive mid-loop compaction; reactive
  tryOverflowRecovery preserved as safety net.
- Harness adoption audit recorded — see PARITY.md ("Upstream alignment
  2026-05-11") and ai-docs/research/upstream-sync-2026-05-11.md
  appendix "Adoption decisions". Default stance: keep parallel impls,
  revisit on next sync.
- AgentMessage widening: decision deferred (one cast workaround retained).
- Upstream module-augmentation bug: filing deferred, rationale in
  research doc.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```
