# Kickoff: enable `e2e/shared/events.e2e.ts` across all three runtimes

This is a new chat session. Read this prompt end-to-end, explore the codebase, ask clarifying questions, then propose a plan via `ExitPlanMode`. Do NOT start implementing until the plan is approved. **Implement this BEFORE the sibling prompt `enable-extensions-shared-e2e.md`.**

## Goal

`packages/bodhi-pi/e2e/shared/events.e2e.ts` is currently `test.runIf(isRuntime("in-memory"))` — 2 tests that skip under `|cli|` and `|http|`. Remove the guard. After this change, every shared e2e test runs under all three runtimes (in-memory, cli, http) with **zero** runtime-skip-only tests in `e2e/shared/`.

End state in the consolidated test:e2e report: instead of `41 passed / 14 skipped`, it should read `45 passed / 10 skipped` (the remaining 10 are the 5 extensions tests × 2 non-in-memory runtimes; those land in the sibling prompt).

## Why these tests skip today

The tests construct an in-process `recorder()` (`packages/bodhi-pi/test/helpers/event-recorder.ts`) that produces a `BodhiPiEventHandlers` object — a record of arrays of JS callbacks. The handlers are passed via `createE2EHarness({ ..., eventHandlers })` and end up inside the agent's `EventDispatcher`. Each callback closes over the test's `log: BodhiPiEvent[]` array; assertions read `log` directly.

Callbacks are JS closures. They can't be marshaled over the cli stdio boundary or the http+SSE boundary. Hence the runtime guard.

## What's already on the wire (and what isn't)

- **In-memory runtime**: callbacks fire in-process. Today's tests work.
- **HTTP runtime**: `packages/bodhi-pi-http/src/server/agent/wire-agent.ts` already registers `eventForwardingHandlers(conn)` (lines ~80–109) that forwards events as `conn.extNotification("_bodhi-pi/lifecycle/event", ...)`. The notification arrives on the prompt SSE stream alongside `session/update`. The frontend client (`packages/bodhi-pi-http/src/frontend/lib/acp-http-client.ts`) has `onLifecycleEvent(handler)` that catches these frames. **But** the server downsamples each event via a `recordFor()` helper to a `LifecycleEventRecord` containing only a handful of scalar fields (type, sessionId, toolName, userPrompt, stopReason, fromModelId, toModelId). Many fields the current event tests assert on (provider, modelId, status, assistantMessageEvent, isError) are NOT in that record. Also only 20 of 25 event types are forwarded; 5 are silently dropped (`settings_change`, `compaction_end`, `branch_summary_created`, `session_navigate`, `session_fork`, `session_clone`).
- **CLI runtime**: nothing. The spawned `test-app-cli --rpc` doesn't emit events anywhere. Stderr is `inherit`'d, so even diagnostic output is lost. test-app-cli's `createCliAgent` accepts an `eventHandlers` option but the harness never passes one.

## Direction (decided; open to re-explore)

The user already recommended the high-level approach. Explore and follow these recommendations, or propose something better:

1. **Send the FULL event payload, not the downsampled record.** All 25 event types in `packages/bodhi-pi/src/events/types.ts` are fully JSON-serializable (verified — scalars, AgentMessage from pi-agent-core, AssistantMessageEvent from pi-ai, AgentToolResult — no closures, no AsyncIterators). Drop the `recordFor()` downsampling for the test-app — only the test-app, not bodhi-pi-http. bodhi-pi-http keeps its current shape.

2. **Two channels per runtime, with `_bodhi-pi/lifecycle/event` as the uniform frame format on each:**
   - **CLI**: spawn test-app-cli with stderr piped (today: inherited). test-app-cli writes one `_bodhi-pi/lifecycle/event` JSON-RPC notification per line to stderr — full event in `params`. Stderr becomes the dedicated event channel; stdout stays pure ACP.
   - **HTTP**: existing SSE stream already multiplexes `session/update` and `_bodhi-pi/lifecycle/event` frames over the same `/acp` POST response. Keep that — the harness's `HttpAcpConnection` (`packages/bodhi-pi/e2e/helpers/http-connection.ts`) needs to start dispatching the lifecycle frames it currently ignores (search for the comment about ignoring other notification methods).
   - **In-memory**: harness registers its own internal eventHandler set; same JSON-shaped event flows into the same `harness.events` array. Remove downsampling if any.

   The user explicitly confirmed: the **channel count** is per-runtime (cli has 2 distinct OS-level channels; http multiplexes 2 frame types over 1 SSE response; in-memory has direct in-process access). The **frame format** is uniform: `_bodhi-pi/lifecycle/event` JSON-RPC notifications carrying the full BodhiPiEvent in `params`.

3. **Harness exposes `events: BodhiPiEvent[]`.** Same shape across runtimes. Tests read `harness.events` instead of importing `recorder()` and passing `eventHandlers` in. The harness handles ALL three transports internally.

4. **Test shape stays runtime-blind.** Drop `test.runIf(...)` from `events.e2e.ts`. The two existing tests should pass under all three projects without per-runtime branches. The user also wants the tests **enhanced**: check event SEQUENCES, check PAYLOAD field correctness, not just `types.includes(...)` presence. Use this as an opportunity to harden them.

## Critical files (read these first, in this order)

- `ai-docs/plans/we-have-decided-to-fuzzy-valley.md` — current state plan that landed Phases 1–5 + the dependency-removal phases. The architecture overview lives here.
- `packages/bodhi-pi/e2e/CLAUDE.md` — the conventions (global env in global-setup, 30s timeout default, flow-based tests, soft-assert usage, `@e2e/*` alias, no bodhi-pi-* sibling deps).
- `packages/bodhi-pi/e2e/shared/events.e2e.ts` — the two tests being unblocked.
- `packages/bodhi-pi/src/events/types.ts` — all 25 event-type definitions.
- `packages/bodhi-pi/src/acp/agent.ts` — search for `this.events.emit(` to see every emit site (~30 of them).
- `packages/bodhi-pi/test/helpers/event-recorder.ts` — the in-process recorder pattern that the test uses today.
- `packages/bodhi-pi-http/src/server/agent/wire-agent.ts` — `LIFECYCLE_EVENT_METHOD` + `eventForwardingHandlers` + `recordFor`. The model to follow; `recordFor` is the part we're replacing with full-payload forwarding.
- `packages/bodhi-pi-http/src/frontend/lib/acp-http-client.ts` — `onLifecycleEvent(handler)`. The pattern the harness's `HttpAcpConnection` should adopt.
- `packages/bodhi-pi/e2e/test-app-http/src/server/agent/wire-agent.ts` — the test-app's copy of wire-agent. Modify here to forward full payloads (production bodhi-pi-http stays untouched).
- `packages/bodhi-pi/e2e/test-app-cli/src/cli.ts` — `--rpc` branch. Wire a default eventHandler set when no eventHandlers are passed AND stderr is piped (or always, in `--rpc` mode).
- `packages/bodhi-pi/e2e/helpers/harness.ts` — `createE2EHarness` dispatch by runtime. Add the `events` field to the return shape; wire the in-memory, cli, http branches.
- `packages/bodhi-pi/e2e/helpers/http-connection.ts` — add `onLifecycleEvent` to its constructor options; parse `_bodhi-pi/lifecycle/event` frames during SSE.

## Things to explore + decide before writing code

- **Stderr framing**: one JSON-RPC notification per line (`{jsonrpc:"2.0", method:"_bodhi-pi/lifecycle/event", params:{...event}}\n`) keeps wire-format uniformity with http. Verify the harness can parse line-by-line robustly (partial reads, large frames).
- **Backpressure**: stderr is fire-and-forget. If the harness doesn't drain stderr fast enough, will the child process block? Node's stderr pipe has a buffer; with the e2e load (10s-30s tests, ~20-50 events each) this should be fine, but worth confirming the harness reads stderr eagerly.
- **Event ordering**: events fire in a specific causal order (session_start → input → before_agent_start → agent_start → ...). The user wants tests to assert on the SEQUENCE, not just presence. Decide the shape of the sequence assertion (strict-subsequence, exact-prefix, partition by phase, etc.).
- **The 5 omitted event types in production**: bodhi-pi-http's `eventForwardingHandlers` registers 20 of 25 types. The test-app needs all 25 forwarded if tests want full visibility. Decide the test-app's coverage.
- **Where does the in-memory harness hook events?** The existing in-memory branch passes `opts.eventHandlers` straight through to `createTestHarness`. Refactor so the harness ALWAYS registers its own internal recorder (populating `harness.events`) AND allows the test to pass additional handlers. Tests then just read `harness.events`; the `eventHandlers` option becomes purely additive.

## Conventions to follow (non-negotiable)

- `bodhi-pi/e2e/` must not depend on any `@bodhiapp/bodhi-pi-*` sibling package. Use `@e2e/*` alias.
- vitest and Playwright stay separate runners — this work is vitest-only.
- 30s global testTimeout. Document any `60_000` override.
- One commit per phase. Each phase ends with the in-scope project(s) green, then monorepo `just test` green.
- Follow depth first approach, first fix the in-memory for the changes, run test, green, then implement http for changes, as the channel already present, include in the test run, fix test if any, green, the remove the runIf, and include cli in the run, implement the stderr channel approach, run test, fix, green
- Holistically analyze the changes, if there can be some clean up, clean code, refactor, duplication, unnecessary comments
- keep comments only for non-obvious and quirky code, do not litter with obvious comments

## Workflow

1. Read the references above in order. Build a mental model of how events flow today across the three runtimes.
2. Run the current `events.e2e.ts` under `--project in-memory` to see what passes — that's your baseline.
3. Decide the sequence/payload assertion shape for the rewritten tests.
4. Propose a phased plan via `ExitPlanMode` after writing it to a new `ai-docs/plans/<slug>.md`. Suggested phases: (1) extend harness with events plumbing for all three runtimes; (2) rewrite the two existing tests to use `harness.events` and assert on sequence + payload; (3) drop the `runIf` guard; (4) gate-check across all 3 projects + just test; (5) commit.
5. Implement phase-by-phase with green gates between phases.

End state: `npm run test:e2e` from `packages/bodhi-pi` shows the events tests under all three project labels (`|in-memory|`, `|cli|`, `|http|`) — no skips on events. `just test` green.
