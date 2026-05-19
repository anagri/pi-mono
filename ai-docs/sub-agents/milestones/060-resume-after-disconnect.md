# Milestone 060 — Resume after disconnect

> **Status:** ☐ pending. Tracked in `../pending.md` as **P3b**. Not yet started.
> **Prerequisite reading:** [`005-architecture-decisions.md`](005-architecture-decisions.md), [`050-background-execution.md`](050-background-execution.md).
> **Depends on:** milestone 050 (background execution) — resume only makes sense once children can outlive a parent's turn.

## Goal

Let a sub-agent run survive a parent process restart, browser tab close, or chrome-ext service-worker eviction, and let a re-launched parent **re-attach to the still-running (or already-completed) child** and continue.

Background mode (milestone 050) makes children outlive a parent's *turn*; this milestone makes them outlive a parent's *process*. The combination is what OpenCode and Qwen Code call "durable task IDs".

## Functional scope

### IN

- **A re-attach protocol** — given a `childSessionId`, the SubagentService can find or reconstruct enough run state to surface the child's progress + final result. The exact shape (in-memory map miss → SessionStore lookup → rebuild handle) is the implementing agent's design call.
- **Persistent run-state on `SessionStore`** — the child's progress so far (entries, partial assistant chunks, current tool call) must survive process restart. Most of this already persists (the child has its own `SessionStore` record); what's missing is the *currently-streaming* state that lives only in memory today.
- **A way for a re-launched host to discover running children** — when a parent session is rehydrated, the host can ask "are there children of this parent that are still running, completed, or failed?". The `_bodhi-pi/subagent/children` ext method already returns children; this milestone may extend it with a `status` field per child.
- **Behaviour for in-flight LLM calls when the process dies** — if a child was mid-LLM-completion when the process died, the LLM completion is lost. Options:
  - Mark the child as `failed` with `error: "process-died"` and let the parent re-dispatch.
  - Treat it as `partial` and let the parent decide to retry.
  - Resume from the last persisted entry boundary.
  The implementing agent picks the contract.
- **A `subagent_resume` tool (optional)** — explicit LLM-facing affordance to re-attach. Or — if `subagent_status` from milestone 050 handles missing-in-memory children gracefully, no new tool is needed.

### OUT

- **Resuming an LLM completion mid-stream.** When the process dies during an LLM API call, the partial completion is gone. Best the system can do is record progress at entry boundaries.
- **Cross-host resume.** A child dispatched by `test-apps/cli` cannot be resumed by `test-apps/http` even if both point at the same `SessionStore`. Cross-host resume needs explicit design and is not in scope.
- **Recovering from a `SessionStore` corruption.** Standard `SessionStore` recovery rules apply.

## Critical interfaces (recommendation-level)

### Persistent run-state shape
The implementing agent decides whether to introduce a new entry type or extend existing ones. Options:
- **`SubagentRunStateEntry`** — periodically persisted while the child runs, captures last-known progress (partial assistant message, current tool call, depth, contextMode).
- **Reuse existing entries** — the child's `SessionStore` record already accumulates entries. The "current run state" is "all entries so far + whatever's mid-flight in memory". On rehydrate, the implementation reads what's persisted and proceeds.

The second option is simpler but requires careful handling of mid-tool-call state. The first option duplicates information but makes the re-attach handle explicit. Designer's call.

### `SubagentService` extension
- The service's `activeRuns` map needs a "miss → check SessionStore → reconstruct or mark dead" code path.
- `getRunStatus(childSessionId)` becomes the unified query — returns `running | completed | failed | cancelled | unknown`, where `unknown` means "no record in SessionStore" and `dead` is the post-restart `failed`-with-`process-died` case.

### Updated ext-method shapes
- `_bodhi-pi/subagent/children { sessionId } → { children: Array<{ sessionId, profileName, status }> }` (gains `status`).
- Possibly: `_bodhi-pi/subagent/status { childSessionId } → { status, summary?, partial?, error? }` as a host-facing equivalent of the LLM `subagent_status` tool.

### Cancellation across process death
A child that was mid-run when its host died should be flagged on the next launch — the implementing agent decides whether this is automatic ("auto-mark stale running entries as `failed` with `error: process-died` at boot") or explicit (a `pi-mono` startup hook does the sweep).

## Behaviour rules (invariants this milestone must preserve)

1. **All seven locked decisions still apply.**
2. **Re-attach is read-mostly from the LLM's perspective** — the parent observes the child's outcome, then decides what to do. The LLM does not "continue running" a child that died.
3. **A re-attached completed child** returns the same final summary every time — replay-stable.
4. **A re-attached failed child** carries a `failed` status; the parent can re-dispatch with the same task to a fresh child if it wants to retry. No automatic retry.
5. **`SessionStore.list({ includeChildren: true })` is the source of truth for "what children exist"**. The in-memory map is a cache, never authoritative.

## Where this sits in the research spectrum

Resume-after-disconnect is the **durable task ID** pattern from OpenCode and Qwen Code. cc supports it partially through session resumption. Most other harnesses don't try — they expect the host process to outlive the agent's tasks.

Relative to the spectrum:
- **Lifecycle axis:** combines with milestone 050 to give bodhi-pi the most-permissive lifecycle position: foreground + background + parallel-batch + survives-process-death.
- The combination matters for the chrome-ext runtime in particular — MV3 service workers sleep aggressively, so a long-running child without resume support effectively means "no long-running children in chrome-ext".

## Tests / coverage (sketch)

- **Unit:** child mid-run, kill the in-memory state, rehydrate from `SessionStore`, verify `getRunStatus` reports correctly; finalised child → re-attach returns the final summary.
- **Unit:** simulated mid-LLM-call process death; child gets marked `failed` on next launch.
- **Integration:** end-to-end "dispatch background child → kill host → re-launch host → query status → fetch result".
- **e2e:** harder — requires a runtime that can simulate process death. The http runtime is best for this (per-turn-rebuild simulates lifecycle gaps already).
- **e2e-ui (Playwright):** tab close → reload → child shows up in the UI with status.

## Per-runtime impact

| Runtime | Considerations |
|---|---|
| **cli** | Process death = REPL exit. Re-launching the cli with the same `cwd` and session id rehydrates from `SessionStore`. |
| **http** | **Per-turn-rebuild is already a partial simulation.** Each request rebuilds the agent; resume works iff `SessionStore` carries enough state across rebuilds. This may push some of the design decisions earlier (during milestone 050) than they would otherwise need to be. |
| **browser** | Web Worker re-launches on tab reload. ZenFS + Dexie + `SessionStore` are durable. The challenge is reconstructing the "running" state if the worker died mid-LLM-call. |
| **chrome-ext** | **Service-worker eviction makes this critical.** MV3 SW lifetime is bounded; long-running children require resume to be useful at all in this runtime. |

The http and chrome-ext runtimes drive the design urgency. The implementing agent should probably scope milestones 050 + 060 together rather than separately.

## Follow-ups / open knobs

- **Cross-host resume** (cli dispatches, http picks up) — not in scope, would need explicit cross-host handshake.
- **Automatic stale-entry sweep at boot** — design call: should the SubagentService scan for `running` entries on launch and convert orphans, or wait for an explicit query?
- **A persistent in-memory cache layer** — beyond scope, but mentioned because the `activeRuns` map will likely need a re-think to handle re-attach gracefully.
- **Pub-sub for "child completed while parent was away"** — an extension might want to fire a notification when a re-attached parent sees a completed child it didn't know about. Not scoped.
