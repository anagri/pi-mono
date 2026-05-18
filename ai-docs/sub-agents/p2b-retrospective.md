# P2b retrospective — parallel batch (2026-05-18)

Shipped: `SubagentService.spawnBatch` + `subagent_batch` LLM tool + `BatchProgressAccumulator` + `SubagentBatchEntry` + `subagent_batch_start`/`subagent_batch_end` lifecycle events.

Sliced into 7 commits, all individually green on `npm run check` per trunk-based development.

## What shipped

### LLM-facing surface — separate `subagent_batch` tool

- New `src/tools/subagent-batch.ts`. Registered alongside `subagent` whenever ≥1 profile is discovered.
- Schema: `{tasks: Array<{agent, task, model?}>, failFast?: boolean}` with `additionalProperties: false` on root and on each task entry. `tasks` `minItems: 2` forces single dispatch through the cleaner `subagent` tool. `failFast?` is the only LLM-tunable knob (the C0-attractor rule applies; both branches covered by `subagents-batch-llm-invocation.test.ts`).
- Tool description includes the live concurrency cap (`Dispatch 2-${cap} sub-agents concurrently…`) sourced from `SubagentService.batchConcurrencyCap`.
- `maxConcurrent` is deliberately NOT an LLM param. Operators control the cap via `BodhiPiConfig.subagents.maxBatchConcurrency` (default 5).

### `SubagentService.spawnBatch`

- Composes the existing per-child `spawn()` via `Promise.all`. Did NOT fork the single-child impl.
- Pre-allocates all N child session ids up-front via `sessionStore.create()` so `subagent_batch_start` can already carry `childSessionIds[]` for Host UI pre-allocation. A new `preCreatedChildSessionId` option on `SubagentSpawnInput` lets `spawn()` skip its own `create()` call.
- Fork-mode slice is cached ONCE per batch (`cloneTranscriptSlice` of the parent's leafId at batch-start time); reused for every fork-mode child via a new `inheritedMessages` option on `SubagentSpawnInput`. Mixed fork/fresh batches work — each child uses its own profile's `context`.
- `tasks.length > maxBatchConcurrency` is rejected with a clean error that names the cap (no FIFO queueing — explicit lock decision).
- `failFast: true` triggers `batchAbortController.abort()` on the first non-completed child; each child's signal is `AbortSignal.any([userSignal, batchAC.signal])` so siblings see the abort. Collect-all default lets every child run to completion.
- After settlement, `SubagentBatchEntry` is appended to the PARENT session via the shared `AppendEntry` helper (injected from `agent.ts`).

### Per-child progress mirroring — the v1-retrospective debt retired

- New `src/subagents/batch-progress-accumulator.ts`. Per-batch state struct keyed internally on `childSessionId`; tracks `{profile, status, toolCount, lastTool}` per child.
- `SubagentService.batchAccumulators: Map<childSessionId, accumulator>` is populated by `spawnBatch` when the caller passes `onUpdate`. The existing global `tool_execution_start` / `message_end` handlers check the map first and route through the accumulator when the child belongs to a batch; otherwise they fall back to the unchanged single-child `run.onUpdate` path.
- Accumulator emits one coalesced `AgentToolUpdateCallback` per state change with `details.kind = "subagent_batch_progress"` + ordered `children[]` snapshot.
- Single-child `spawn()` path is byte-identical to pre-P2b.

### Lifecycle + persistence

- `SubagentBatchStartEvent` and `SubagentBatchEndEvent` added to `src/events/types.ts`; both forward through `src/acp/event-wiring.ts` as `LIFECYCLE_EVENT_METHOD` notifications per the both-rails rule. Per-child `subagent_start`/`subagent_end` still fire underneath — Hosts get both grouping signals AND per-child detail.
- `SubagentBatchEntry` added to `src/sessions/entries.ts`. Filtered out of fork-mode slices via `SUBAGENT_FORK_FILTER` so child sessions don't see parent's prior batch envelopes.
- Specs updated in the same commit cycle: `subagents.md` "Parallel batch — subagent_batch tool" section, `acp.md` `LIFECYCLE_EVENT_METHOD` rows, `lifecycle.md` SessionEntry row.

### Test coverage

| File | What it covers |
|---|---|
| `test/subagents-batch.test.ts` | 3-child happy path: ordered results, batch+per-child events, batch entry on parent, wall-time < sum of sequential delays (proves real concurrency), cap-exceeded rejection, mixed fork batch |
| `test/subagents-batch-progress.test.ts` | Single `tool_call_update` channel with coalesced `details.children[]` snapshot per tick |
| `test/subagents-batch-llm-invocation.test.ts` | Schema attractor shape, `minItems: 2` rejection, both `failFast` branches reach the executor (C0 reviewer rule) |
| `test/subagents-batch-cancellation.test.ts` | `client.cancel` mid-batch aborts every in-flight child via the chained signal |
| `test/subagents-batch-failure.test.ts` | collect-all surfaces per-child errors; `failFast: true` cancels in-flight siblings (wall-time proves abort beat the slow children) |
| `e2e/shared/subagents-batch.e2e.ts` | gpt-4o-mini natural-language LLM-invocation under each e2e project (in-memory + cli + http + ws) |
| `e2e-ui/shared/subagents-batch.spec.ts` | Playwright LLM-invocation under each e2e-ui project (browser + chrome-ext + http) |

## Decisions locked at grilling time

| Knob | Locked answer | Rationale |
|---|---|---|
| Tool surface | Separate `subagent_batch` tool | Keeps the single-child schema clean; no `tasks: [...]` attractor on `subagent`. Cost: doubles tool count. |
| Failure mode default | Collect-all; `failFast: true` opt-in | Parallel reviewers usually want every verdict, not the first failure killing siblings. |
| Progress shape | One `tool_call_update` with `details.children[]` accumulator | Minimal wire churn; one collapsible group per batch on the Host. |
| Concurrency cap default | 5 | Matches typical "correctness / tests / cleanup / docs / security" fan-out. |
| Cap-exceeded behaviour | REJECT with clean error naming the cap | No FIFO queue (would obscure the cap to the LLM and risk starvation). |
| SessionEntry | New `SubagentBatchEntry` on parent | Replay can reconstruct grouping from the parent alone; per-child entries unchanged. |
| Batch envelope events | Yes — add both, per-child events still fire | Hosts get batch grouping + per-child detail. |
| Mixed fork/fresh in one batch | Allowed | Each child uses its own profile's `context`; one cached slice for all fork children. |
| `maxConcurrent` per-call LLM param | NO — config-only | Avoids one C0-attractor field and one extra invocation branch test. |
| `failFast` per-call LLM param | YES — optional boolean, default false | Both branches tested in `subagents-batch-llm-invocation.test.ts` per C0. |
| `minItems: 2` on tasks | Yes | Forces N=1 through `subagent`; consolidation revisited in `pending.md`. |

## What's still deferred

- **Consolidate `subagent` + `subagent_batch` into one tool** (lower `minItems` to 1, drop the single tool). Tracked in `pending.md` "Open knobs to revisit per phase". Revisit after P3 watches real LLM-invocation patterns.
- **Fuller slash UX** (`/parallel`, `/chain`) — Roadmap P4b. No `_bodhi-pi/subagent/batch` ext-method ships in P2b; only LLM-invocation.
- **Background mode** — P3a.
- **Resume mid-run** — P3b.
- **MCP allow/deny inheritance** — P3c.
- **Skill inheritance for children** — P3d.
- **Worktree isolation** — P4a.

## Lessons / gotchas

- **`AbortSignal.any` is the right primitive** for chaining parent + batch signals; Node ≥20 has it natively, no polyfill needed. Each child's signal listener (`{ once: true }`) auto-cleans on completion.
- **Pre-create child session ids before emitting `subagent_batch_start`**. Without pre-creation, Hosts couldn't pre-allocate per-child UI slots from the envelope event; they'd have to wait for per-child `subagent_start` events and lose batch-grouping info.
- **Don't fork `spawn()` — compose it**. The temptation to inline batch dispatch into a `spawnChildWithSlice` helper was real; the `inheritedMessages` + `preCreatedChildSessionId` options were small enough to keep single-child path unchanged.
- **Faux step factories don't honour `streamOptions.signal` by default**. For cancellation/failFast tests, a local `abortableAssistant(text, delayMs)` helper wraps `setTimeout` + signal listener so cancellation propagates through the faux provider. Kept inline in the two test files rather than promoting to `test/helpers/` until a third caller appears.
- **Profile names with underscores get rejected at discovery** (`^[a-z0-9-]+$`). Cancellation/failure tests use kebab-case (`slow-a`, `quick-fail-b`, `good-c`).
- **`stopReason` types**: pi-ai uses `"stop" | "length" | "toolUse" | "error" | "aborted"` (not bodhi-pi's `"end_turn" | "cancelled" | ...`). Faux assistants in tests use pi-ai vocab; bodhi-pi's prompt-loop maps them on its way to `SubagentSpawnResult.status`.
- **biome `noAssignInExpressions`** caught an inline `void (var = e.field)` pattern in the event-handler array. Always block-bodied arrow with explicit assignment.

## References

- Plan: `ai-docs/plans/2026-05-18-bodhi-pi-sub-agents-p2b-parallel-batch.md`.
- Commits (in order):
  1. `bodhi-pi sub-agents P2b: SubagentBatchEntry + batch lifecycle events + wire forwarding`
  2. `bodhi-pi sub-agents P2b: SubagentService.spawnBatch + subagent_batch LLM tool`
  3. `bodhi-pi sub-agents P2b: BatchProgressAccumulator + per-child progress demux`
  4. `bodhi-pi sub-agents P2b: subagent_batch LLM-invocation tests (C0 reviewer rule)`
  5. `bodhi-pi sub-agents P2b: batch cancellation + failFast/collect-all behavioural tests`
  6. `bodhi-pi sub-agents P2b: e2e + e2e-ui coverage for subagent_batch`
  7. `bodhi-pi sub-agents P2b: spec amendments + retrospective + pending.md consolidation note`
- v1-retrospective debt retired: `v2-retrospective.md` "Progress mirroring is one global handler".
- See also: `subagents.md` (spec), `acp.md` (`LIFECYCLE_EVENT_METHOD`), `lifecycle.md` (SessionEntry table).
