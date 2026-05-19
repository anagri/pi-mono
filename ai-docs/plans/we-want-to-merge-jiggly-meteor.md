# Drop `subagent_batch` — switch to parallel `subagent` tool calls (two phases)

> **Cleanup note:** during exploration, an Explore subagent wrote a draft plan at `ai-docs/plans/phase-1-parallel-subagent-calls-via-multiple-tool-calls.md` (violating plan-mode read-only). This file is the authoritative plan; the stray draft should be deleted after this plan is approved.

## Context

Bodhi-pi today ships two LLM-facing sub-agent tools: `subagent` (single child) and `subagent_batch` (N≥2 children, with `tasks.minItems: 2`). The two-tool stance is **Decision 3** in [`ai-docs/sub-agents/milestones/005-architecture-decisions.md`](../sub-agents/milestones/005-architecture-decisions.md), shipped in P2b (commits `8de99b14` + `92b12478` on 2026-05-18) — milestone [040](../sub-agents/milestones/040-parallel-batch.md).

After surveying what other agent harnesses actually do (cc, MastraCode, OpenCode, LangChain deepagents, Gemini CLI, Qwen Code), the majority pattern is **single tool, multiple parallel tool calls per assistant turn**. No surveyed harness ships a `tasks: Array` merged shape; only OpenHands ships a dedicated batch primitive (which inspired bodhi-pi's `subagent_batch`). Concurrency in the majority pattern is achieved by the LLM emitting multiple tool calls in one assistant message, which the agent SDK dispatches in parallel.

**Verified prerequisite:** `pi-agent-core`'s prompt loop (`packages/agent/src/agent-loop.ts:373-506`) executes multi-tool-call assistant turns in parallel by default via `Promise.all` at line 492. Sequential execution is the opt-in path (when any tool has `executionMode === "sequential"` or config mandates it). This means Pattern A is feasible — no SDK changes needed.

This plan adopts Pattern A: **drop `subagent_batch` and rely on LLM parallel tool calls** for concurrent sub-agent dispatch. The change is split into two phases to de-risk:

- **Phase 1** — keep `subagent_batch` code in source but unregister it from the LLM tool list. Add integration + e2e + e2e-ui tests proving that a parent LLM emitting **2+ parallel `subagent` tool calls in one assistant turn** spawns **truly-parallel sub-agents** (concurrent wall-clock execution, not sequential).
- **Phase 2** (gated on Phase 1 evidence) — execute the full deletion punch list: remove the batch tool source, the batch service method, the batch entry type, the batch lifecycle events, the batch progress accumulator, and the batch-specific tests.

If Phase 1 reveals that LLMs don't reliably emit parallel tool calls for sub-agent dispatch (or that pi-agent-core's parallel dispatch has edge cases we missed), Phase 2 stays parked and the locked Decision 3 stands.

## Phase 1 — Unregister + prove parallelism

### Source-code change (minimal)

| File | Change |
|---|---|
| `packages/bodhi-pi/src/tools/index.ts` | (a) Remove the `createSubagentBatchTool` import (line ~16). (b) Remove the `tools.push(createSubagentBatchTool(deps.subagent))` registration call (line ~48). (c) Remove the `subagent_batch: "Dispatch 2+ sub-agents concurrently..."` entry from `BUILTIN_TOOL_SNIPPETS` (line ~68) — leaving it would advertise a tool the LLM can't actually invoke (attractor). |

Everything else stays in source as-is:
- `packages/bodhi-pi/src/tools/subagent-batch.ts` — unchanged, just unreachable from the LLM tool list
- `packages/bodhi-pi/src/subagents/batch-progress-accumulator.ts` — unchanged
- `packages/bodhi-pi/src/subagents/subagent-service.ts` `spawnBatch` method, batch accumulator map, `SUBAGENT_DEFAULT_MAX_BATCH_CONCURRENCY` constant — unchanged
- `packages/bodhi-pi/src/sessions/entries.ts` `SubagentBatchEntry` — unchanged
- `packages/bodhi-pi/src/subagents/_clone-slice-filter.ts` `SUBAGENT_FORK_FILTER` (still includes `"subagent_batch"`) — unchanged
- `packages/bodhi-pi/src/events/types.ts` `SubagentBatchStartEvent` + `SubagentBatchEndEvent` — unchanged

### New tests proving parallel dispatch

Three new tests, each verifying that 2+ concurrent `subagent` calls in one assistant turn execute truly in parallel (not serially). The pattern: faux-script delayed child responses, assert wall-clock duration < sum of per-child delays.

**1. Integration test — `packages/bodhi-pi/test/subagents-parallel-tool-calls.test.ts` (new)**

Uses the faux provider (`packages/bodhi-pi/test/helpers/script-subagent-run.ts` and `fauxAssistantMessage` / `fauxToolCall` helpers). The parent's scripted assistant message contains 2+ `subagent` tool-call entries in a single `fauxAssistantMessage([call1, call2, ...], { stopReason: "toolUse" })`. Child responses are delayed (e.g. 100ms, 150ms). The test asserts:

- All children spawn (via `_bodhi-pi/subagent/children` ext method or `SubagentLinkEntry` / `subagent_start` event count)
- All children complete (via `SubagentCompleteEntry` / `subagent_end` event count)
- **Wall-clock concurrency:** `elapsed < (sum of per-child delays) - tolerance` — mirrors the timing assertion currently in `test/subagents-batch.test.ts:97`
- Final parent assistant message includes the results from all children

This is the **load-bearing test** for Phase 1. If it fails, pi-agent-core's parallel dispatch isn't working for the `subagent` tool specifically.

**2. e2e test — `packages/bodhi-pi/e2e/shared/subagents-parallel.e2e.ts` (new)**

Mirrors the existing `e2e/shared/subagents-batch.e2e.ts` (which uses gpt-5-mini per the recent fixture update — note: file comments mention gpt-4o-mini but the actual call is gpt-5-mini per `test/helpers/`). Uses the same scenario seed (`subagents-batch` scenario with word/line/char counter profiles) and same setup, but the natural-language prompt changes:

- Old (batch): "Use the `subagent_batch` tool to dispatch all three counters in parallel"
- New (parallel): "Dispatch each counter using a separate `subagent` tool call, in parallel"

Assertions stay similar (children list contains all 3 profiles, final text matches per-counter regex). The e2e cannot reliably assert timing concurrency because real LLMs vary; it's correctness-only. The integration test from (1) carries the concurrency assertion.

**3. e2e-ui test — `packages/bodhi-pi/e2e-ui/shared/subagents-parallel.spec.ts` (new)**

Playwright equivalent. Same scenario, same prompt update. Adds a UI assertion:
```
const toolCalls = finalAssistant.locator('[data-tool-name="subagent"]');
expect(await toolCalls.count()).toBeGreaterThanOrEqual(2);
```
— verifying the chat panel renders N separate tool-call divs (not 1 batch tool block). This proves the host-side rendering handles concurrent `tool_call` events correctly across browser / chrome-ext / http.

### Existing tests to retire or rename in Phase 1

The `subagent_batch` LLM tool becomes unreachable. Tests that exercise it **through the LLM** stop being meaningful.

| File | Action in Phase 1 |
|---|---|
| `packages/bodhi-pi/test/subagents-batch.test.ts` | **Keep.** Tests `SubagentService.spawnBatch` directly (service-level), not via LLM tool. Still validates the underlying machinery (we may delete in Phase 2). |
| `packages/bodhi-pi/test/subagents-batch-failure.test.ts` | **Keep.** Service-level. |
| `packages/bodhi-pi/test/subagents-batch-cancellation.test.ts` | **Keep.** Service-level. |
| `packages/bodhi-pi/test/subagents-batch-progress.test.ts` | **Keep.** Tests the accumulator directly. |
| `packages/bodhi-pi/test/subagents-batch-llm-invocation.test.ts` | **Delete.** Specifically tested the LLM dispatching the batch tool — now unreachable. |
| `packages/bodhi-pi/e2e/shared/subagents-batch.e2e.ts` | **Delete** (replaced by the new `subagents-parallel.e2e.ts`). |
| `packages/bodhi-pi/e2e-ui/shared/subagents-batch.spec.ts` | **Delete** (replaced by the new `subagents-parallel.spec.ts`). |

### Doc updates in Phase 1

| File | Change |
|---|---|
| `ai-docs/sub-agents/milestones/005-architecture-decisions.md` | Append a "Phase 1 in flight (2026-05-19)" note to **Decision 3**. Flag that the dual-tool stance is being empirically re-evaluated; if Phase 1 evidence confirms, Phase 2 retires Decision 3. |
| `ai-docs/sub-agents/milestones/040-parallel-batch.md` | Top-of-file banner: "Phase 1 in flight — `subagent_batch` LLM registration removed pending Phase 2 deletion. See [`ai-docs/plans/we-want-to-merge-jiggly-meteor.md`](../../plans/we-want-to-merge-jiggly-meteor.md)." Otherwise leave the historical record intact. |
| `ai-docs/sub-agents/milestones/000-overview.md` | Status table: mark milestone 040 as "☑ shipped, Phase 1 of retirement in flight". |
| `ai-docs/specs/bodhi-pi/subagents.md` | Note that `subagent_batch` is internal-only as of Phase 1 (still in source, not LLM-callable). Concurrency now flows via parallel `subagent` tool calls. |

`pending.md`, `roadmap.md`, `design.md` in `ai-docs/sub-agents/` stay until Phase 2 (when the full retirement happens).

### Commit strategy for Phase 1

Per [`feedback_atomic_commit_with_reset`](../../memory/feedback_atomic_commit_with_reset.md), use the chained `git reset . && git add <paths> && git commit ...` pattern. Recommended split:

1. **Code + test deletions** — the 3-line edit to `src/tools/index.ts`, plus delete `test/subagents-batch-llm-invocation.test.ts` + `e2e/shared/subagents-batch.e2e.ts` + `e2e-ui/shared/subagents-batch.spec.ts`. This commit drops the LLM registration AND removes the now-stale LLM-dispatch tests in one atomic move.
2. **New parallel-dispatch tests** — `test/subagents-parallel-tool-calls.test.ts` + `e2e/shared/subagents-parallel.e2e.ts` + `e2e-ui/shared/subagents-parallel.spec.ts`. Lands the evidence-gathering tests.
3. **Doc updates** — the four doc edits above.

Or combine 1+2 into one commit if implementer prefers — they're cohesive enough. Each commit must pass `npm run check`, `npm test`, `just test-e2e`, `just test-e2e-ui`.

### Phase 1 verification (gate to Phase 2)

Phase 2 starts ONLY after all of these hold:

1. `npm run check`, `npm test` clean — no broken units from the unregistration.
2. New integration test asserts wall-clock concurrency and passes consistently (run 5+ times locally to rule out flake).
3. New e2e test passes against gpt-5-mini with the "use separate subagent calls in parallel" prompt — confirms real LLM emits parallel tool calls when asked.
4. New e2e-ui test asserts ≥2 separate `[data-tool-name="subagent"]` divs in the chat panel across all four host runtimes.
5. **Manual check across runtimes** — boot `test-apps/{cli,http,browser,chrome-ext}` and prompt the LLM to dispatch 3 parallel subagents. Verify all spawn concurrently, render correctly, and produce the expected results.

If any of these fail, Phase 2 is parked. Decision 3 stays locked; `subagent_batch` LLM registration is restored (revert Phase 1 commit 1).

## Phase 2 — Delete `subagent_batch` entirely (gated)

Executes only after Phase 1 verification passes. Full punch list, mapped from the P2b commit diffs:

### Code deletions

| File | Action |
|---|---|
| `packages/bodhi-pi/src/tools/subagent-batch.ts` | **Delete entirely.** Was the +98-line LLM tool wrapper introduced in commit `8de99b14`. |
| `packages/bodhi-pi/src/subagents/batch-progress-accumulator.ts` | **Delete entirely.** Was the +90-line progress coalescer introduced in commit `92b12478`. |

### Code refactors

| File | Change |
|---|---|
| `packages/bodhi-pi/src/subagents/subagent-service.ts` | Remove `spawnBatch` method and its types (`SubagentSpawnBatchInput`, `SubagentSpawnBatchResult`). Remove the `batchAccumulators` map and the accumulator-routing logic introduced in `92b12478` (the `+42 net` refactor). Remove the `SUBAGENT_DEFAULT_MAX_BATCH_CONCURRENCY` constant + its `batchConcurrencyCap` accessor. Keep `spawn` (still used by both the `subagent` LLM tool and the `_bodhi-pi/subagent/run` ext-method `handleRun`). |
| `packages/bodhi-pi/src/sessions/entries.ts` | Remove `SubagentBatchEntry` interface + its union entry. |
| `packages/bodhi-pi/src/subagents/_clone-slice-filter.ts` | Remove `"subagent_batch"` from `SUBAGENT_FORK_FILTER`. |
| `packages/bodhi-pi/src/events/types.ts` | Remove `SubagentBatchStartEvent`, `SubagentBatchEndEvent`, their union entries, and the corresponding `BodhiPiEventHandlers` entries. |
| `packages/bodhi-pi/src/acp/agent.ts` | Revert the +9 lines from `8de99b14` (likely `SubagentService` wiring tweaks specific to batch — confirm at implementation time). |

### Test deletions

| File | Action |
|---|---|
| `packages/bodhi-pi/test/subagents-batch.test.ts` | **Delete.** Service-level test for the now-deleted `spawnBatch` method. |
| `packages/bodhi-pi/test/subagents-batch-failure.test.ts` | **Delete.** Same reason. |
| `packages/bodhi-pi/test/subagents-batch-cancellation.test.ts` | **Delete.** Same. |
| `packages/bodhi-pi/test/subagents-batch-progress.test.ts` | **Delete.** Tested the accumulator that is now gone. |

`test/helpers/script-subagent-run.ts` **stays** — it's used by non-batch subagent tests.

### Doc updates (Phase 2)

| File | Change |
|---|---|
| `ai-docs/sub-agents/milestones/005-architecture-decisions.md` | Mark **Decision 3 as Superseded** by Phase 2. Replace the "Phase 1 in flight" note with: "Superseded 2026-MM-DD by the deletion of `subagent_batch`. Concurrency now achieved by LLM parallel tool-use of `subagent`. See merge commit `<hash>`." Add the new locked stance as a brief note or as a new Decision 8 ("Single sub-agent tool; concurrency via parallel tool calls"). |
| `ai-docs/sub-agents/milestones/040-parallel-batch.md` | Top-of-file banner: "Superseded — `subagent_batch` retired. Parallel sub-agent dispatch now happens via multiple parallel `subagent` tool calls in one assistant turn. See `ai-docs/plans/we-want-to-merge-jiggly-meteor.md` for the retirement plan and milestone 005 Decision 3 (Superseded)." Leave the historical body in place. |
| `ai-docs/sub-agents/milestones/080-recursion-and-tool-consolidation.md` | The "tool consolidation" half is now done — strike that section with a "Superseded by Phase 2 deletion (see merge commit) — turned out the right consolidation was deletion, not merging" note. Recursion half stays pending. |
| `ai-docs/sub-agents/milestones/000-overview.md` | Status table: mark milestone 040 as "☑ shipped, ◐ retired in Phase 2". Update the design-dimensions table: Lifecycle row drops "parallel batch" from the bodhi-pi column (replaced with "parallel via tool-call dispatch"). Update Decision 3 reference. |
| `ai-docs/sub-agents/milestones/010-foundation-and-fresh-context.md` | The "OUT" section mentions `subagent_batch` is "out of V1, lands in milestone 040" — update to reflect retirement. |
| `ai-docs/sub-agents/pending.md` | Remove the "Consolidate tools" open knob — landed via deletion. |
| `ai-docs/sub-agents/README.md`, `roadmap.md`, `design.md` | Grep for `subagent_batch` mentions and update or strike. |
| `ai-docs/specs/bodhi-pi/subagents.md` | Remove the `subagent_batch` tool section entirely. Add a short "parallel dispatch" subsection noting that concurrency comes from LLM parallel tool calls. |
| `ai-docs/specs/bodhi-pi/lifecycle.md` | Remove the `SubagentBatchEntry` row from the SessionEntry union table. |
| `ai-docs/specs/bodhi-pi/acp.md` | Remove `subagent_batch_start` / `subagent_batch_end` from event examples and tables. |

### Phase 2 commit strategy

Per repo conventions, recommend 2-3 atomic commits:

1. **Code deletions + refactors** — drops the tool file, accumulator file, service method, entry type, events, filter entry. Single coherent retirement commit.
2. **Test deletions** — removes the 4 service-level batch tests.
3. **Doc updates** — milestone 040 superseded banner, Decision 3 superseded note, spec edits, pending/roadmap cleanup.

Each commit must pass `npm run check`, `npm test`, `just test-e2e`, `just test-e2e-ui`.

## Critical files (combined reference)

### Source code touched
- `packages/bodhi-pi/src/tools/index.ts` — Phase 1 unregistration; final shape post-Phase-2 has only the `subagent` tool
- `packages/bodhi-pi/src/tools/subagent-batch.ts` — Phase 2 deletion
- `packages/bodhi-pi/src/subagents/subagent-service.ts` — Phase 2 method removal
- `packages/bodhi-pi/src/subagents/batch-progress-accumulator.ts` — Phase 2 deletion
- `packages/bodhi-pi/src/sessions/entries.ts` — Phase 2 entry-type removal
- `packages/bodhi-pi/src/subagents/_clone-slice-filter.ts` — Phase 2 filter cleanup
- `packages/bodhi-pi/src/events/types.ts` — Phase 2 event removal
- `packages/bodhi-pi/src/acp/agent.ts` — Phase 2 minor revert

### Tests added (Phase 1)
- `packages/bodhi-pi/test/subagents-parallel-tool-calls.test.ts` — load-bearing concurrency test
- `packages/bodhi-pi/e2e/shared/subagents-parallel.e2e.ts` — real-LLM round-trip
- `packages/bodhi-pi/e2e-ui/shared/subagents-parallel.spec.ts` — Playwright UI verification

### Tests deleted (Phase 1)
- `packages/bodhi-pi/test/subagents-batch-llm-invocation.test.ts`
- `packages/bodhi-pi/e2e/shared/subagents-batch.e2e.ts`
- `packages/bodhi-pi/e2e-ui/shared/subagents-batch.spec.ts`

### Tests deleted (Phase 2)
- `packages/bodhi-pi/test/subagents-batch.test.ts`
- `packages/bodhi-pi/test/subagents-batch-failure.test.ts`
- `packages/bodhi-pi/test/subagents-batch-cancellation.test.ts`
- `packages/bodhi-pi/test/subagents-batch-progress.test.ts`

## Existing functions and utilities to reuse

- **`pi-agent-core` parallel tool dispatch** ([`packages/agent/src/agent-loop.ts:373-506`](../../packages/agent/src/agent-loop.ts)) — `executeToolCalls` already routes to `executeToolCallsParallel` by default; `Promise.all` at line 492 runs N async closures concurrently. **No SDK changes needed.**
- **Faux provider helpers** — `packages/bodhi-pi/test/helpers/script-subagent-run.ts` exports `scriptSubagentRun`, `fauxAssistantMessage`, `fauxToolCall`. For multi-tool-call scripted turns, call `fauxAssistantMessage([call1, call2, ...], { stopReason: "toolUse" })` directly rather than through `scriptSubagentRun` (which assumes one tool call per turn).
- **Timing-based concurrency assertion** — `test/subagents-batch.test.ts:97` pattern: `expect(elapsed).toBeLessThan(perChildDelay * N - tolerance)`. Reuse this pattern in the new integration test.
- **e2e harness** — `packages/bodhi-pi/e2e/helpers/` shared setup; `createE2EHarness()` used by existing batch e2e. Reuse unchanged.
- **Playwright `chat` fixture** — defined in `e2e-ui/fixtures.ts`; provides `chat.send()` + `chat.root` locator. Reuse unchanged.
- **`subagents-batch` scenario seed** — the word/line/char counter profiles. Reuse for the new parallel tests; same workspace, different prompt.

## Per-runtime impact

**No host-side code changes needed in either phase.** Verified by the Explore agent:

- Browser/chrome-ext `test-apps/browser/src/client/react/ChatPanel.tsx` (lines 73-82) and `AppShell.tsx` (lines 23+) — each `tool_call` event is rendered as an independent `ChatToolCall`. Multiple parallel `subagent` calls in one assistant turn already render correctly as N separate tool-call divs.
- CLI `test-apps/cli/src/client/acp/headless.ts` — logs each `tool_call` event independently.
- HTTP — serves the browser React client; same behaviour.
- `packages/bodhi-pi/test-apps/app-utils/` — already runtime-neutral utilities; **no extraction needed**. The "consistent host coordination" the user flagged is implicit in the existing per-`tool_call` rendering pipeline.

## Out of scope

- The recursion opt-in half of milestone 080 (still pending; orthogonal).
- Changes to `SubagentProfile` schema or discovery.
- Changes to fresh/fork context semantics.
- Changes to `SubagentService.spawn` (stays the canonical single-spawn path through both phases).
- MCP / skill inheritance — milestone 070.
- Background execution + resume — milestones 050, 060.
- Restoring the `subagent_batch` LLM tool registration after Phase 1 — that would only happen if Phase 1 verification fails (which is a rollback, not a forward plan).

## Verification (combined, both phases)

After Phase 1:
1. `npm run check` + `npm test` clean.
2. New integration test passes with wall-clock concurrency assertion holding (run 5+ times).
3. New e2e test passes against gpt-5-mini.
4. New e2e-ui test passes in browser/chrome-ext/http hosts.
5. Manual smoke in each runtime — prompt the LLM to dispatch parallel subagents; verify concurrent spawn + correct rendering.
6. `rg 'subagent_batch' packages/bodhi-pi/src` — `subagent_batch` references still present in source (intentional in Phase 1) but **not in `src/tools/index.ts`** (the registration is gone).

After Phase 2:
1. `npm run check`, `npm test`, `just test-e2e`, `just test-e2e-ui` all clean.
2. `rg 'subagent_batch' packages/bodhi-pi` — zero hits (or only intentional historical mentions in retros / superseded decision docs).
3. Decision 3 in `005-architecture-decisions.md` is marked Superseded with a date + commit hash.
4. Milestone 040 has a Superseded banner.
5. `pending.md` no longer lists "Consolidate tools".
