# Milestone 040 — Parallel batch (P2b) ⛔ Superseded (Phase 2, 2026-05-19)

> ⛔ **Superseded (Phase 2, 2026-05-19).** The entire `subagent_batch` surface has been deleted. `src/tools/subagent-batch.ts`, `src/subagents/batch-progress-accumulator.ts`, `SubagentService.spawnBatch`, `SubagentBatchEntry`, and the `subagent_batch_start` / `subagent_batch_end` lifecycle events are gone from the codebase. Parallel sub-agent dispatch now happens by the LLM emitting multiple `subagent` tool calls in one assistant message; pi-agent-core's `Promise.all` executor (`packages/agent/src/agent-loop.ts::executeToolCallsParallel`) runs them concurrently. Concurrency is verified via `serverTime` overlap on `subagent_start` / `subagent_end` events. See [`005-architecture-decisions.md` Decision 3](005-architecture-decisions.md#decision-3--two-llm-tools-not-one--superseded-phase-2-2026-05-19) and [`ai-docs/plans/we-want-to-merge-jiggly-meteor.md`](../../plans/we-want-to-merge-jiggly-meteor.md). The historical record below describes what shipped in P2b — retained for context.
>
> **Status:** ☑ shipped (P2b phase, 2026-05-18 — seven commits), then ⛔ retired (Phase 2, 2026-05-19).
> **Prerequisite reading:** [`005-architecture-decisions.md`](005-architecture-decisions.md) (Decisions 3, 5), `../p2b-retrospective.md`.

## Goal

Give the LLM a way to dispatch **2 or more children concurrently** from a single tool call, with per-child results returned in the same order as the input tasks. Each child is independent — they do not see each other's output. Add a fail-fast knob for the case where the parent wants to abort siblings on the first failure.

This is the third LLM-facing tool moment in the sub-agent arc (after `subagent` in milestone 010 and `_bodhi-pi/subagent/run` host-side in the same milestone), and the first time the system spawns children that overlap in time.

## Functional scope

### IN

- **`subagent_batch` LLM tool** — separate from `subagent`. Schema: `tasks: Array<{ agent, task, model? }>` with `minItems: 2`, optional `failFast?: boolean` (default `false`). The two-tools-not-one stance is locked by Decision 3.
- **`SubagentService.spawnBatch`** — single entry point. Takes an array of per-task inputs, spawns each via the same internal path as `spawn`, returns an array of per-child results in input order.
- **`BatchProgressAccumulator`** — coalesces N per-child events into a single `tool_call_update` on the parent's `tool_call` so the host UI shows one progress block with a per-child status table. Avoids interleaving N independent progress streams into the parent's transcript.
- **`SubagentBatchEntry`** — `type: "subagent_batch"`, durable on the parent's `SessionStore`. Carries the parent session id, child session ids array, status, durationMs, and the `failFast` flag the LLM picked.
- **Two new `BodhiPiEvent` variants:** `subagent_batch_start` and `subagent_batch_end`. Mirror the start/end pair on the per-child `subagent_start` / `subagent_end` but at the batch-level granularity.
- **Max-concurrency cap** — `SUBAGENT_DEFAULT_MAX_BATCH_CONCURRENCY = 5`. The tool's description tells the LLM the upper bound. Hosts can override via `SubagentServiceDeps.maxBatchConcurrency` (e.g. cli increases, browser keeps low).
- **`failFast` semantics** — on first non-successful child completion, in-flight siblings receive a cancel signal. Children already completed keep their results; cancelled children appear with `status: "cancelled"`.
- **Default (collect-all) semantics** — every child runs to completion regardless of sibling outcomes; the batch result aggregates per-child status.

### OUT

- **N=1 batch dispatch.** The tool requires `minItems: 2`. A single task uses `subagent`. (See Decision 3 — the consolidation option is tracked in milestone 080.)
- **Cross-child communication.** Children do not see each other's input or output. If the parent wants a fan-in/fan-out pattern, it dispatches batch, processes results, and dispatches again.
- **Per-batch progress on a per-child basis in the parent's transcript.** All per-child progress folds into one `tool_call_update` block. Hosts that want per-child detail render it from the consolidated `details.children[]` array.
- **Recursive batches.** A child cannot call `subagent_batch` (Decision 5 — children get no sub-agent tools at all).
- **Cross-runtime concurrency tuning.** All four runtimes share `SUBAGENT_DEFAULT_MAX_BATCH_CONCURRENCY = 5` until a host explicitly overrides.

## Critical interfaces

### `subagent_batch` tool factory
Returns an `AgentTool` with `name: "subagent_batch"`. Schema (TypeBox shape):
- `tasks: Array<{ agent: enum<profile-names>, task: string, model?: string }>` with `minItems: 2` and `maxItems: <SUBAGENT_DEFAULT_MAX_BATCH_CONCURRENCY>`.
- `failFast?: boolean` (default `false`).

Description embeds the profile list (same as `subagent`) plus a clear "use this when … each task is self-contained" note and an explicit "children do NOT see each other's output" warning. Description also calls out that a single task should use `subagent`.

### `SubagentService.spawnBatch(input): Promise<BatchResult>`
Recommendation: keep the single-child `spawn` and the batch entry point unified in the same service. The batch path delegates per-child to the same internal bootstrap that single-spawn uses — only the lifecycle event emission and the parent-side `tool_call_update` accumulation differ. Constants exported alongside `SUBAGENT_MAX_DEPTH`: `SUBAGENT_DEFAULT_MAX_BATCH_CONCURRENCY`.

### `BatchProgressAccumulator`
Sits between per-child `AgentToolUpdateCallback` events and the parent's `tool_call_update` emission. Maintains per-child state (`pending` / `running` / `completed` / `failed` / `cancelled`) and coalesces. Recommendation: keep it as a small class with a stable shape, since tests subscribe to its emissions; the `details.children[]` field on the emitted update is the host-side contract.

### `SubagentBatchEntry`
- `type: "subagent_batch"`
- `parentSessionId`, `childSessionIds: string[]`, `status`, `durationMs`, `failFast: boolean`, `toolCallId`.
- Persisted before the batch starts (with all child session ids pre-allocated) and updated on batch end.

### Batch lifecycle event shapes
- `subagent_batch_start { parentSessionId, childSessionIds[], failFast, toolCallId }`
- `subagent_batch_end { parentSessionId, childSessionIds[], status, durationMs, perChild: Array<{ childSessionId, status }> }`

## Behaviour rules (invariants)

1. **`minItems: 2` on the schema.** A model that tries to batch one task gets a schema rejection — pushes it to the `subagent` tool instead.
2. **Results returned in input order**, even if children complete out of order. Order-stability is part of the contract.
3. **Children are independent.** Each child gets its own fresh OR fork context per its own profile; siblings do not share state.
4. **`failFast: true`** triggers cancel signals on in-flight siblings the moment any child reports non-success. The cancelled siblings persist as `subagent_complete` records with `status: "cancelled"`, and the batch as a whole returns the per-child status array.
5. **`failFast: false` (default)** lets every child run to completion. Per-child status is reported; the batch's overall status is `"failed"` if any child failed and `"completed"` otherwise.
6. **The concurrency cap** is enforced at dispatch time — more than the cap means the schema rejects the call (not silent queueing).
7. **A child of a batch is still depth-cap-enforced** — depth is calculated from the parent (depth = parent_depth + 1), independent of batch membership.
8. **MCP-empty applies** to every child of the batch (Decision 6).
9. **Progress accumulation is host-blind.** The parent's `tool_call_update` events carry the per-child detail; how the host renders is its choice.

## Where this sits in the research spectrum

P2b commits bodhi-pi to **Decision 3 (separate tools)** by shipping `subagent_batch` rather than folding batch into `subagent`. The alternative — `subagent` with `tasks: Array` and `minItems: 1` — was rejected because the single-child schema gains a noisy `tasks` wrapper and the `failFast` knob becomes meaningless for the N=1 case.

Relative to the spectrum:
- **Lifecycle axis:** bodhi-pi now sits in the foreground + parallel-batch position (matches OpenHands `DelegateTool`). The background position (OpenCode, Qwen Code) is still ahead — milestone 050.
- **Result-aggregation pattern:** in-order per-child results with batch-level status — matches OpenHands and is more structured than cc's pure transcript-injection approach.
- **Concurrency policy:** static cap (5) — closer to OpenHands' explicit concurrency knob than to Mastra's per-profile policy. The cap was chosen as the default because most observed use cases were 2-3 children; 5 leaves headroom without inviting fan-outs that thrash the underlying provider.

## Tests / coverage

- Unit: `subagents-batch.test.ts` (collect-all spawn end-to-end), `subagents-batch-failure.test.ts` (per-child failure modes + fail-fast cancellation), `subagents-batch-cancellation.test.ts` (parent cancel propagation), `subagents-batch-progress.test.ts` (accumulator behaviour), `subagents-batch-llm-invocation.test.ts` (schema constraints).
- e2e: `subagents-batch.e2e.ts` — gpt-4o-mini round-trip dispatching 2 children in parallel.
- e2e-ui (Playwright): `subagents-batch.spec.ts` — verifies the consolidated progress block renders correctly in browser/chrome-ext/http hosts.

## Per-runtime impact

| Runtime | What changed |
|---|---|
| **cli** | `subagent_batch` works from REPL the same way `subagent` does — the LLM dispatches; no new slash command. Progress renders as a per-child status table in the parent's tool-call block. |
| **http** | Children still complete within the parent's turn (foreground-only). With concurrency 5, this can extend the turn duration meaningfully — clients should expect longer-running tool calls. |
| **browser** | Same as http. Web Worker handles all children in-process; concurrency does not unblock the UI thread. |
| **chrome-ext** | Same as browser. MV3 service worker handles the spawns. |

Each host can override `maxBatchConcurrency` if needed. cli has the most headroom; browser/chrome-ext keep it conservative.

## Follow-ups / open knobs

- **Background batches** → milestone [050](050-background-execution.md). A background batch would let the parent dispatch + immediately return + poll later; current foreground batch holds the turn open.
- **Folding batch into single tool** → milestone [080](080-recursion-and-tool-consolidation.md). Drop `subagent_batch`, set `subagent.tasks.minItems = 1`. Tradeoff documented in Decision 3.
- **Per-child progress lanes in the parent's transcript** — currently consolidated into one block. A per-child lane variant would require host-side rendering work and is not scoped.
- **Cross-child handoff** (one child's output feeding the next) — Mastra and LangGraph support this as a graph; bodhi-pi does not, and it is not in any pending milestone. Workflow-handoff is a separate feature from sub-agents.
- **Per-task model override is allowed** in the batch schema but currently rare — most callers use the profile's default model. No specific follow-up.
