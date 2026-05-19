# Drop `subagent_batch` — switch to parallel `subagent` tool calls

## Context

Bodhi-pi today ships two LLM-facing sub-agent tools: `subagent` (single child) and `subagent_batch` (N≥2 children, with `tasks.minItems: 2`). The two-tool stance is **Decision 3** in [`ai-docs/sub-agents/milestones/005-architecture-decisions.md`](../sub-agents/milestones/005-architecture-decisions.md), shipped in P2b (commits `8de99b14` + `92b12478` on 2026-05-18) — milestone [040](../sub-agents/milestones/040-parallel-batch.md).

After surveying what other agent harnesses do (cc, MastraCode, OpenCode, LangChain deepagents, Gemini CLI, Qwen Code), the majority pattern is **single tool, multiple parallel tool calls per assistant turn**. No surveyed harness ships a `tasks: Array` merged shape; only OpenHands ships a dedicated batch primitive (which inspired bodhi-pi's `subagent_batch`). Concurrency in the majority pattern is achieved by the LLM emitting multiple tool calls in one assistant message, which the agent SDK dispatches in parallel.

**Verified prerequisite:** `pi-agent-core`'s prompt loop (`packages/agent/src/agent-loop.ts:373-506`) executes multi-tool-call assistant turns in parallel by default via `Promise.all` at line 492. Sequential execution is the opt-in path (when any tool has `executionMode === "sequential"` or config mandates it). No SDK changes needed.

This plan **deletes `subagent_batch` outright** and relies on LLM parallel tool calls for concurrent sub-agent dispatch. A single load-bearing integration test pins wall-clock concurrency; e2e and e2e-ui tests prove the round-trip through a real LLM and the chat UI.

## Source-code changes

### Deletions

| File | Action |
|---|---|
| `packages/bodhi-pi/src/tools/subagent-batch.ts` | **Delete entirely.** The +98-line LLM tool wrapper introduced in commit `8de99b14`. |
| `packages/bodhi-pi/src/subagents/batch-progress-accumulator.ts` | **Delete entirely.** The +90-line progress coalescer introduced in commit `92b12478`. |

### Refactors

| File | Change |
|---|---|
| `packages/bodhi-pi/src/tools/index.ts` | Remove the `createSubagentBatchTool` import, the `tools.push(createSubagentBatchTool(deps.subagent))` registration, and the `subagent_batch` entry in `BUILTIN_TOOL_SNIPPETS` (leaving it would advertise a tool the LLM can't invoke — attractor). |
| `packages/bodhi-pi/src/subagents/subagent-service.ts` | Remove `spawnBatch` method and its types (`SubagentSpawnBatchInput`, `SubagentSpawnBatchResult`). Remove the `batchAccumulators` map and the accumulator-routing logic from `92b12478` (the +42-net refactor). Remove `SUBAGENT_DEFAULT_MAX_BATCH_CONCURRENCY` + its `batchConcurrencyCap` accessor. Keep `spawn` (the canonical single-spawn path, still used by the `subagent` LLM tool and the `_bodhi-pi/subagent/run` ext-method `handleRun`). |
| `packages/bodhi-pi/src/sessions/entries.ts` | Remove `SubagentBatchEntry` interface + its union entry. |
| `packages/bodhi-pi/src/subagents/_clone-slice-filter.ts` | Remove `"subagent_batch"` from `SUBAGENT_FORK_FILTER`. |
| `packages/bodhi-pi/src/events/types.ts` | Remove `SubagentBatchStartEvent`, `SubagentBatchEndEvent`, their union entries, and the corresponding `BodhiPiEventHandlers` entries. |
| `packages/bodhi-pi/src/acp/agent.ts` | Revert the +9 lines from `8de99b14` (`SubagentService` wiring tweaks specific to batch — confirm at implementation time). |

## Tests

### New — proving parallel dispatch

**1. Integration test — `packages/bodhi-pi/test/subagents-parallel-tool-calls.test.ts` (new) [load-bearing]**

Uses the faux provider (`packages/bodhi-pi/test/helpers/script-subagent-run.ts` and `fauxAssistantMessage` / `fauxToolCall` helpers). The parent's scripted assistant message contains 2+ `subagent` tool-call entries in a single `fauxAssistantMessage([call1, call2, ...], { stopReason: "toolUse" })`. Child responses are delayed (e.g. 100ms, 150ms). Assertions:

- All children spawn (via `_bodhi-pi/subagent/children` ext method or `SubagentLinkEntry` / `subagent_start` event count).
- All children complete (via `SubagentCompleteEntry` / `subagent_end` event count).
- **Wall-clock concurrency:** `elapsed < (sum of per-child delays) - tolerance` — mirrors the existing timing assertion at `test/subagents-batch.test.ts:97`.
- Final parent assistant message includes the results from all children.

If this fails, pi-agent-core's parallel dispatch isn't working for the `subagent` tool specifically and the deletion is blocked.

**2. e2e test — `packages/bodhi-pi/e2e/shared/subagents-parallel.e2e.ts` (new)**

Mirrors the existing `e2e/shared/subagents-batch.e2e.ts`. Same `subagents-batch` scenario seed (word/line/char counter profiles), same setup, model `gpt-5-mini`. Prompt changes:

- Old: "Use the `subagent_batch` tool to dispatch all three counters in parallel"
- New: "Dispatch each counter using a separate `subagent` tool call, in parallel"

Assertions stay similar (children list contains all 3 profiles, final text matches per-counter regex). Correctness-only — real-LLM wall-clock timing is too variable to pin.

**3. e2e-ui test — `packages/bodhi-pi/e2e-ui/shared/subagents-parallel.spec.ts` (new)**

Playwright equivalent. Same scenario, same prompt update. Adds:

```ts
const toolCalls = finalAssistant.locator('[data-tool-name="subagent"]');
expect(await toolCalls.count()).toBeGreaterThanOrEqual(2);
```

— verifies the chat panel renders N separate tool-call divs (not 1 batch tool block). Proves host-side rendering handles concurrent `tool_call` events across browser / chrome-ext / http.

### Deletions

| File | Action |
|---|---|
| `packages/bodhi-pi/test/subagents-batch.test.ts` | **Delete.** Service-level test for the now-deleted `spawnBatch` method. |
| `packages/bodhi-pi/test/subagents-batch-failure.test.ts` | **Delete.** Same reason. |
| `packages/bodhi-pi/test/subagents-batch-cancellation.test.ts` | **Delete.** Same. |
| `packages/bodhi-pi/test/subagents-batch-progress.test.ts` | **Delete.** Tested the accumulator that is now gone. |
| `packages/bodhi-pi/test/subagents-batch-llm-invocation.test.ts` | **Delete.** LLM-dispatched the now-unregistered batch tool. |
| `packages/bodhi-pi/e2e/shared/subagents-batch.e2e.ts` | **Delete** — replaced by `subagents-parallel.e2e.ts`. |
| `packages/bodhi-pi/e2e-ui/shared/subagents-batch.spec.ts` | **Delete** — replaced by `subagents-parallel.spec.ts`. |

`test/helpers/script-subagent-run.ts` **stays** — used by non-batch subagent tests.

## Doc updates

| File | Change |
|---|---|
| `ai-docs/sub-agents/milestones/005-architecture-decisions.md` | Mark **Decision 3 as Superseded** with date + merge commit hash: "Superseded 2026-05-19 by the deletion of `subagent_batch`. Concurrency now achieved by LLM parallel tool-use of `subagent`." Add the new locked stance either as a brief note or as new Decision 8 ("Single sub-agent tool; concurrency via parallel tool calls"). |
| `ai-docs/sub-agents/milestones/040-parallel-batch.md` | Top-of-file banner: "Superseded — `subagent_batch` retired. Parallel sub-agent dispatch now happens via multiple parallel `subagent` tool calls in one assistant turn. See `ai-docs/plans/20260518-remove-subagent-batch.md` and milestone 005 Decision 3 (Superseded)." Leave the historical body in place. |
| `ai-docs/sub-agents/milestones/080-recursion-and-tool-consolidation.md` | Strike the "tool consolidation" half with: "Superseded by the `subagent_batch` deletion (see merge commit) — turned out the right consolidation was deletion, not merging." Recursion half stays pending. |
| `ai-docs/sub-agents/milestones/000-overview.md` | Status table: mark milestone 040 as "☑ shipped, ◐ retired". Design-dimensions table: Lifecycle row drops "parallel batch" from the bodhi-pi column (replace with "parallel via tool-call dispatch"). Update Decision 3 reference. |
| `ai-docs/sub-agents/milestones/010-foundation-and-fresh-context.md` | "OUT" section mentions `subagent_batch` is "out of V1, lands in milestone 040" — update to reflect retirement. |
| `ai-docs/sub-agents/pending.md` | Remove the "Consolidate tools" open knob — landed via deletion. |
| `ai-docs/sub-agents/README.md`, `roadmap.md`, `design.md` | Grep for `subagent_batch` mentions and update or strike. |
| `ai-docs/specs/bodhi-pi/subagents.md` | Remove the `subagent_batch` tool section. Add a short "parallel dispatch" subsection noting concurrency comes from LLM parallel tool calls. |
| `ai-docs/specs/bodhi-pi/lifecycle.md` | Remove the `SubagentBatchEntry` row from the SessionEntry union table. |
| `ai-docs/specs/bodhi-pi/acp.md` | Remove `subagent_batch_start` / `subagent_batch_end` from event examples and tables. |

## Commit strategy

Per [`feedback_atomic_commit_with_reset`](../../memory/feedback_atomic_commit_with_reset.md), use the chained `git reset . && git add <paths> && git commit ...` pattern. Recommended split (3 atomic commits):

1. **New parallel-dispatch tests** — `test/subagents-parallel-tool-calls.test.ts` + `e2e/shared/subagents-parallel.e2e.ts` + `e2e-ui/shared/subagents-parallel.spec.ts`. Lands the evidence first; integration test must pass against current source (the existing `subagent` tool already runs through the parallel `Promise.all` path).
2. **Code deletions + refactors + stale test deletions** — drops `src/tools/subagent-batch.ts`, `src/subagents/batch-progress-accumulator.ts`, the `spawnBatch` machinery in `subagent-service.ts`, the `SubagentBatchEntry`, the batch events, the filter entry, the tool registration. Deletes the 5 stale batch tests (`subagents-batch{,-failure,-cancellation,-progress,-llm-invocation}.test.ts` + the batch e2e + e2e-ui). Single coherent retirement commit.
3. **Doc updates** — milestone 040 superseded banner, Decision 3 superseded note, spec edits, pending/roadmap cleanup.

Each commit must pass `npm run check`, `npm test`, `just test-e2e`, `just test-e2e-ui`.

## Critical files (reference)

### Source touched / deleted
- `packages/bodhi-pi/src/tools/index.ts` — unregister + drop snippet
- `packages/bodhi-pi/src/tools/subagent-batch.ts` — **delete**
- `packages/bodhi-pi/src/subagents/subagent-service.ts` — drop `spawnBatch`, accumulators, batch cap
- `packages/bodhi-pi/src/subagents/batch-progress-accumulator.ts` — **delete**
- `packages/bodhi-pi/src/sessions/entries.ts` — drop `SubagentBatchEntry`
- `packages/bodhi-pi/src/subagents/_clone-slice-filter.ts` — drop `"subagent_batch"`
- `packages/bodhi-pi/src/events/types.ts` — drop batch events
- `packages/bodhi-pi/src/acp/agent.ts` — revert batch-specific wiring

### Tests added
- `packages/bodhi-pi/test/subagents-parallel-tool-calls.test.ts` — load-bearing concurrency test
- `packages/bodhi-pi/e2e/shared/subagents-parallel.e2e.ts` — real-LLM round-trip
- `packages/bodhi-pi/e2e-ui/shared/subagents-parallel.spec.ts` — Playwright UI verification

### Tests deleted
- `packages/bodhi-pi/test/subagents-batch.test.ts`
- `packages/bodhi-pi/test/subagents-batch-failure.test.ts`
- `packages/bodhi-pi/test/subagents-batch-cancellation.test.ts`
- `packages/bodhi-pi/test/subagents-batch-progress.test.ts`
- `packages/bodhi-pi/test/subagents-batch-llm-invocation.test.ts`
- `packages/bodhi-pi/e2e/shared/subagents-batch.e2e.ts`
- `packages/bodhi-pi/e2e-ui/shared/subagents-batch.spec.ts`

## Existing utilities to reuse

- **`pi-agent-core` parallel tool dispatch** ([`packages/agent/src/agent-loop.ts:373-506`](../../packages/agent/src/agent-loop.ts)) — `executeToolCalls` routes to `executeToolCallsParallel` by default; `Promise.all` at line 492 runs N async closures concurrently. No SDK changes needed.
- **Faux provider helpers** — `packages/bodhi-pi/test/helpers/script-subagent-run.ts` exports `scriptSubagentRun`, `fauxAssistantMessage`, `fauxToolCall`. For multi-tool-call scripted turns, call `fauxAssistantMessage([call1, call2, ...], { stopReason: "toolUse" })` directly rather than through `scriptSubagentRun` (which assumes one tool call per turn).
- **Timing-based concurrency assertion** — `test/subagents-batch.test.ts:97` pattern: `expect(elapsed).toBeLessThan(perChildDelay * N - tolerance)`. Reuse this pattern in the new integration test before deleting the source file.
- **e2e harness** — `packages/bodhi-pi/e2e/helpers/` shared setup; `createE2EHarness()` used by existing batch e2e. Reuse unchanged.
- **Playwright `chat` fixture** — defined in `e2e-ui/fixtures.ts`; provides `chat.send()` + `chat.root` locator. Reuse unchanged.
- **`subagents-batch` scenario seed** — word/line/char counter profiles. Reuse for the new parallel tests; same workspace, different prompt.

## Per-runtime impact

**No host-side code changes needed.** Verified by exploration:

- Browser/chrome-ext `test-apps/browser/src/client/react/ChatPanel.tsx` (lines 73-82) and `AppShell.tsx` (lines 23+) — each `tool_call` event renders as an independent `ChatToolCall`. Multiple parallel `subagent` calls in one assistant turn already render correctly as N separate tool-call divs.
- CLI `test-apps/cli/src/client/acp/headless.ts` — logs each `tool_call` event independently.
- HTTP — serves the browser React client; same behaviour.
- `packages/bodhi-pi/test-apps/app-utils/` — already runtime-neutral utilities; no extraction needed.

## Out of scope

- The recursion opt-in half of milestone 080 (still pending; orthogonal).
- Changes to `SubagentProfile` schema or discovery.
- Changes to fresh/fork context semantics.
- Changes to `SubagentService.spawn` (stays the canonical single-spawn path).
- MCP / skill inheritance — milestone 070.
- Background execution + resume — milestones 050, 060.

## Verification

1. `npm run check`, `npm test`, `just test-e2e`, `just test-e2e-ui` all clean.
2. New integration test asserts wall-clock concurrency and passes consistently (run 5+ times locally to rule out flake).
3. New e2e test passes against gpt-5-mini with the "use separate subagent calls in parallel" prompt — confirms real LLM emits parallel tool calls when asked.
4. New e2e-ui test asserts ≥2 separate `[data-tool-name="subagent"]` divs in the chat panel across browser/chrome-ext/http hosts.
5. Manual smoke across runtimes — boot `test-apps/{cli,http,browser,chrome-ext}` and prompt the LLM to dispatch 3 parallel subagents. Verify all spawn concurrently, render correctly, produce expected results.
6. `rg 'subagent_batch' packages/bodhi-pi` — zero hits in `src/` and `test/`; only intentional historical mentions remain in retros / superseded decision docs.
7. Decision 3 in `005-architecture-decisions.md` marked Superseded with date + merge commit hash.
8. Milestone 040 has the Superseded banner.
9. `pending.md` no longer lists "Consolidate tools".
