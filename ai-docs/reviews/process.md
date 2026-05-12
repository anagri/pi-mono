# bodhi-pi review-driven workflow

How we turn a tech-debt review into shipped code without losing the thread
between findings, plan, implementation, and what's-still-open. Read this
once before starting any review batch under `ai-docs/reviews/`. The
companion `ai-docs/prompts/process.md` covers the original feature-phase
workflow; this doc is its review-cleanup sibling.

---

## 1. What a review is

A review under `ai-docs/reviews/<YYYY-MM-DD>-<slug>.md` is the **frozen
snapshot** of tech-debt findings against a specific HEAD. Each finding has
a `file:line` cite and a fix description. Findings are grouped into
**Batches** (A, B, C…) that map roughly to commit-sized units of work; the
review's top-of-file **Progress** table is the live status, and the **Batch
sequence** table is the live ship-order.

A review is not a plan; a review is a punch list. Plans live in
`ai-docs/plans/<slug>.md`, are approved via plan mode, and reference back
to the review they're closing out.

---

## 2. The pipeline

```
review (read-only finding) → pick next batch → kickoff prompt → plan → implement → update review progress → next kickoff
```

Each step has one source of truth and one output:

| Step           | Source                                             | Output                                                                                                                              |
| -------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Review         | `/bodhi-pi-review` slash + multi-angle exploration | `ai-docs/reviews/<date>-<slug>.md` with batches and (post-first-pass) a "Batch sequence" + "Progress" table                         |
| Pick next      | User picks the next batch(es) from the review      | Updated "Batch sequence" row marked 🔜 next                                                                                          |
| Kickoff prompt | The selected next batch                            | `ai-docs/reviews/kickoff-batch-<n>-<slug>.md` (group-2-style: outcomes + pointers, not prescriptive)                                |
| Plan           | The kickoff prompt + plan-mode exploration         | `ai-docs/plans/<themed-slug>.md`                                                                                                    |
| Implement      | The plan + iterative coding                        | Source code change + tests + CHANGELOG + progress-table flip in the review                                                          |
| Next kickoff   | Updated progress table                             | The next batch's kickoff prompt, drafted only once the previous batch ships                                                         |

Sequential. One batch at a time. The review document is the **only artifact
that spans the whole loop** — keep its progress table honest after every
shipped commit so the next reader can tell where work stopped without
reading code.

---

## 3. The hard rules

### Review

- **Findings are immutable once shipped.** Don't rewrite a finding to
  match what landed; that loses the audit trail. Update the **Progress**
  table instead. If the implementation diverged from the finding, write a
  short "implemented as: …" note alongside the original finding.
- **Every finding has a `file:line` cite.** No cite ⇒ rejected at review
  time, not later. Cites are verified against the snapshot HEAD, not
  current HEAD. The Progress table is what you read for "is this still
  open?".
- **Batches are commit-sized.** If a batch is too big to ship in one
  reasonable commit, it's not a batch — split before adding it to the
  review.

### Batch sequence

- **One batch at a time.** Sequential execution; no parallel worktrees.
  Trades raw speed for simpler reasoning about where work stopped, what
  changed, and what the next reader should expect.
- **Order is a recommendation, not a contract.** The "Batch sequence"
  table reflects the current best ship-order based on what's known. When
  a batch is about to start, re-evaluate whether it's still the right
  next move — implementation in earlier batches sometimes invalidates the
  premise of later ones, or unlocks easier paths.
- **Lock decisions in a "Decision log" subsection.** Date-stamped, one
  line each, written when the decision is made (not retroactively). Used
  later to answer "why did we do X this way?" without re-reading every
  PR.
- **Drop obsolete findings silently.** Mark them `obsolete (reason)` in
  the Progress table when they no longer apply; don't pretend they
  shipped.

### Kickoff prompts

- **Reference, not prescribe.** State the **functional outcome** the next
  batch should produce. Point at the relevant findings, the plan, and
  this `process.md`. Trust the implementer to make the design calls; their
  judgment improves with autonomy. Telling them which file to edit on
  which line freezes the implementation against the review's snapshot,
  which is already stale.
- **Style: group-2.** Mirror `ai-docs/prompts/group-2-system-prompt-and-context.md`:
  - "Read first" links (review batch, prior plan(s), this process.md,
    reference impl)
  - "Functional outcomes" — what a user / extension / test should
    observe after the batch ships
  - "Rough directional pointers" — file paths, prior art, **not** "edit
    line X to Y"
  - "Test signals to design for" — blackbox observables; include
    deliberate seams (data-* attributes, `_bodhi-pi/<area>/<verb>` ext
    methods) the implementer can lean on
  - "Open questions to confirm before coding" — `AskUserQuestion`-shaped
    list
  - "Boundaries (in scope / out of scope)" — explicit, the same way
    review batches are scope-bounded
- **One kickoff = one batch.** Or one kickoff per ship-able cluster of
  closely-related batches (e.g. C + D ship together because they touch
  the same module group). Either way, the kickoff covers exactly what
  will land in one commit / one plan-mode session.
- **Draft the kickoff only when the previous batch is shipped.**
  Speculative kickoffs go stale. If you can see the next two clearly,
  add a one-liner to the "Batch sequence" row instead.

### Plan + implement

- **Plan-mode for non-trivial batches.** Even if the kickoff is clear,
  walk through plan mode once to surface conflicts the kickoff missed
  (recently-merged code, drift in cited file:line ranges, etc.). The
  output is `ai-docs/plans/<slug>.md`.
- **Re-verify file:line cites at plan time.** The review's snapshot may
  be days/weeks old. Cites that have drifted ⇒ either re-locate the same
  semantic change at the new line, or drop the finding as obsolete.
- **Clean break, no dual-write, unless explicitly requested.** All
  runtimes are workspace-internal PoCs; backwards-compat is not free, it's
  a tax on every future reader. The clean-break path was right for batch
  1 (`configOptions` response field) and will be right for most future
  batches too.
- **Order inside a batch: bodhi-pi core → all downstream hosts in
  lockstep.** Do NOT do depth-first per-host (the convention in
  `ai-docs/prompts/process.md` doesn't apply here — review-driven cleanup
  batches don't ship feature surfaces, they reshape contracts). Make the
  core change, fix every host consumer, run all tests, commit. The whole
  batch is one cohesive unit.

### Tests

- **Update tests that asserted the old shape; don't keep both.** A test
  asserting `result.configOptions` and a test asserting the
  `config_option_update` notification both passing means the new code
  hasn't actually replaced anything.
- **No `if (cond) { expect(...) }` / no try-catch in tests.** Use
  narrowing helpers (`findUpdateOfKind`, `findEventOfType`,
  `asSelectOption` etc. — see `packages/bodhi-pi/test/helpers/acp-narrow.ts`).
  Determinism is non-negotiable. If the new helper doesn't exist yet,
  add it.
- **Recorder mirrors stay in lockstep.** `bodhi-pi/test/helpers/event-recorder.ts`
  + `bodhi-pi-cli/test/helpers/event-recorder.ts` (and any future host
  mirrors) all carry the SAME `ALL_EVENT_TYPES`. Adding an event ⇒
  update both in the same commit.

### Verification

- **Before declaring a batch shipped: tsgo all packages, run all tests
  across the matrix, biome clean.** The matrix today: `bodhi-pi`,
  `bodhi-pi-cli`, `bodhi-pi-node`, `bodhi-pi-browser`,
  `bodhi-pi-ws-server`, `bodhi-pi-ws-frontend`, `bodhi-pi-http`,
  `bodhi-pi-web`, `bodhi-pi-chrome-ext`. Pre-existing errors (e.g.,
  `BootstrapResult` in web/chrome-ext as of batch 1) get explicitly
  noted, not fixed silently — that's separate work.
- **Never `--no-verify`.** Pre-commit failures are real regressions or
  formatting drift; fix them.
- **Pre-build dist between core and host typecheck.** `bodhi-pi`'s
  `tsconfig` resolves `@bodhiapp/bodhi-pi` from `dist/` for downstream
  hosts at typecheck time. New core types ⇒ rebuild dist before
  typechecking hosts. (Vitest aliases to source so unit tests don't
  notice this; tsgo does.)

### Standard verification sequence

After implementation, run this exact sequence. Stop and fix at the
first failure; never skip steps even if "the change is just internal."

1. **bodhi-pi core complete first.** Make ALL bodhi-pi changes, then run
   `npx vitest run` (unit + integration) from `packages/bodhi-pi`. Get
   green.
2. **bodhi-pi e2e (real LLM).** `npx vitest run --config vitest.e2e.config.ts <relevant>.e2e.ts`
   for the e2e suites the batch touched. Get green.
3. **Rebuild bodhi-pi `dist/`.** `npm run build` in `packages/bodhi-pi`.
   Required because downstream hosts consume `@bodhiapp/bodhi-pi` from
   `dist/` at typecheck time.
4. **Per-host verification in this exact order.** For each host run its
   `npm test` (or `npx tsc -b` for hosts that have only Playwright e2e):
   1. `packages/bodhi-pi-node` (`npm test`)
   2. `packages/bodhi-pi-cli` (`npm test`)
   3. `packages/bodhi-pi-browser` (`npm test`; rebuild `dist/` after if
      web/chrome-ext consume it)
   4. `packages/bodhi-pi-web` (`npx tsc -b` — Playwright e2e is part of
      `just test`, no fast unit harness)
   5. `packages/bodhi-pi-chrome-ext` (`npx tsc -b`, same reason)
   6. `packages/bodhi-pi-http` (`npm test` for unit/integration; `test:e2e`
      for vitest-driven e2e)
   7. `packages/bodhi-pi-ws-server` (`npm test`)
   8. `packages/bodhi-pi-ws-frontend` (`npx tsc -b`, same reason)
5. **`just test` from repo root.** Final matrix sanity check. Anything
   that broke without surfacing in steps 1–4 is a regression in a path
   we don't otherwise hit (typically Playwright e2e or a host build that
   the per-host typecheck didn't exercise).
6. **`npm run check` from repo root.** Full biome + tsgo sweep.

The order is host-dependency-driven: `bodhi-pi-browser` rebuilds before
`bodhi-pi-web`/`bodhi-pi-chrome-ext` because the latter two consume the
former from `dist/`.

---

## 4. Concrete starting moves

For a new batch:

1. Read the review's **Progress** table to confirm what's open and what's
   shipped. The next 🔜 row in the **Batch sequence** table is what to
   pick — confirm with the user if there's any ambiguity (e.g. several
   batches in flight as candidates).
2. Read the corresponding kickoff prompt under
   `ai-docs/reviews/kickoff-batch-<n>-<slug>.md`.
3. Read every finding the kickoff scopes (e.g., "C + D" ⇒ Batch C and
   Batch D in the review).
4. Read this `process.md` and `ai-docs/prompts/process.md` (the latter
   for matrix-wide rules — adapter conventions, slash command set,
   blackbox testing).
5. Enter plan mode. Verify each finding's `file:line` is still valid at
   current HEAD; mark drift / obsolete in the plan doc.
6. Use `AskUserQuestion` for any architectural fork the kickoff didn't
   resolve. Lock the answer in a one-line "Decision log" addition to the
   review (you may amend the review for decision logs only — never to
   change findings).
7. ExitPlanMode with the saved plan path.
8. Implement core → hosts in lockstep. Tests + biome clean as you go.
9. Update the review's **Progress** table: 🔜 → ✅ for shipped batches,
   add `(implemented in <plan-slug>)` annotation. Update the **Batch
   sequence** table's status column to match.
10. Hand back to the user with a one-line "next batch available" note.
    The next kickoff gets drafted when the user picks it up.

---

## 5. Anti-patterns we already learned from

These showed up in the first batch and are documented so the next batch
doesn't repeat them.

- **Quoting subagent output verbatim into the review.** Subagents are
  enthusiastic and sometimes wrong (e.g., "audit missed
  `bodhi-pi-browser/src/ui/commands.ts`" — the audit literally did
  miss it). Always re-verify with grep before believing.
- **Adding `if (notif?.update.sessionUpdate === "X") { expect(...) }`
  to tests.** Use `findUpdateOfKind`. If the helper doesn't cover your
  case, extend it once and reuse.
- **Forgetting to rebuild bodhi-pi `dist/` before downstream tsgo.**
  Symptom: "Type 'foo_bar' is not assignable to …" on a freshly-added
  event type. Fix: `cd packages/bodhi-pi && npm run build` before
  typechecking the hosts.
- **Including stable-ACP response fields in the BREAKING-change list
  when only ext-method response fields changed.** `setSessionConfigOption`
  retains its `configOptions` response field; only `_bodhi-pi/*` ext
  responses dropped it. State this explicitly in the CHANGELOG so future
  readers don't widen the diff.
- **Treating "audit subagent missed N file" as a project failure.**
  It's a known limitation; budget for one verification grep per audit
  finding.

---

## 5a. What worked / what didn't (batch 2 retrospective, 2026-05-12)

Captured immediately after batch 2 (`sessions/` dedup) shipped. Read
this before batch 3 and the next batch's planning step.

### Worked

- **Re-evaluating the kickoff's scope during plan mode.** The kickoff
  said C + D; plan mode surfaced a third clone in
  `in-memory-session-store.forkRecord` and a 7×-repeated text-block
  filter. Folding both into the same batch was net-positive (same module
  group, same family of duplication). The kickoff being directional
  rather than prescriptive made room for that expansion.
- **Reversing a previous review finding when evidence changed.** A.3
  (proposed swapping `Agent` from `/dist/agent.js` to the package
  barrel) was OBSOLETE because upstream's barrel transitively pulls in
  Node-only modules. Documenting the reversal in CLAUDE.md + Decision
  log + the review's Progress table closes the loop so future agents
  don't "fix" it back.
- **Re-analyzing earlier "no" decisions when bodhi-pi-specific evidence
  surfaced.** The first plan-mode pass said "don't extract
  `runSummarizationLLM` because upstream doesn't." The user pushed for
  re-analysis; that surfaced that bodhi-pi's three call sites have
  homogeneous post-call shapes (unlike upstream's heterogeneous ones),
  which made extraction the right call. Lesson: "follow upstream" is a
  starting hypothesis, not a conclusion.
- **Co-located unit tests for the new shared module.** Adding
  `_shared.test.ts` next to `_shared.ts` with narrowing-style assertions
  caught a `joinTextBlocks` typing edge case at write time, before any
  caller broke.
- **The verification sequence (bodhi-pi → 8 hosts → `just test`).**
  Catching errors at the bodhi-pi unit level meant downstream rebuilds
  + per-host vitest runs were trivially green; `just test` was the
  insurance policy that confirmed nothing slipped through.

### Didn't work

- **Initial under-estimation of how much fits in "one batch."** The
  kickoff scoped C + D; the actual shipped batch was C + D + bonus
  walkPath + joinTextBlocks helper + `runSummarizationLLM` extraction.
  Future kickoffs should explicitly enumerate what *might* fold in
  ("bonus opportunities") so the implementer can decide rather than
  re-discover. Compromise: keep the kickoff directional, but add a
  one-liner "look around for nearby duplication of the same shape."
- **`just test` is slow when Playwright suites are involved.** Browser
  e2e (`bodhi-pi-web`, `bodhi-pi-chrome-ext`, `bodhi-pi-ws-frontend`)
  push `just test` to ~10+ minutes. For pure-refactor batches, the
  per-host `npm test` + `npx tsc -b` cycle is enough confidence to
  start documentation; reserve `just test` as the final sign-off, not a
  blocker for parallel work.
- **Plan documents drift fast.** The "open questions" section had stale
  hypotheticals by the end of plan mode (most got resolved inline).
  Future plans should mark each open question with `RESOLVED: <answer>`
  in place rather than scrubbing them — preserves the audit trail of
  what got considered.

---

## 5b. What worked / what didn't (batch 3 retrospective, 2026-05-12)

Captured immediately after batch 3 (`agent.ts` decomposition + B.10
`gpt-4o-mini` removal) shipped. Read this before batch 4.

### Worked

- **Locking architectural decisions up front.** The user explicitly
  asked us to b-lock B.9 (`SettingsState` + `SessionRuntime` split) and
  B.10 (no hardcoded fallback) at plan time rather than discover the
  shape during implementation. Both decisions had multiple plausible
  shapes; locking the chosen one in the Decision log meant the
  implementation was straightforward instead of exploratory. Repeat for
  any batch that touches public types or wire shapes.
- **Saturating one helper instead of unifying many.** `requireSession`
  / `requireSessionRecord` / `validateSessionId` / `optionalSessionId`
  cover four distinct callsite needs. A single "do it all" helper
  would have forced every caller to think about cases that don't apply
  to it. Symmetric naming (`requireX` / `validateX` / `optionalX`)
  makes the right one obvious at the callsite.
- **Bundling B.10 with B.1–B.9 instead of deferring.** B.10 was
  scoped late but landed cleanly because the SessionState split (B.9)
  had already separated `currentModelId` into the Runtime half — a
  field-typing change to `string | null` ripple was contained. Lesson:
  when two findings touch the same struct, ship them together; the
  combined diff is smaller than two sequential ones.
- **Page-Object encapsulation for E2E setup churn.** Adding
  `chat.setup(provider, key, modelId)` / `app.setup(modelId)` to the
  Playwright POMs collapsed the `goto/waitForState/login/model` ritual
  in ~50 spec files into a single line. The B.10 ripple (every spec
  that previously assumed a default model now has to select one)
  became a one-line edit per file instead of four.
- **Propagating the type widening across hosts in lockstep.**
  `fromModelId: string | null` had to land in `bodhi-pi/events/types.ts`,
  `bodhi-pi-browser/runtime/types.ts`, `bodhi-pi-browser/store/eventStore.ts`,
  `bodhi-pi-ws-server/agent/wire-agent.ts`, and
  `bodhi-pi-http/server/agent/wire-agent.ts` together. Doing this in
  one verification pass caught all four downstream type errors before
  any host runtime exercised the new shape.

### Didn't work

- **`just test` reporting style is hostile to parallel-flake debugging.**
  When `bodhi-pi-chrome-ext` test:e2e flakes once during the matrix run
  (resource contention, not a real failure), the only signal is "1
  step(s) failed: chrome-ext". Re-running the suite standalone passed
  cleanly. Lesson: when `just test` reports exactly one host failure
  in a Playwright step, re-run that host once before treating it as a
  regression. Codify: the process.md verification step 5 should say
  "re-run flaky Playwright suites once if needed" (it does — keep it).
- **AppPage helpers needed `newSession()` between connect and model
  on bodhi-pi-ws-frontend.** The ws frontend lazy-creates a session on
  first `/new`; calling `/model <id>` before that hit "unknown
  session". The bodhi-pi-http frontend auto-resumes/creates sessions
  on connect, so its `setup()` skips `newSession()`. The asymmetry was
  invisible until tests ran. Lesson: when adding cross-host POM
  helpers, don't assume the post-connect state is identical — check
  with a quick `/sessions` query in the harness or document the gap
  explicitly.
- **The vitest e2e suite for `bodhi-pi-http` (`chat.e2e.ts`) bypasses
  the slash dispatcher entirely.** It calls `session/new` then
  `session/prompt` directly via JSON-RPC; with B.10, that path errors
  with "no model available" because there's no `/model` slash to land
  in between. Fix was a one-line `session/setSessionConfigOption`
  call between new and prompt — but this kind of harness-level e2e
  needs to be auditable for "does this exercise the slash path or the
  raw ACP path?" up front. Lesson: when removing a default that the
  slash layer covers up, audit raw-ACP harnesses separately.
- **Comment hygiene drift during fast iteration.** Mid-batch, several
  files accumulated `// B.10: ...` and `// after the gpt-4o-mini
  removal ...` comments explaining the change. The user reasonably
  pushed back: those belong in the commit message and CHANGELOG, not
  the source. Codified as an `AGENTS.md` rule going forward; the rule
  should be in the implementer's working memory before they write the
  first comment, not after.

---

## 5c. What worked / what didn't (batch 4 retrospective, 2026-05-12)

Captured immediately after batch 4 (F.1 `_meta` collapse + E.4
slashable refresh + F.2 `EXT_SESSION_CONFIG` slim) shipped. Read this
before batch 5.

### Worked

- **Three-commits-per-batch cadence with bodhi-pi → hosts → just test
  → npm run check between each.** Splitting F.1 / E.4 / F.2 into three
  commits in ship-order (smallest blast radius → largest) meant each
  step's verification was tractable and any regression would bisect to
  ~50–200 LOC instead of the whole batch's ~300 LOC. F.1 + F.2 also
  collapse cleanly into one CHANGELOG section even though they shipped
  apart, because they're both `BREAKING` entries on the same
  `agentCapabilities`/`EXT_SESSION_CONFIG` surface.
- **Pre-locking all six architectural decisions before plan exit.**
  F.1 shape (single version), F.2 migration (clean break), E.4 hook
  (implicit + explicit), E.4 debouncing (none), `session.commands`
  re-merge strategy (alongside the advertisement), commit cadence
  (three commits in this order). Locking all six in the Decision log
  before coding meant implementation never had to stop and re-decide —
  same lesson as batch 3 with B.9 / B.10.
- **`projectCommands` field on `SessionState` as an explicit re-merge
  source.** The natural-looking design ("re-build the session, re-fire
  advertise") would have been wasteful (re-resolves model, re-runs
  every factory, etc.). Adding one frozen field to `SessionState` and
  threading `runner.getCommands()` through `mergeCommands` is the
  minimal change that keeps `session.commands` and the wire
  advertisement in lockstep. The Decision log entry naming this
  ("E.4 `session.commands` refreshed alongside the wire") makes the
  invariant grep-able.
- **In-process ACP harness + `flushImplicitRefresh` test helper for
  fire-and-forget assertions.** `registerCommand`'s closure uses
  `void self.requestSlashableRefresh?.()` so the synchronous API shape
  stays — `registerCommand(...) => () => void`. The trade-off is a
  one-macrotask tick before the wire sees the update. The test helper
  is a one-liner `() => new Promise(r => setTimeout(r, 0))` named
  clearly so the intent is obvious at the callsite. Cleaner than
  threading a "pending refreshes" promise through public API.
- **Host consumer audit at plan time was accurate.** Plan said 4
  hosts read `projectSettingsPresent` + 1 typed wrapper + 1 http
  integration test. Implementation found exactly those 6 callsites
  plus 1 doc comment in `acp/constants.ts` and 1 in
  `PARITY.md` — both worth updating for accuracy but not a fix scope
  surprise. Worth keeping the "ripgrep all callsites at plan time"
  habit.

### Didn't work

- **`tsc -b` hung once in `bodhi-pi-web` for 5+ minutes without
  surfacing tsgo's actual incremental cache state.** Killing the
  process and re-running the same command finished in 2 seconds.
  Suspect: stale `.tsbuildinfo` interacting with the parallel
  bodhi-pi-browser rebuild. No reproducible signature so can't
  codify a check yet; flagging for awareness. If it recurs, deleting
  the affected `.tsbuildinfo` is the first move.
- **One missed bodhi-pi-cli test from the plan's host migration
  list.** Plan listed 5 host consumer source files and 1 http
  integration test, but missed `bodhi-pi-cli/test/commands.test.ts`'s
  `expect(out).toContain("project settings present: true")` assertion.
  The grep "all hosts that print projectSettingsPresent" didn't fan
  out into test files. Lesson: the plan-time grep should cover
  `packages/*/test/**` in addition to `packages/*/src/**` when
  removing a printed field — tests assert on the prints too.
- **`just test` flaked once on bodhi-pi-cli e2e (parallel-resource
  contention).** Standalone re-run passed cleanly — same pattern as
  batch 3's chrome-ext flake. Confirms the existing
  "re-run flaky Playwright suites once" guidance is still right;
  worth adding "and `npm test` (vitest) suites that run real CLI
  subprocesses concurrently" to the same advice next time the rule
  text is touched.
- **Some uncertainty mid-implementation about whether `void self.requestSlashableRefresh?.()`
  is observable enough in tests.** Spent a few cycles thinking about
  whether to make `registerCommand` async (rejected — breaks API
  shape), or to expose `flushPendingRefreshes()` on the runner
  (rejected — API growth for tests). Resolution was the
  one-macrotask `flushImplicitRefresh` helper. Worth documenting:
  fire-and-forget is fine as long as the test seam is also fire-and-flush.

---

## 6. Glossary

| Term | Where | Use |
|---|---|---|
| Review | `ai-docs/reviews/<date>-<slug>.md` | Frozen findings + live Progress table + Batch sequence |
| Batch | section of a review (A, B, C…) | Commit-sized cluster of findings |
| Batch sequence | table near the top of the review | Live ship-order; sequential, one batch at a time |
| Kickoff prompt | `ai-docs/reviews/kickoff-batch-<n>-<slug>.md` | Group-2-style brief for the next batch |
| Plan | `ai-docs/plans/<slug>.md` | Plan-mode artifact for one batch |
| Decision log | subsection of the review's Batch sequence | Date-stamped one-liners locking architectural choices |
