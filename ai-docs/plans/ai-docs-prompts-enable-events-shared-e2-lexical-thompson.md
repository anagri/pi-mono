# Enable `e2e/shared/events.e2e.ts` across all three runtimes

## Context

`packages/bodhi-pi/e2e/shared/events.e2e.ts` is guarded with `test.runIf(isRuntime("in-memory"))` — its two tests skip under `|cli|` and `|http|`. The tests pass JS callbacks via `eventHandlers` into `createE2EHarness`, and JS closures can't cross the cli stdio boundary or the http+SSE boundary.

Goal: lift the guard. After this change, every `e2e/shared/*` test runs under all three runtimes. The consolidated `test:e2e` report should move from `41 passed / 14 skipped` to `45 passed / 10 skipped` (the remaining 10 belong to the sibling `extensions` work).

The shape: harness exposes `events: BodhiPiEvent[]`. Same shape across runtimes. Tests read `harness.events` directly; the public `eventHandlers` option goes away. Each runtime forwards full event payloads — in-memory via direct push, http via the existing `_bodhi-pi/lifecycle/event` SSE frame (currently downsampled, switching to full payload in the test-app only), cli via a new stderr-as-event-channel using one JSON-RPC notification per line.

User-confirmed decisions (from upfront questions):

1. Sequence assertions use **strict subsequence** (relative ordering of key events, allowing interleaved extras).
2. Test-app-http forwards **all 25 event types** (production `bodhi-pi-http` keeps its current 19, untouched).
3. Full-payload forwarding lives **only in the test-app wire-agent** — production `recordFor` stays as-is.
4. `eventHandlers` is **removed** from `createE2EHarness` entirely. Tests read `harness.events`.

## End state

- `npm run test:e2e` in `packages/bodhi-pi` shows the events tests under `|in-memory|`, `|cli|`, `|http|` — zero skips on events.
- `just test` green.
- `harness.events` is the single source of truth for tests; same shape on every runtime.
- Production `packages/bodhi-pi-http` untouched.

## Critical files

### Reads / models

- `packages/bodhi-pi/test/helpers/event-recorder.ts` — `recorder()` shape, reused as-is for in-memory.
- `packages/bodhi-pi-http/src/server/agent/wire-agent.ts` — model for forwarding (production; do NOT modify).
- `packages/bodhi-pi-http/src/frontend/lib/acp-http-client.ts` — model for `onLifecycleEvent` dispatch.

### Modified

- `packages/bodhi-pi/e2e/helpers/harness.ts` — add `events: BodhiPiEvent[]` to `E2EHarness`; remove `eventHandlers` from `E2EHarnessOptions`; wire the three runtime branches to populate the array; pipe stderr in cli spawn.
- `packages/bodhi-pi/e2e/helpers/http-connection.ts` — add `onLifecycleEvent` constructor option; dispatch `_bodhi-pi/lifecycle/event` frames it currently drops.
- `packages/bodhi-pi/e2e/test-app-http/src/server/agent/wire-agent.ts` — replace downsampled `recordFor` forwarding with full-`BodhiPiEvent` payload; cover all 25 event types. Production `bodhi-pi-http` untouched.
- `packages/bodhi-pi/e2e/test-app-cli/src/cli.ts` — in `--rpc` mode, register default stderr-writing `BodhiPiEventHandlers` covering all 25 types so the cli emits ndjson lifecycle frames to stderr.
- `packages/bodhi-pi/e2e/shared/events.e2e.ts` — drop `runIf`, drop `recorder` import, read `harness.events`, add sequence-subsequence + payload assertions.

### New (small, focused)

- `packages/bodhi-pi/e2e/helpers/events-assert.ts` — `expectSubsequence(actual, expected, message?)` helper used by the rewritten tests.

## Channel-completion / race-condition handling

Different runtimes deliver events through different channels with different ordering guarantees vs. the prompt response:

- **in-memory**: `events.emit(...)` invokes the handler synchronously. By the time `prompt()` resolves, every event for the turn is already in `harness.events`. No race.
- **http**: lifecycle events and prompt result share the **same** SSE response stream (one POST → one ordered stream of frames). The client reads frames in order; when the `result` frame arrives and `call()` returns, every prior `_bodhi-pi/lifecycle/event` frame has been dispatched. No race.
- **cli**: lifecycle events flow on **stderr**, prompt response on **stdout**. These are independent OS pipes with independent read paths. Asserting immediately after `prompt()` is racy — the stdout response can arrive before the parent has drained the trailing stderr lines.

**Barrier**: harness exposes `flushEvents(): Promise<void>` that waits until `count(agent_end) >= count(agent_start) > 0` in `harness.events`, with a short idle-settle window and a 2 s timeout. Within stderr's line stream, ordering is preserved — so once the last `agent_end` has been observed, all earlier events on the same channel are also observed. Tests call `await h.flushEvents()` between `prompt()` and the assertions. For in-memory/http the call resolves on the first tick.

## Implementation phases

The prompt's depth-first convention applies: get one runtime green before moving to the next, one commit per phase.

### Phase 1 — In-memory plumbing + rewritten tests (test still runs under `|in-memory|` only)

1. **harness.ts**
   - Remove `eventHandlers?: BodhiPiEventHandlers` from `E2EHarnessOptions`.
   - Add `events: BodhiPiEvent[]` to `E2EHarness`.
   - In `createInMemoryHarness`: construct an internal `recorder()` (import the existing helper from `@test/helpers/event-recorder.js`); pass `handlers` to `createTestHarness`; expose `log` as `events` on the returned harness. No public eventHandlers knob remains.
   - In `createCliHarness` / `createHttpHarness`: add `events: []` placeholder (populated by phases 2–3).
2. **events.e2e.ts**
   - Drop `import { recorder } from "@test/helpers/event-recorder.js"` and the typed-event-payload imports that the new shape no longer needs (keep what's still asserted).
   - Drop the `runIf` guards.
   - Build the harness without `eventHandlers`. Read `harness.events`.
   - Rewrite the assertions:
     - **Sequence**: `expectSubsequence(h.events.map(e=>e.type), ["session_start","input","before_agent_start","agent_start","turn_start","message_start","message_update","message_end","turn_end","agent_end"])`. Strict relative order; interleaved extras (e.g. `before_provider_request`) allowed.
     - **Payload** (test 1): `agent_start.userPrompt` matches `/Monday/`; `agent_end.stopReason === "end_turn"`; at least one `message_update` carries `assistantMessageEvent.type === "text_delta"`; `before_provider_request.provider === "openai"` and `.modelId === model.id`; `after_provider_response.status === 200`.
     - **Tool turn** (test 2): subsequence `["tool_call","tool_execution_start","tool_execution_end","tool_result"]`; `tool_execution_end.isError === false`; `tool_execution_end.toolName === "read"`; `tool_call.toolName === "read"`.
3. **events-assert.ts** — implement `expectSubsequence(actual: string[], expected: string[], message?: string): void` using a single pass with a pointer; on miss, `expect.fail` with the matched-prefix diagnostic.
4. Run `npm run test:e2e -- --project in-memory events.e2e.ts` → green.
5. Run `just test` (in-memory subset) → green. Keep guard removed; cli/http are intentionally broken in this commit because they don't populate `events` yet. **Re-add `runIf(isRuntime("in-memory"))` at the very end of this phase** so the test suite still passes overall while phases 2 and 3 are in flight. (The guard is removed permanently in phase 3.)
6. Commit: `bodhi-pi-e2e events: in-memory populates harness.events; rewrite events.e2e.ts with subsequence + payload checks`.

### Phase 2 — HTTP plumbing

1. **test-app-http/src/server/agent/wire-agent.ts**
   - Replace `recordFor` + downsampled forwarding with a single `post(event)` that sends the **full** `BodhiPiEvent` as the notification `params`. Drop the `LifecycleEventRecord` interface from this test-app file (production type stays untouched).
   - Cover all 25 event types: extend the returned `BodhiPiEventHandlers` to include `auth_change`, `settings_change`, `compaction_start`, `compaction_end`, `branch_summary_created`, `session_navigate`, `session_fork`, `session_clone` (and verify the existing 19 are still listed; resolves the test-app's divergence from production by being deliberately broader).
   - Keep `LIFECYCLE_EVENT_METHOD = "_bodhi-pi/lifecycle/event"` — uniform frame name across runtimes.
2. **http-connection.ts**
   - Add `onLifecycleEvent?: (ev: BodhiPiEvent) => void` to `HttpConnectionOptions`.
   - In the SSE-parsing loop (current lines 114–117), add a branch for `f.method === "_bodhi-pi/lifecycle/event"` that invokes `this.onLifecycleEvent?.(f.params as BodhiPiEvent)`. Other unknown methods stay silently ignored.
3. **harness.ts** — `createHttpHarness`: pass `onLifecycleEvent: (ev) => events.push(ev)` to the `HttpAcpConnection` constructor.
4. Remove the `runIf` re-added at end of phase 1 from `events.e2e.ts` to allow http to run (cli will still be skipped in this phase only — add `test.runIf(!isRuntime("cli"))` as a temporary guard with a one-line comment saying "lifted in phase 3").
5. Run `npm run test:e2e -- --project http events.e2e.ts` → green. Then `npm run test:e2e -- --project in-memory events.e2e.ts` → green (regression).
6. Run full `just test` → green (cli still skipping events).
7. Commit: `bodhi-pi-e2e events: test-app-http forwards full BodhiPiEvent (all 25 types); harness.events populated under http`.

### Phase 3 — CLI plumbing

1. **test-app-cli/src/cli.ts**
   - In the `--rpc` branch (before the `new AgentSideConnection` line), if `cfg.eventHandlers` is undefined, build a default `BodhiPiEventHandlers` whose handler for every event type writes `JSON.stringify({ jsonrpc: "2.0", method: "_bodhi-pi/lifecycle/event", params: ev }) + "\n"` to `process.stderr`. Covers all 25 types.
   - The default handler set is a small inline factory (`stderrEventHandlers()`) inside `cli.ts`; no need for a shared module since this is the only test-app that needs it.
   - Pass the merged handlers into `createCliAgent({ ..., eventHandlers: stderrEventHandlers() })` only in `--rpc` mode — REPL/headless modes don't get the stderr writer (their stderr is human-readable).
2. **harness.ts** — `createCliHarness`:
   - Change spawn stdio from `["pipe", "pipe", "inherit"]` to `["pipe", "pipe", "pipe"]`. Update the `ChildProcessByStdio<NodeWritable, NodeReadable, NodeReadable>` generic accordingly.
   - Attach `readline.createInterface({ input: child.stderr! })` and on each `'line'` event, parse JSON, check `method === "_bodhi-pi/lifecycle/event"`, and `events.push(parsed.params)`. Lines that don't parse / don't match are forwarded to the parent's stderr verbatim (preserving the prior "inherit" diagnostic affordance for genuine error output).
   - `on('error')` for the readline interface logs once; no need to crash the test.
   - Cleanup unsubscribes the readline and closes the child as today.
3. **events.e2e.ts** — drop the `runIf(!isRuntime("cli"))` placeholder from phase 2. Tests now run under all three projects, no guards.
4. Run `npm run test:e2e -- --project cli events.e2e.ts` → green. Then regression across `--project in-memory` and `--project http`.
5. Run full `just test` → green across the monorepo.
6. Holistic cleanup pass on the changed files only: remove obvious comments, dead `void`-imports, residual `recordFor` references in the test-app, redundant guards. Keep comments only where the why is non-obvious (the stderr line-protocol contract, the "production diverges from test-app" note).
7. Commit: `bodhi-pi-e2e events: test-app-cli writes ndjson lifecycle frames to stderr; drop runIf, all 3 runtimes green`.

## Notes / design rationale

- **Why reuse `test/helpers/event-recorder.ts` for in-memory**: it is exactly the shape we want (single handler per event type that pushes to an array) and it already lives in the project. No duplication.
- **Why one stderr line = one JSON-RPC notification frame**: matches the wire format used over SSE (`{jsonrpc, method, params}`), so the harness's two parsers (SSE + readline) share the same payload shape. Future cross-runtime tooling can treat any `_bodhi-pi/lifecycle/event` frame uniformly.
- **Backpressure**: Node child stderr pipe buffer is 16 KB; with the e2e load (10–30s tests, ~20–50 events each ~ a few KB total), draining via `readline` `'line'` callbacks is sufficient. No risk of child blocking. Documented in a single line above the readline wiring.
- **Production `bodhi-pi-http` unchanged**: per question 3, only the test-app gets full-payload forwarding. The production `recordFor` remains the public contract for that package.
- **Why remove `eventHandlers` from `E2EHarnessOptions`**: per question 4. Only `events.e2e.ts` ever passed it; once tests read `harness.events`, the public knob has no remaining caller. Less API surface, fewer cross-runtime divergences.
- **Why subsequence over exact-prefix**: the `before_provider_request` / `after_provider_response` pair fires inside the turn loop; its placement relative to `message_start` is non-deterministic across providers. Subsequence captures causal order without overfitting.

## Verification

- `cd packages/bodhi-pi && npm run test:e2e` — events tests show under all three project labels with zero skips. Report header should read `45 passed / 10 skipped` (remaining 10 = `extensions.e2e.ts` × 2 non-in-memory runtimes, owned by the sibling prompt).
- `cd packages/bodhi-pi && npm run test:e2e -- --project in-memory events.e2e.ts` — green.
- `cd packages/bodhi-pi && npm run test:e2e -- --project http events.e2e.ts` — green.
- `cd packages/bodhi-pi && npm run test:e2e -- --project cli events.e2e.ts` — green.
- `just test` (monorepo) — green.
- Manual: run a cli test with `DEBUG=1` and confirm `_bodhi-pi/lifecycle/event` lines appear on the spawned child's stderr (capturable via the readline tap) but NOT on the parent vitest stderr.
- Production `packages/bodhi-pi-http` is untouched: `git diff --name-only` lists no production files outside the four areas above.
