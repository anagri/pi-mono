# Milestone 050 — Background execution (fire-and-forget)

> **Status:** ☐ pending. Tracked in `../pending.md` as **P3a**. Not yet started.
> **Prerequisite reading:** [`005-architecture-decisions.md`](005-architecture-decisions.md), [`040-parallel-batch.md`](040-parallel-batch.md), `../v2-retrospective.md` (the eviction-per-status work that prepared this seam).
> **Depends on:** the per-status lifecycle-eviction refactor that landed in milestone 020 alongside V2 — the eviction seam was added explicitly to make this milestone possible without revisiting `SubagentService`'s core lifecycle.

## Goal

Let the LLM dispatch a sub-agent **without holding the parent's turn open until the child completes**. The parent immediately receives a structured handle (a child session id + a "running" status), continues its own work, and uses a new `subagent_status` tool to poll the child's state. On completion, the child's result becomes available to fetch and inject as a synthetic assistant message into the parent's transcript (OpenCode pattern).

Background execution is the **first cross-turn lifecycle** in the sub-agent system. Everything until now runs to completion within a single parent prompt-loop iteration.

## Functional scope

### IN

- **A way for the LLM to opt into background spawn** — either a new `background?: boolean` flag on the existing `subagent` tool, OR a new `subagent_background` tool. The decision belongs to the implementing agent; both are coherent with Decision 3 (the case for a separate tool is that "fire-and-forget" has very different success semantics from synchronous spawn).
- **`subagent_status` tool** — takes a `childSessionId`, returns `{ status: "running" | "completed" | "failed" | "cancelled", summary?: string, error?: string, partial?: string }`. The `partial` field lets the LLM check progress without waiting (returns the most recent assistant chunk).
- **A way to retrieve the final result** — either `subagent_status` returning the full summary on `status: "completed"`, or a separate `subagent_collect` tool. Choice belongs to the implementing agent.
- **Synthetic result injection (optional)** — when a child completes in the background and the parent is mid-turn, an extension or the host can choose to inject the child's summary as a synthetic user/assistant message rather than wait for the LLM to poll. The mechanics here are designed alongside the implementing agent.
- **Cross-turn child lifecycle** — children persist beyond the parent's current prompt-loop iteration. `SessionStore` already supports this (the child has its own session id and record); what's missing is a way for the in-memory `Map<sessionId, SessionState>` to handle a running child whose parent has returned control to the host.
- **A `_bodhi-pi/subagent/background` ext method** for host-side polling — lets a host UI render "X is running" without the LLM having to query.
- **Cancellation across turns** — the parent (or a host-side affordance) can cancel a running background child. The cancel signal needs to survive parent prompt-loop cycles.

### OUT

- **Resume-after-disconnect** — milestone [060](060-resume-after-disconnect.md). 050 covers "child outlives parent's turn within the same process"; 060 covers "child outlives parent's process restart / tab close".
- **Cross-session background children** (one parent dispatches, another parent receives the result) — not in scope.
- **Persistence of in-flight LLM state for the child** — if the host process dies, the child dies. Hardening that is part of milestone 060.

## Critical interfaces (recommendation-level)

### Tool surface
Two viable shapes:
- **Flag on `subagent`:** add `background?: boolean` (default `false`). When true, the tool returns immediately with `{ childSessionId, status: "running" }`. Schema attractor risk is real — needs careful description-writing.
- **New `subagent_background` tool:** mirrors `subagent` parameters but always returns immediately. Cleaner from Decision 3's stance (two-tools-not-one), but adds a third tool to the surface.

The implementing agent should review the C0 attractor lesson from V2 before picking. Either choice must keep the synchronous default working as today.

### `subagent_status` tool
- Schema: `{ childSessionId: string }`.
- Description should clarify that `running` is a transient state and the LLM should not poll-spin (recommendation: tool description includes "if running, do useful work before checking again").

### `SubagentService` extension
The service needs a way to track running children that have detached from a parent's turn. Recommendation: an `activeRuns` map keyed by `childSessionId` carrying the run promise + the cancel signal + the run metadata. The map is already partially present (see `ActiveRun` in current `subagent-service.ts`) — extension here is "outlive the parent's prompt-loop".

### Session-entry shape
A new variant `SubagentBackgroundEntry` may be needed (or `SubagentLinkEntry.background: boolean` could carry the flag). Either way, the entry stream needs to distinguish foreground from background spawns so replay reconstructs lifecycle correctly.

### Lifecycle events
Existing `subagent_start` / `subagent_end` may suffice, but a `subagent_background_polled` event could let extensions instrument the polling pattern. Designer's call.

## Behaviour rules (invariants this milestone must preserve)

1. **All seven locked decisions still apply.** In-process spawn, profile source-of-truth, fresh-default, depth-cap-2, MCP-empty for children, full-transcript fork filter. Background mode does not change *what* a child can do; it only changes *when* the result is consumed.
2. **A background child cannot itself spawn children.** Depth-cap-2 holds.
3. **`SUBAGENT_DEFAULT_MAX_BATCH_CONCURRENCY` still applies** — the cap on concurrent children (background OR foreground) lives on the service, not on the tool.
4. **The parent's transcript faithfully records the spawn** — `subagent_link` is appended at dispatch, `subagent_complete` is appended at child end (potentially many turns later). Replay reconstructs.
5. **Cancellation is a first-class operation** — host UIs need a way to stop a background child; the implementing agent designs the host-facing surface.
6. **A child whose parent session is deleted is also terminated.** No orphaned children.

## Where this sits in the research spectrum

Background execution is the **OpenCode pattern**: dispatch immediately, poll later, optionally inject the result as a synthetic message. Qwen Code has a similar model with task IDs that survive across turns. cc supports a more limited form via the resume hook.

Relative to the spectrum:
- **Lifecycle axis:** moves bodhi-pi from foreground+parallel-batch to foreground+background+parallel-batch — the broadest position in the spectrum.
- **Return-protocol axis:** adds the synthetic-injection variant alongside the existing structured-return variant. Both coexist; the LLM picks per dispatch (or the host picks via injection).

The key design tension: background mode lets the LLM "compose tasks over time" but introduces a polling pattern that can degrade to wasted turns if the LLM checks too eagerly. Tool description and recommendation-prompts matter here.

## Tests / coverage (sketch)

The implementing agent designs the test pyramid, but the surface needs at minimum:
- **Unit:** background spawn → tool returns immediately; `subagent_status` returns `running`; subsequent `subagent_status` after child completion returns `completed` + summary.
- **Unit:** parent cancels running background child via host-facing surface; child's `subagent_complete` records `cancelled`.
- **Unit:** background child spans multiple parent prompt-loop iterations; `SessionStore` rehydration mid-run preserves run state (or — if not — the in-memory map handles re-attach correctly).
- **e2e:** gpt-4o-mini parent dispatches a background child, does other work, polls, gets result.
- **e2e-ui (Playwright):** host renders "X is running" indicator + a cancel affordance.

## Per-runtime impact

| Runtime | Considerations |
|---|---|
| **cli** | Long-running children survive across REPL turns naturally. Status indicator in the prompt nice-to-have. |
| **http** | **Hardest case.** Per-turn-rebuild means the host process may rebuild between the dispatch and the poll. The implementing agent needs to decide: does background mode require persistent state across rebuilds? If so, how? (Likely: persist the run state via `SessionStore`, re-attach on rebuild — but this overlaps with milestone 060.) |
| **browser** | Web Worker survives across UI interactions. Background child lives in the worker; UI polls via ext method. |
| **chrome-ext** | MV3 service workers can sleep — this introduces the same "re-attach" question as http. May force milestone 060 to ship in tandem. |

The cross-runtime divergence on lifecycle persistence is the hard part. The implementing agent should make this design call early and document it.

## Follow-ups / open knobs

- **Re-attach after process death** → milestone [060](060-resume-after-disconnect.md). May need to ship together with 050 depending on how the http + chrome-ext lifecycle question is answered.
- **Auto-injection vs LLM-polling** — synthetic injection is OpenCode's approach. Whether bodhi-pi adopts it depends on whether the LLM-as-poller pattern proves wasteful in practice. The implementing agent designs both surfaces and picks defaults.
- **Background parallel dispatch** — when the LLM emits N `subagent` tool calls in one assistant turn AND each carries a `background: true` flag (or the tool is dispatched via a `subagent_background` variant), should the runtime detach from all N in parallel? Mirrors the foreground parallel-dispatch story but at the background layer.
- **Notification on completion** — if the parent is idle when a child completes, can the host surface a notification? Out of scope here but a natural sequel.
