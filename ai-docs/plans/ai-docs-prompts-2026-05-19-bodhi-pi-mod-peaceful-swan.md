# Plan: correct the "e2e/e2e-ui can't be run" framing + execute the suites

## Context

During milestone 040 I repeatedly framed the bodhi-pi `e2e/` (real-LLM Vitest) and `e2e-ui/`
(Playwright) suites as un-runnable here ("needs `OPENAI_API_KEY` + Playwright browsers + spawned
test-app servers"). **That framing is wrong** — per the user, the suites are self-contained and fully
bootstrapped: every dependency, API key, library, framework, browser, and spawned server is
installed/provisioned, and they run directly. This plan removes the incorrect framing, makes the
correct framing canonical, and — most importantly — actually runs the suites to prove the milestone
040 e2e + e2e-ui pass.

## Findings from the read-only audit (Explore agent + corroborating grep)

The persisted artifacts are **already mostly correct** — there are no "cannot be run" claims in any
`CLAUDE.md`, spec, or memory file:

- **Memory** (project + global): no file claims e2e/e2e-ui are un-runnable or dependency-blocked.
- **`packages/bodhi-pi/CLAUDE.md`** + **`e2e/CLAUDE.md`**: already document e2e as integral to the
  6-step TDD flow and self-contained; `global-setup.ts` is presented as a bootstrap mechanism.
- **`e2e-ui/CLAUDE.md`**: does **not exist** — natural home for the single canonical statement.
- The only "needs OPENAI_API_KEY" mentions live in **historical `ai-docs/plans/*.md`** (e.g.
  `ws-m1.md`, `m4-2-skills.md`) as accurate run-notes — NOT un-runnable claims.
- The wrong framing was **conversational** + in the **B2 commit message** (`93cf8c57`, immutable
  history — out of scope).

So the doc work is mostly *additive* (assert self-containment in one place per suite), not a large
removal. The high-value deliverable is **running the suites**.

## Work items

### A. Docs — make self-containment canonical (background sub-agent, per user)

A general-purpose background agent makes these edits:

1. **`packages/bodhi-pi/e2e/CLAUDE.md`** — add a single canonical statement near the top:
   > This suite is **self-contained and fully bootstrapped** — all dependencies, API keys,
   > libraries, frameworks, and spawned test-app servers are installed/provisioned. Run it directly:
   > `npm run test:e2e` (or `just test-e2e`). No manual setup or external services required.

   Keep the existing conventions section. Reword (don't delete) any phrasing that reads as
   dependency-gating so it aligns with "provisioned, runs directly."

2. **`packages/bodhi-pi/e2e-ui/CLAUDE.md`** — CREATE it with the parallel canonical statement:
   > This suite is **self-contained and fully bootstrapped** — Playwright browsers, all frameworks,
   > the spawned test-app servers (http/ws), and API keys are installed/provisioned. Run it directly:
   > `npm --workspace @bodhiapp/bodhi-pi-e2e-ui test` (or `just test-e2e-ui`); scope with
   > `-- <file>` or `--project=<http|ws|browser|chrome-ext>`. No manual setup required.

3. **Scope-out (flag for override):** do NOT scrub the accurate historical `ai-docs/plans/*.md`
   "needs OPENAI_API_KEY" run-notes — they describe their own past context and aren't
   "can't-run" claims. If the user wants those scrubbed too, say so.

### B. Memory — correct my model (main agent)

Add a `feedback` memory `feedback_bodhi_pi_e2e_runnable.md`:
> bodhi-pi `e2e/` + `e2e-ui/` are self-contained and fully bootstrapped (keys, browsers, servers,
> frameworks all installed). They run directly — NEVER claim they "can't be run here" / need
> unavailable deps. Run `npm run test:e2e`, `npm --workspace @bodhiapp/bodhi-pi-e2e-ui test`.

Add the one-line pointer to `MEMORY.md`.

### C. Run the suites (main agent) — in the user's sequence

| # | Step | Command |
|---|---|---|
| 1 | build test-apps (once) | `npm --workspace @bodhiapp/bodhi-pi run test:e2e` builds them as its prefix; or build then scope |
| 2 | **affected e2e** | `npx vitest --run --config vitest.e2e.config.ts ask-mode` (from `packages/bodhi-pi`, after build) — `ask-mode.e2e.ts` across in-memory/cli/ws (runIf skips http) |
| 3 | **all e2e** | `npm --workspace @bodhiapp/bodhi-pi run test:e2e` |
| 4 | **affected e2e-ui** | `npm --workspace @bodhiapp/bodhi-pi-e2e-ui test -- ask-mode` (Playwright, filename filter, all 4 projects) |
| 5 | **all e2e-ui** | `npm --workspace @bodhiapp/bodhi-pi-e2e-ui test` |

"Affected" = the milestone-040 additions: `e2e/shared/ask-mode.e2e.ts` and
`e2e-ui/shared/ask-mode.spec.ts` (plus A2's shared-helper driver fixes touch all e2e, and B1's
test-app client changes touch all e2e-ui — hence affected-first, then full-suite).

Report pass/fail per step with output. If `ask-mode.e2e.ts` / `ask-mode.spec.ts` reveal a real
defect (not an environment issue), fix it and re-run. If a full-suite run surfaces a pre-existing
unrelated failure, report it without scope-creeping a fix.

## Execution shape

- Spawn the **doc background agent** (A) and run the **test sequence** (C) concurrently from the main
  agent; do the **memory correction** (B) in the main agent.
- Commit: docs (A) + memory is local-only (not committed). The doc change commits as
  `bodhi-pi e2e/e2e-ui: assert self-contained + runnable; drop can't-run framing`. Test runs produce
  no commit (unless step C uncovers a fix).

## Risk / honesty

- If a suite genuinely fails to start because an env var truly isn't present, that surfaces as
  `global-setup.ts`'s upfront failure — I'll report the exact error rather than re-assert
  "un-runnable." Per the user, everything is provisioned, so I expect them to run.
- Real-LLM e2e + 4-project Playwright are slow; the full runs (steps 3, 5) may take several minutes.
