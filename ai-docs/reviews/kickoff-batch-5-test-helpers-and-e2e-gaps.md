# Batch 5 — Test helpers + e2e gap fills

**Read first:** `ai-docs/reviews/process.md` (review-driven workflow rules,
including the **Standard verification sequence**, the **batch 2
retrospective** in §5a, the **batch 3 retrospective** in §5b, AND the
**batch 4 retrospective** in §5c — pay attention to the plan-time grep
should-cover-tests note and the parallel-resource-flake guidance) AND
`ai-docs/prompts/process.md` (matrix-wide rules for slash commands,
adapter conventions, blackbox testing).
**Review batch in scope:**
- Batch H (test helper extraction + e2e gap fills) of
  `ai-docs/reviews/2026-05-11-bodhi-pi-tech-debt.md` — findings H.1, H.2,
  H.3. The H.3 settings/kv sub-list is unblocked now that batch 1 shipped
  the `config_option_update` notification and batch 4 shipped the
  slashable refresh hook + `_bodhi-pi/session/settings/list` is the
  single source of truth for layered settings.
**Prior batches (just shipped):**
- Batch 1 — stable-ACP notifications + event-system overhaul + dead-code
  (`ai-docs/plans/smooth-purring-patterson.md`).
- Batch 2 — `sessions/` dedup + `runSummarizationLLM` extraction.
- Batch 3 — `agent.ts` decomposition (B.1–B.9) + B.10 BREAKING removal of
  the hardcoded `gpt-4o-mini` fallback (`ai-docs/reviews/kickoff-batch-3-agent-decomposition.md`).
- Batch 4 — F.1 capabilities `_meta` collapse + F.2 `EXT_SESSION_CONFIG`
  slim + E.4 slashable refresh hook + `pi.requestSlashableRefresh(sessionId)`
  (`ai-docs/reviews/kickoff-batch-4-acp-hygiene-and-slashable-refresh.md`).
  Read its **Decision log entries** in the review (especially the six
  batch-4 entries about `_meta` shape, F.2 clean-break, E.4 implicit +
  explicit, no-debouncing, `session.commands` re-merge, and three-commit
  cadence) before extending the e2e helpers in this batch — the new
  `requestSlashableRefresh` API is the seam several H.3 e2e tests will
  lean on.
**Reference impl:**
- `packages/bodhi-pi/test/helpers/` (existing harness, narrowing helpers,
  event recorder, in-process ACP pair) — extend these, don't fork.
- `packages/bodhi-pi/test/auto-compact.test.ts` and
  `packages/bodhi-pi/test/overflow-recovery.test.ts` — the existing
  boilerplate that H.1 extracts; read both to confirm the shared shape.
- `packages/bodhi-pi/e2e/compaction.e2e.ts` — the existing 56-line manual
  `/compact` e2e; H.2 adds an auto-compact sibling to it.
- `packages/bodhi-pi/e2e/commands.e2e.ts` and
  `packages/bodhi-pi/e2e/extensions.e2e.ts` — the closest stylistic
  templates for the new H.3 e2e files (real `gpt-4o-mini`, side-effect
  + stable-substring assertions, no exact model-text matching).
- `packages/coding-agent/test/suite/` for the upstream pattern of
  isolating provider-pool boilerplate; bodhi-pi diverges (uses faux
  providers, not the upstream `TestHarness`), so don't blindly mirror.

---

## Why this batch

Three test-quality findings that have to ship together because they all
touch the same `test/helpers/` directory and the same e2e harness wiring:

1. **H.1 — `auto-compact.test.ts` and `overflow-recovery.test.ts` share
   a 28-line provider-management prologue.** Imports, the `providers`
   array, `beforeEach`/`afterEach` reset, and the `newProvider()`
   factory are byte-identical between the two files. Same shape also
   appears at the top of `provider-options.test.ts`,
   `session-config-ext.test.ts`, `thinking.test.ts`, and most of
   `extensions.test.ts` — six callers carrying the same prologue.
   Extracting `test/helpers/faux-provider-pool.ts` exposes a single
   `useFauxProviderPool()` that wires the lifecycle and returns a
   `newProvider()` closure. Pure refactor; every test that adopts it
   must continue green.

2. **H.2 — Compaction e2e covers only manual `/compact`.** The
   existing `e2e/compaction.e2e.ts` proves that `/compact` against a
   real LLM produces a summary entry. The auto-compact path
   (`contextTokens > contextWindow - reserveTokens` triggers a
   compaction without user intervention) and the overflow-recovery
   path (post-prompt threshold trigger after a 200k-token overflow)
   both have unit coverage but zero real-LLM validation. Adding
   `e2e/auto-compact.e2e.ts` driving a long conversation against
   `gpt-4o-mini` closes that gap; assert via `EXT_SESSION_TREE` that
   a `CompactionEntry` is appended without a `/compact` slash in the
   transcript.

3. **H.3 — Settings, KV, Sessions DAG, Thinking, Name/Stats/Export
   features have full in-process coverage but no e2e.** Per CLAUDE.md
   "side-effects and stable substrings, not exact model text," each
   area needs one e2e file asserting one stable observable against
   `gpt-4o-mini`. Settings e2e specifically should drive
   `/settings set defaultModel <other>` and assert that the next
   `prompt()` uses the new model id — visible via the
   `before_provider_request` event payload. KV e2e drives
   `/kv set` + `/kv get` round-trip + a stable-substring assertion
   in the LLM output. Sessions DAG e2e drives `/fork` + `/navigate`
   and asserts the branch summary entry surfaces. Thinking e2e
   drives `/thinking high` against a thinking-capable model and
   asserts the `thinking` content block appears in the wire. Name
   e2e drives `/setName` and asserts the name persists across
   `/sessions` listing.

Bundling H.1 + H.2 + H.3 in one batch: the H.1 extraction is a
prerequisite for the H.3 e2e files (they all need the same
`newProvider()` shape, except H.3 also needs a real-LLM model
factory, not a faux one — they coexist), and H.2 + H.3 share the
same `e2e/*.e2e.ts` style so reviewers compare them side-by-side.

---

## Functional outcomes

After this batch:

1. **Six existing test files share one provider-pool helper.**
   `auto-compact.test.ts`, `overflow-recovery.test.ts`,
   `provider-options.test.ts`, `session-config-ext.test.ts`,
   `thinking.test.ts`, and `extensions.test.ts` all import
   `useFauxProviderPool` from `test/helpers/faux-provider-pool.ts` (or
   whatever lands; confirm the exact name during plan). Each file
   drops its inline 28-line prologue. A future test author writing
   a new faux-provider-driven suite can compose the helper instead of
   copy-pasting.

2. **Auto-compact has real-LLM coverage.** A `e2e/auto-compact.e2e.ts`
   file drives a long enough conversation against `gpt-4o-mini` to
   trip `contextTokens > contextWindow - reserveTokens`. The
   `CompactionEntry` is asserted to be present in the session tree
   without `/compact` ever appearing in the transcript. Stops
   silent-regression risk for the auto-compact code path.

3. **Settings/KV/Sessions/Thinking/Name e2e suites exist and assert
   one stable observable each.** Real `gpt-4o-mini`, side-effect-style
   assertions, no exact model-text matching. After this batch, the
   per-feature e2e count matches the per-feature unit-test count —
   no feature lives in unit-tests-only.

4. **The `flushImplicitRefresh` test helper from batch 4's E.4 work
   is upstreamed into `test/helpers/`** (or whatever shape is cleaner
   — confirm during plan). The current location is inline in
   `extensions.test.ts`. If any H.3 e2e exercises a runtime
   `registerCommand`, the helper needs to be importable from one place.

5. **`test/helpers/acp-narrow.ts` gains the `findAllUpdatesOfKind`
   helper** if the batch ends up using the `.filter(u => u.update.sessionUpdate === "X")`
   pattern more than twice. Batch 4 noted this in its plan and
   decided not to upstream (only two callers); H.3's settings e2e
   may push it past the threshold (assertions on `config_option_update`
   + boot advertisement). Confirm during plan whether the helper
   makes sense; if not, leave the inline pattern.

6. **Every existing test in the matrix continues passing.** This is
   a pure-additive batch: helpers extracted, e2e files added, no
   public API or wire shape changed.

---

## Current state vs desired end state

### Current

- `auto-compact.test.ts:1-28`, `overflow-recovery.test.ts:1-28`, and
  four other test files carry a copy-pasted faux-provider lifecycle
  prologue.
- `e2e/compaction.e2e.ts` is the only compaction e2e; auto-compact
  + overflow-recovery have no real-LLM coverage.
- Settings, KV, Sessions DAG, Thinking, Name/Stats/Export have unit
  coverage only; no `e2e/settings.e2e.ts`, `e2e/kv.e2e.ts`,
  `e2e/sessions.e2e.ts`, `e2e/thinking.e2e.ts`,
  `e2e/name-stats-export.e2e.ts`.
- `flushImplicitRefresh` is inline in `test/extensions.test.ts` (batch
  4 left it there because there was one caller).

### Desired

- `test/helpers/faux-provider-pool.ts` exports a single
  `useFauxProviderPool()` (or similar) that wires the lifecycle and
  returns a `newProvider()` closure. The six known callers above
  switch over; new tests use the helper from day one.
- `e2e/auto-compact.e2e.ts` exists and proves auto-compact triggers
  without a manual `/compact`.
- `e2e/settings.e2e.ts`, `e2e/kv.e2e.ts`, `e2e/sessions-dag.e2e.ts`,
  `e2e/thinking.e2e.ts`, `e2e/name-stats-export.e2e.ts` each exist,
  each ~30–60 lines, each driving real `gpt-4o-mini` and asserting one
  stable observable.
- If `findAllUpdatesOfKind` lands, it lives in
  `test/helpers/acp-narrow.ts` next to `findUpdateOfKind`.
- `flushImplicitRefresh` lives in `test/helpers/` if any H.3 test
  needs it; otherwise stays inline in `extensions.test.ts`.

### NOT desired

- **A grand "test refactor" that touches every helper.** Stay scoped to
  H.1/H.2/H.3. The existing narrowing helpers, harness, recorder, faux
  fixtures are fine.
- **Migrating tests to a different test runner or harness shape.**
  Vitest + the existing in-process ACP pair stay.
- **Real-LLM coverage for every unit test.** H.3 adds one e2e per
  feature area, not one per unit test. The bar is "one stable
  observable in real-LLM-land," not "every branch of every test."
- **Touching `packages/bodhi-pi-*/test/`.** Host-side e2e gaps are
  out of scope; this batch is `packages/bodhi-pi` only.
- **Renaming any existing test file.** The H.1 callers keep their
  current paths and current `describe` blocks.

---

## Rough directional pointers

Don't take these as prescriptive — confirm by reading the code first
and re-verifying each finding's `file:line` against current HEAD.

- **Re-verify the H.1 / H.2 / H.3 cites at plan time.** The 28-line
  prologue in `auto-compact.test.ts` and `overflow-recovery.test.ts`
  should still match byte-for-byte at current HEAD; batch 3
  introduced minor edits to nearby tests but didn't touch these
  prologues. Confirm.

- **H.1 helper shape — composable, not auto-wired.** The most
  bodhi-pi-idiomatic shape is a hook-style function that callers
  invoke at top-of-file:
  ```ts
  // test/helpers/faux-provider-pool.ts
  export function useFauxProviderPool() {
    const providers: FauxProviderRegistration[] = [];
    beforeEach(() => {
      providers.length = 0;
    });
    afterEach(() => {
      for (const p of providers) p.unregister();
      providers.length = 0;
    });
    return {
      newProvider: (): FauxProviderRegistration => {
        const p = registerFauxProvider();
        providers.push(p);
        return p;
      },
      modelOf: (faux: FauxProviderRegistration): Model<Api> =>
        faux.getModel() as Model<Api>,
    };
  }
  ```
  Caller becomes:
  ```ts
  const { newProvider, modelOf } = useFauxProviderPool();
  ```
  Confirm during plan that `beforeEach`/`afterEach` inside a
  module-exported function compose correctly with vitest's
  per-file scoping. (They do — vitest registers them against the
  caller's describe scope. But verify with one migration before
  doing all six.)

- **H.2 auto-compact e2e — model + token-budget design.** Use
  `gpt-4o-mini` (cheap, fast, deterministic enough for substring
  assertions). The conversation needs to be long enough to exceed
  `contextWindow - reserveTokens` — typically 3–5 multi-turn prompts
  with explicit instructions to produce verbose responses. Read
  `test/auto-compact.test.ts` for the in-process trigger pattern;
  the e2e mirrors that shape but with a real model. Assert via
  `EXT_SESSION_TREE` that a `CompactionEntry` appears in the
  entries list; the LLM's actual summary text is opaque (CLAUDE.md
  "stable substrings only" applies — assert the entry exists, not
  what it says).

- **H.3 e2e style — one observable per file.** Each new e2e file
  follows the `e2e/commands.e2e.ts` template: one
  `createCliTestHarness`-style setup, real `gpt-4o-mini`, one or
  two prompts, one observable assertion. Specifically:
  - `e2e/settings.e2e.ts`: after `_bodhi-pi/session/settings/set`
    with `key="defaultModel"`, assert via the
    `before_provider_request` event recorder that the next
    `session/prompt` uses the new model id.
  - `e2e/kv.e2e.ts`: round-trip via `_bodhi-pi/kv/set` +
    `_bodhi-pi/kv/get`; then a prompt that references the stored
    value (via an extension that reads kv) and asserts the value
    appears in the LLM's tool input or response.
  - `e2e/sessions-dag.e2e.ts`: drive `_bodhi-pi/session/fork` +
    `_bodhi-pi/session/navigate`; assert the parent sessionId
    appears in `_bodhi-pi/session/tree`.
  - `e2e/thinking.e2e.ts`: `_bodhi-pi/session/set_config_option`
    with `configId="thinking"` value `"high"` against a
    thinking-capable model (e.g. `gpt-5-mini` with reasoning enabled);
    assert a `thinking` content block appears in the streamed reply.
  - `e2e/name-stats-export.e2e.ts`: `_bodhi-pi/session/setName`
    with a unique name; assert it surfaces in
    `_bodhi-pi/session/list` AND in `_bodhi-pi/session/export`'s
    JSONL header line.

- **H.3 commit cadence — three commits, not five.** Even though
  H.3 lists five feature areas, ship them as:
  - **Commit 1 (H.1):** `faux-provider-pool.ts` + six call-site
    migrations. Pure refactor.
  - **Commit 2 (H.2 + H.3 first half):** `e2e/auto-compact.e2e.ts`
    + the two cheapest H.3 e2e files (`thinking.e2e.ts`,
    `name-stats-export.e2e.ts` — both single-prompt). New tests
    only; no helper churn.
  - **Commit 3 (H.3 second half):** `e2e/settings.e2e.ts`,
    `e2e/kv.e2e.ts`, `e2e/sessions-dag.e2e.ts`. These need the
    most setup (event recorder for settings, kv-reading extension
    fixture, multi-session lifecycle for sessions-dag). One commit
    keeps the new helper / fixture additions together.
  Confirm during plan; the split is a recommendation. If H.3 ends
  up needing a shared `e2e/helpers/real-llm-harness.ts` extraction,
  hoist it into commit 1 or 2.

- **Test cost budget.** Each new e2e burns ~1–10 cents in OpenAI
  credits per run. Six new e2e files at ~$0.02 average = ~$0.12 per
  full e2e run. Within the existing budget (`bodhi-pi/e2e/*.e2e.ts`
  already costs ~$0.30/run); no budget escalation needed.

---

## Test signals to design for

Functional, blackbox.

- **H.1 — provider-pool helper preserves behavior.** Every test
  that switches to `useFauxProviderPool()` must continue green
  without changes beyond the prologue swap. The helper's
  `beforeEach`/`afterEach` ordering matches the inline version
  exactly. Confirm by running each migrated test file standalone
  before committing the batch.

- **H.2 — auto-compact e2e proves the trigger.** The
  `CompactionEntry` must be created without a `/compact` slash
  appearing in the prompt sequence. Assert via session tree, not
  via observing the wire — the wire could be flaky on real LLM
  latency. Tree query is deterministic.

- **H.3 — each e2e has one stable observable.** Don't assert exact
  model-text. Assert side effects: tree entries, event payloads,
  configOption updates, file writes, session-list contents. The
  observable is what changed; the LLM's natural-language wording
  is incidental.

- **H.3 settings e2e specifically.** The `before_provider_request`
  event recorder needs to capture the resolved model id used for
  the post-set prompt. If the event recorder doesn't surface that
  field today (it does as of batch 1's expansion), confirm and
  document. The test should fail with a clear "expected modelId X,
  got Y" message if the setting doesn't propagate.

- **Existing tests must continue passing.** This is the load-bearing
  invariant. H.1's helper extraction touches six test files; each
  one must be green after the swap. Run them individually in
  commit 1 before running the full vitest matrix.

---

## Open questions to confirm before coding

Use `AskUserQuestion` once you've read the code. Pre-load these:

- **Q1 — H.1 helper shape: `useFauxProviderPool()` hook vs class
  vs context object?**
  - Option A (preferred): hook-style function that wires beforeEach
    /afterEach internally and returns the factory closure (see
    pointer above). Composes with vitest's per-file scoping; one
    line at top-of-file for the caller.
  - Option B: explicit class `FauxProviderPool` that the test
    instantiates in `beforeEach`. Verbose; more idiomatic Java/TS;
    no global vitest hook tax.
  - Option C: just export `newFauxProvider()` as a standalone
    function and have each test manage its own `providers` array.
    Smallest API surface; doesn't actually dedupe the lifecycle.
  - Lean: Option A — collapses the most boilerplate, matches the
    existing `createTestHarness` / `useEventRecorder` pattern
    elsewhere in the helper directory. Confirm.

- **Q2 — H.3 e2e count: five files or fewer?**
  - Option A (preferred): five files, one per feature area
    (settings, kv, sessions-dag, thinking, name-stats-export).
    Clear separation; each file is small and focused.
  - Option B: bundle into two files (e.g.
    `e2e/session-control.e2e.ts` covers sessions-dag + name +
    settings; `e2e/state.e2e.ts` covers kv + thinking). Fewer
    files; less navigation cost; but each file mixes concerns.
  - Lean: Option A — mirrors the existing one-file-per-feature
    convention (`compaction.e2e.ts`, `commands.e2e.ts`, etc.).
    Confirm.

- **Q3 — `findAllUpdatesOfKind` helper: upstream or stay inline?**
  - Upstream: add to `test/helpers/acp-narrow.ts` next to
    `findUpdateOfKind`. Pre-empts third-caller duplication.
  - Stay inline: keep the `.filter(u => u.update.sessionUpdate === "X")`
    pattern at each callsite until a third caller appears.
  - Lean: upstream IF the settings e2e ends up needing it (it
    likely does — at least two `available_commands_update`
    assertions to disambiguate boot from post-set). If only one
    caller, leave inline. Decide during plan.

- **Q4 — Cost-sensitivity for thinking e2e.** Thinking-capable
  models with `reasoning: true` cost more per call than
  `gpt-4o-mini`. Use `gpt-5-mini` (cheaper than `gpt-5`,
  thinking-capable per `packages/ai/src/models.generated.ts`)?
  Or fall back to faux-provider in-process coverage and skip the
  real-LLM e2e? Lean: ship the real-LLM e2e with `gpt-5-mini`;
  the per-run cost is ~$0.03 and the wire-shape proof is worth
  it. Confirm with the user before locking the model id.

---

## Boundaries

In scope:

- H.1 — `test/helpers/faux-provider-pool.ts` extraction + six
  call-site migrations in `packages/bodhi-pi/test/`.
- H.2 — `packages/bodhi-pi/e2e/auto-compact.e2e.ts`.
- H.3 — five new e2e files in `packages/bodhi-pi/e2e/`.
- Any narrowing-helper additions in `test/helpers/acp-narrow.ts`
  (e.g. `findAllUpdatesOfKind`) IF needed by ≥2 callers.
- Possibly upstreaming `flushImplicitRefresh` from
  `extensions.test.ts` into `test/helpers/` IF any H.3 test needs
  it.
- Doc updates: CHANGELOG entry under `[Unreleased]` →
  `### Added` for the new e2e coverage (or skip — H.1 is internal,
  H.2/H.3 don't change public API). Confirm during plan.
- Review's Progress + Batch sequence rows H flipped to ✅ with
  `(implemented in <plan-slug>)` annotation. Decision log gets
  date-stamped one-liners per Q1, Q2, Q3, Q4 resolution.

Explicitly out of scope:

- Adding e2e to host packages (`bodhi-pi-cli`, `bodhi-pi-browser`,
  etc.). Host-side e2e gaps are not findings in this review.
- Migrating `bodhi-pi` tests off vitest or to a different harness.
- Adding more unit tests. H.3 is exclusively e2e; the in-process
  coverage already exists.
- New ACP methods, events, or capabilities. Pure additive test
  batch.
- Touching batch 4's `requestSlashableRefresh` API surface —
  consume it, don't extend it.
- Renaming any existing test file. H.1 migrates prologues; doesn't
  move files.

---

## Verification

Follow the **Standard verification sequence** in
`ai-docs/reviews/process.md` (steps 1–6: bodhi-pi unit + e2e →
rebuild dist → 8 hosts in dependency order → `just test` →
`npm run check`). Don't skip any step. This is a test-only batch
but `just test` still must pass — new e2e files run there.

The e2e relevant to this batch:
- `bodhi-pi/e2e/auto-compact.e2e.ts` — the new H.2 file. Run it
  standalone first to confirm the trigger fires before adding
  to the full suite.
- `bodhi-pi/e2e/settings.e2e.ts`, `kv.e2e.ts`, `sessions-dag.e2e.ts`,
  `thinking.e2e.ts`, `name-stats-export.e2e.ts` — each run
  standalone before bundling.

If `just test` flakes on the new e2e files (parallel-resource
contention with the existing real-LLM suites), apply the batch-3
+ batch-4 lesson: re-run that single host's `test:e2e` standalone
first; if it passes, treat the matrix-run failure as parallel-resource
flakiness, not a regression.

If `npm run check` fails on a freshly-added helper, the helper has
a real type bug — not a vitest-runtime quirk. Type errors caught
by tsgo at this stage are the cheapest possible time to fix them.

---

## Definition of done

1. `test/helpers/faux-provider-pool.ts` exists and exports the agreed
   Q1 shape.
2. The six known callers (auto-compact, overflow-recovery,
   provider-options, session-config-ext, thinking, extensions) have
   their prologues replaced with the helper. Each file is green
   standalone.
3. `e2e/auto-compact.e2e.ts` exists and asserts auto-compact
   triggered without a manual `/compact`.
4. Five new e2e files exist under `packages/bodhi-pi/e2e/` covering
   settings, kv, sessions-dag, thinking, name-stats-export (assuming
   Q2 confirms five). Each asserts one stable observable against
   real `gpt-4o-mini` (or `gpt-5-mini` for thinking per Q4).
5. `npx vitest run` from `packages/bodhi-pi` green; every new e2e
   file green standalone AND in the e2e-config run.
6. Each downstream host's vitest / typecheck / Playwright e2e green
   per the standard sequence; `just test` green; `npm run check`
   clean.
7. Plan doc saved at `ai-docs/plans/<slug>.plan.md`. Review's
   Progress + Batch sequence tables flipped: H ✅ with
   `(implemented in <plan-slug>)` annotation. Decision log gets a
   date-stamped one-liner per Q1, Q2, Q3, Q4 lock.
8. CHANGELOG entry under `## [Unreleased]`:
   - `### Added` describing the new e2e coverage in 1–2 lines
     (auto-compact + settings/kv/sessions/thinking/name areas).
     H.1 is internal-only — no CHANGELOG entry needed unless the
     plan decides otherwise.
9. The retrospective for batch 5 gets appended to
   `ai-docs/reviews/process.md` as `## 5d.` after the batch ships
   (worked / didn't-work, dated). Include any e2e-cost surprises,
   any helper-extraction patterns that landed differently than the
   plan predicted, and any flakes that surfaced in `just test`.
