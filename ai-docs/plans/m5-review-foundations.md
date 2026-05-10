# Plan — Implement bodhi-pi & bodhi-pi-web review fixes (single commit)

## Context

The review at `ai-docs/reviews/2026-05-10-pi-and-web-health.md` surfaced 13 findings across two packages — type-safety drift in ACP message handling, POSIX path bugs that would break a Windows host, byte-vs-char inconsistency in tool truncation, a few module-structure smells, two async/error contract gaps, and (the largest piece) a pile of e2e whitebox bridges (`window.__bodhiPiEventLog`, `__bodhiPiWebRecordEvents`, the `recordEvents` flag plumbing) that reach into page state instead of asserting against the DOM.

`bodhi-pi-web` is a **reference / test host, not a production app**, so the right fix is to surface the data the e2e suite needs in the UI itself: an always-visible `<EventsPanel>` next to `<ChatPage>` with two tabs (lifecycle bodhi-pi events + raw ACP wire frames). Specs read it via `data-testid`/attribute locators — no `page.evaluate`, no global state. The FSA seed (`__bodhiPiWebSeed` + `addInitScript`) is the documented exemption: there is no DOM affordance that can replace Chrome's File System Access picker bypass.

All work ships as a **single commit** per user direction. `just test` (build + unit + integration + Playwright across every `bodhi-pi*` package, dep order) is the final gate.

## Approach

One commit, layered so the build stays green between hunks:

1. Pure-refactor fixes in `bodhi-pi` core + `bodhi-pi-web` source (Batches A–E from the review).
2. Add `<EventsPanel>` + Zustand `eventStore` + ACP wire tee (Batch F.1, F.2). Adds UI; no behaviour change.
3. Strip the `recordEvents` flag end-to-end (Batch F.3). Safe only after step 2.
4. Rewrite `events.spec.ts` against panel locators; trim `seed.ts` to FSA-only (Batch F.4, F.5).
5. CLAUDE.md fixes (Batch D.4) — last so the docs reflect the new state.

## Detailed changes

### Batch A — ACP type-safety (replace `as` casts with discriminator narrowing)

- `packages/bodhi-pi/src/acp/notifications.ts:6,11,22,24,33,87` — narrow on `pi-ai`'s `Message.role` discriminator. Drop `(msg as { role?: unknown }).role` form.
- `packages/bodhi-pi/src/acp/agent.ts:577` — replace `event.message as { stopReason?, errorMessage? }` with an early `if (event.message.role !== "assistant") return;` then read fields off the typed `AssistantMessage`.
- `packages/bodhi-pi-web/src/agent/render.ts:47-92` — switch on `notif.update.sessionUpdate` (SDK's literal-tagged discriminator) and let TS narrow each branch. Drop `mapStatus(string | undefined)` in favour of the SDK's `ToolCallStatus` enum.
- `packages/bodhi-pi-web/src/ui/commands.ts:85,97,147` — use SDK's `SetSessionConfigOptionResponse`/`ListSessionsResponse` shapes; drop the cast layers.

### Batch B — POSIX path portability

- `packages/bodhi-pi/src/tools/index.ts:39` — `path.isAbsolute` → `path.posix.isAbsolute`.
- `packages/bodhi-pi/src/tools/walk.ts:21` — `path.basename` → `path.posix.basename`.

### Batch C — Bounded-truncation contract

- `packages/bodhi-pi/src/tools/_accumulate.ts:16-49,72-82` — rename `maxBytes` parameter and field to `maxChars`; rewrite footer reason from "KB output limit" to "chars output limit". Choose this over a `Buffer.byteLength` rewrite — same semantic guard, honest naming. (CLAUDE.md note at `packages/bodhi-pi/CLAUDE.md:75` already calls `accumulateBounded` "canonical for list-producing tools" — only the unit name changes.)
- `packages/bodhi-pi/src/tools/read.ts:35-48` — replace the `Buffer.from(...).subarray(...).toString()` slice with a forward walk that joins complete lines while `Buffer.byteLength(running)+1 <= READ_MAX_BYTES`. Eliminates the mid-multibyte `�` corruption.
- `packages/bodhi-pi/src/tools/limits.ts:14` — add `export const WALK_MAX_ENTRIES = 50_000;`.
- `packages/bodhi-pi/src/tools/find.ts:7,33` and `packages/bodhi-pi/src/tools/grep.ts:7,52` — import `WALK_MAX_ENTRIES` and use it.

### Batch D — Module structure & docs drift

- `packages/bodhi-pi/src/extensions/runner.ts:184-193` — extract `mergeTools` and `mergeCommands` into a new file `packages/bodhi-pi/src/extensions/merge.ts`. Update import sites in `packages/bodhi-pi/src/acp/agent.ts:43` and any test helper that imports them.
- `packages/bodhi-pi/src/tools/run-script.ts:15-26` — change factory signature to `createRunScriptTool(deps: ToolDeps)`; assert `deps.scriptExecutor !== undefined` at the top of `execute`. Update `packages/bodhi-pi/src/tools/index.ts:28-30` call site.
- `packages/bodhi-pi/src/index.ts` — re-export `EXT_DELETE_SESSION` and `MODEL_CONFIG_ID` from `./acp/constants.js`.
- `packages/bodhi-pi-web/src/ui/commands.ts:12,176` — drop the local `EXT_DELETE_SESSION` literal; import from `@bodhiapp/bodhi-pi`.
- `packages/bodhi-pi/CLAUDE.md:62` — fix `src/slash-commands/` → `src/commands/`.
- `packages/bodhi-pi-web/CLAUDE.md` — see Batch F note at the bottom of this doc.

### Batch E — Async/error-contract gaps

- `packages/bodhi-pi/src/extensions/events-bus.ts:10-16` — replace `try { void h(data); } catch ...` with `Promise.resolve(h(data)).catch((err) => console.error(\`[bodhi-pi pi.events:${channel}] handler threw\`, err));`. Drop the surrounding `try/catch`.
- `packages/bodhi-pi/src/acp/notifications.ts:95-117` — narrow parameter to `Exclude<PiStopReason, "error"> | undefined`. Caller at `packages/bodhi-pi/src/acp/agent.ts:447-456` already throws before this is reached, so no runtime change needed; the types now reflect that contract.

### Batch F — EventsPanel + e2e blackbox-ification

The biggest piece. Validated technical ground truth from Phase 1 Explore:

- `createMessagePortStream` (in `packages/bodhi-pi-browser/src/transport/message-port-stream.ts:16-72`) returns `{ readable: ReadableStream<Uint8Array>, writable: WritableStream<Uint8Array> }`.
- `ndJsonStream` consumes byte-level streams (per ACP SDK `dist/stream.d.ts:24` — `(output: WritableStream<Uint8Array>, input: ReadableStream<Uint8Array>) => Stream`).
- Therefore: wrap each stream with a `TransformStream<Uint8Array>` that passes bytes through unchanged while capturing line-delimited frames into a sidechannel. Decoder is `TextDecoder("utf-8")`; split on `\n`; each non-empty line is a JSON-RPC frame.
- No tab UI primitive exists in `packages/bodhi-pi-web/src/`; rolling a small CSS-tabbed div is the right call (test host, not production).
- `chatStore.ts` uses a flat single-store Zustand pattern — match that for the new event store rather than slicing.
- `<RuntimeProvider>` already wraps `<ChatPage>` in `App.tsx:69-72`; `<EventsPanel>` is a sibling inside the same provider so it shares the runtime context.

#### F.1 — `<EventsPanel>` UI (always visible)

New files:

- `packages/bodhi-pi-web/src/store/eventStore.ts` — Zustand store mirroring `chatStore.ts:47-97` shape. Two arrays: `lifecycle: LifecycleEventRow[]`, `wire: WireEventRow[]`. Actions: `pushLifecycle(row)`, `pushWire(row)`, `clear()`. `LifecycleEventRow` carries `{ id, type, sessionId?, toolName?, userPrompt?, stopReason?, fromModelId?, toModelId? }` (mirrors today's `WorkerEventMessage["record"]`). `WireEventRow` carries `{ id, direction: "in" | "out", method?, frameType: "request" | "response" | "notification" | "error", payload: string }`. Cap each list at e.g. 500 rows to bound memory; FIFO.
- `packages/bodhi-pi-web/src/ui/EventsPanel.tsx` — the panel. Outer `<aside data-testid="events-panel">`. Tab strip with `<button data-testid="events-tab" data-tab-name="lifecycle" data-tab-active="true|false">` and same for `wire`. Body lists rows: `<div data-testid="event-row" data-event-source="lifecycle|wire" data-event-type="..." data-event-direction="in|out" data-session-id="..." data-tool-name="...">{JSON.stringify(payload)}</div>`. Reuse `useChatStore` styling conventions; one new CSS rule block in `App.css`.
- `packages/bodhi-pi-web/src/ui/EventsPanel.css` (or extend `App.css`) — flexbox split: `.app-shell { display: flex; }`, `.chat-region { flex: 1 1 auto }`, `.events-region { flex: 0 0 420px; }`. Tab strip via simple buttons.

Modified files:

- `packages/bodhi-pi-web/src/App.tsx:69-73` — wrap children in a `<div className="app-shell">` containing `<ChatPage/>` and `<EventsPanel/>`. Both stay inside `<RuntimeProvider>`.

#### F.2 — Capture lifecycle events + ACP wire frames

- `packages/bodhi-pi-web/src/agent/worker.ts:17-63` — `recordingHandlers()` becomes `eventForwardingHandlers()` (no semantic change, name reflects always-on). Keep all 19 handlers (verified complete vs `packages/bodhi-pi/src/events/types.ts:208-228`).
- `packages/bodhi-pi-web/src/agent/worker.ts:97` — wrap the streams before `ndJsonStream`:
  ```
  const { readable, writable } = createMessagePortStream(agentPort);
  const teedReadable = readable.pipeThrough(makeFrameTap("in"));
  const teedWritable = makeWritableTap("out", writable);
  const conn = new AgentSideConnection(factory, ndJsonStream(teedWritable, teedReadable));
  ```
  `makeFrameTap(direction)` is a `TransformStream<Uint8Array, Uint8Array>` that buffers bytes, splits on `\n`, decodes each non-empty line, posts `{ type: "bodhi-pi-wire", direction, line }` via `self.postMessage(...)`, and forwards the original chunk untouched.
- `packages/bodhi-pi-web/src/agent/runtime.ts:78-79` — same wrap on the main side. Wire records dispatch directly into `useEventStore.getState().pushWire(...)` (already on main thread).
- New file `packages/bodhi-pi-web/src/agent/wire-tap.ts` — exports `makeFrameTap(direction, sink)` and the buffering/decoding logic. Pure module; one place to test the byte→line decoder.
- `packages/bodhi-pi-web/src/agent/types.ts` — add `WorkerWireMessage = { type: "bodhi-pi-wire"; direction: "in" | "out"; line: string }` to the postMessage discriminated union. Update `runtime.ts` listener.

#### F.3 — Remove the `recordEvents` flag end-to-end

- `packages/bodhi-pi-web/src/agent/types.ts:18-25` — drop `recordEvents` from `InitMessage`.
- `packages/bodhi-pi-web/src/agent/runtime.ts:13-17` — delete the `Window.__bodhiPiEventLog` augmentation.
- `packages/bodhi-pi-web/src/agent/runtime.ts:34-39` — drop `recordEvents` from `RuntimeOptions`.
- `packages/bodhi-pi-web/src/agent/runtime.ts:62-76` — delete the conditional `worker.addEventListener` block that initialised `window.__bodhiPiEventLog`. Replace with always-on listener that routes `{type:"bodhi-pi-event"}` and `{type:"bodhi-pi-wire"}` into `useEventStore`.
- `packages/bodhi-pi-web/src/agent/worker.ts:69, 93-94` — drop the `recordEvents` destructure and the conditional `eventHandlers` injection. Always register handlers.
- `packages/bodhi-pi-web/src/workspace/bootstrap.ts:11, 31-42, 53, 65` — drop `__bodhiPiWebRecordEvents`, `readRecordEventsFlag`, the `recordEvents` field on every `BootstrapResult` variant.
- `packages/bodhi-pi-web/src/ui/RuntimeProvider.tsx:33-37, 39, 62, 76, 142` — drop the `recordEvents` prop and pass-through.
- `packages/bodhi-pi-web/src/App.tsx:32, 70` — drop the `recordEvents` arg.

#### F.4 — Rewrite `events.spec.ts` against panel locators

- New `packages/bodhi-pi-web/e2e/pages/EventsPanel.ts` — page object alongside `ChatPage.ts:1-60`. Locators: `panel`, `tab(name: "lifecycle"|"wire")`, `rows(filter?: { type?, toolName?, direction? })`, `expectRow(filter)`. Mirrors the `ChatPage.toolCalls()` shape at `e2e/pages/ChatPage.ts:45-50`.
- `packages/bodhi-pi-web/e2e/events.spec.ts` — full rewrite. Replace `readLog`/`page.evaluate` with `events.tab("lifecycle").click()` then `expect(events.rows({ type: "agent_start" })).toHaveCount(...)` and `toHaveAttribute("data-user-prompt", /ping/)` style assertions. The new wire tab unlocks an additional test step that asserts a `session/new` request and matching response cross the wire.
- `packages/bodhi-pi-web/e2e/fixtures.ts:5-31` — extend the fixture to expose `events: EventsPanel` alongside `chat: ChatPage`.

#### F.5 — Trim `seed.ts` to FSA-only

- `packages/bodhi-pi-web/e2e/helpers/seed.ts:7-29` — delete the `__bodhiPiWebRecordEvents` injection at `:25,27`. Rewrite the docstring at `:7-17` to flag `__bodhiPiWebSeed` as the **only** sanctioned whitebox bridge — kept because no DOM affordance can substitute for the FSA picker bypass.

#### F.6 — Sweep verification

`grep -rn "window\\.\\|page.evaluate" packages/bodhi-pi-web/e2e packages/bodhi-pi-web/src` should after this change return only:

- `e2e/helpers/seed.ts` references to `__bodhiPiWebSeed` (the documented exemption)
- `src/workspace/bootstrap.ts` reads of `window.__bodhiPiWebSeed` and `window.showDirectoryPicker`
- `src/ui/StatusBar.tsx` `window.confirm` (production UX; not a test bridge)

If anything else surfaces, treat as a regression in this commit.

### Batch D.4 (post-F) — CLAUDE.md updates

- `packages/bodhi-pi-web/CLAUDE.md:19` — drop the "recordEvents is an independent observability toggle" sentence; replace the "Tests bypass the FSA picker via seed injection" paragraph to: seed is now the only test-mode injection; events are captured by the always-on `<EventsPanel>` regardless of seed-vs-FSA.
- `packages/bodhi-pi-web/CLAUDE.md:77` — drop the M5.2 mention of `window.__bodhiPiEventLog`; document the panel + page object as the canonical observability surface.
- `packages/bodhi-pi-web/CLAUDE.md` — Add `EventsPanel.tsx`, `EventsPanel.ts` (POM), `eventStore.ts`, `wire-tap.ts` to the "Key files" table.

## Critical files to modify

Core:

- `packages/bodhi-pi/src/acp/agent.ts` (A.2)
- `packages/bodhi-pi/src/acp/notifications.ts` (A.1, E.2)
- `packages/bodhi-pi/src/index.ts` (D.3)
- `packages/bodhi-pi/src/extensions/runner.ts` + new `merge.ts` (D.1)
- `packages/bodhi-pi/src/extensions/events-bus.ts` (E.1)
- `packages/bodhi-pi/src/tools/{index,walk,read,find,grep,run-script,_accumulate,limits}.ts` (B, C, D.2)
- `packages/bodhi-pi/CLAUDE.md` (D.4)

Web:

- `packages/bodhi-pi-web/src/agent/{worker,runtime,types}.ts` + new `wire-tap.ts` (A.3 partial, F.2, F.3)
- `packages/bodhi-pi-web/src/agent/render.ts` (A.3)
- `packages/bodhi-pi-web/src/ui/{commands,RuntimeProvider}.{ts,tsx}` (A.4, F.3)
- `packages/bodhi-pi-web/src/ui/EventsPanel.tsx` (new — F.1)
- `packages/bodhi-pi-web/src/store/eventStore.ts` (new — F.1)
- `packages/bodhi-pi-web/src/workspace/bootstrap.ts` (F.3)
- `packages/bodhi-pi-web/src/App.tsx`, `App.css` (F.1, F.3)
- `packages/bodhi-pi-web/e2e/{events.spec.ts,fixtures.ts,helpers/seed.ts}` + new `pages/EventsPanel.ts` (F.4, F.5)
- `packages/bodhi-pi-web/CLAUDE.md` (D.4 post-F)

## Reused functions & utilities

- `createMessagePortStream` from `@bodhiapp/bodhi-pi-browser` — already wired at `runtime.ts:78` and `worker.ts:97`. We wrap, not replace.
- `recordingHandlers()` at `worker.ts:17-63` — keep its 19-handler structure verbatim (confirmed complete vs `bodhi-pi/src/events/types.ts:208-228`); rename and drop the gate.
- `WorkerEventMessage["record"]` shape at `agent/types.ts:29-40` — repurpose as the `LifecycleEventRow` payload in the new `eventStore` so existing data flow is preserved.
- Zustand `create<...>(...)` pattern at `chatStore.ts:47` — mirror in `eventStore.ts`.
- `ChatPage` page-object pattern at `e2e/pages/ChatPage.ts:1-60` — mirror in `e2e/pages/EventsPanel.ts`.
- `ToolCallContent` extractor at `render.ts:10-21` — keep; it's already typed.

## Verification

In order, after the single commit lands:

1. **Build**: `npm --workspace @bodhiapp/bodhi-pi run build && npm --workspace @bodhiapp/bodhi-pi-web run build`. Surfaces any TS regression from the discriminator narrowing in Batch A.
2. **Core unit/integration**: `npm --workspace @bodhiapp/bodhi-pi run test` — covers `chat`, `commands`, `events`, `extensions`, `fs`, `run-script`, `skills`, `notifications`, `walk`, plus the in-memory adapters. Most Batch A/B/C/D/E findings are guarded here.
3. **Core e2e**: `npm --workspace @bodhiapp/bodhi-pi run test:e2e` — gpt-4o-mini round-trips. Catches anything that breaks the ACP wire shape.
4. **Web Playwright**: `npm --workspace @bodhiapp/bodhi-pi-web run test:e2e`. The rewritten `events.spec.ts` is the gate for Batch F (panel locators replace `page.evaluate`); `fs-tools.spec.ts`, `chat.spec.ts`, `extensions.spec.ts`, etc. assert behavioural parity.
5. **Manual smoke (optional)**: launch `npm --workspace @bodhiapp/bodhi-pi-web run dev`, mount `e2e/examples/` via the FSA picker, watch the EventsPanel's two tabs populate during a chat turn — verifies the panel works against a real LLM with no seed in play.
6. **Final gate**: `just test` from the repo root — runs build + unit/integration + e2e for `pi-ai`, `pi-agent-core`, `bodhi-pi`, `bodhi-pi-node`, `bodhi-pi-browser`, `bodhi-pi-cli`, `bodhi-pi-web` in dep order. Must pass green before commit. Per `justfile:30-65` this is the canonical full-stack gate.

## Out of scope

- The FSA-seed mechanism (`__bodhiPiWebSeed` + `addInitScript` in `e2e/helpers/seed.ts`) stays — explicit user exemption; no DOM-side replacement exists for the picker bypass.
- `window.confirm` in `StatusBar.tsx:10` is production UX, not a test bridge — no change.
- No new unit tests for `bodhi-pi-web/src/` — package is e2e-only by design (no vitest dep in its `package.json`).
- License decision, MCP client, image input, watch/atomic-rename FS — see `ai-docs/plans/deferred.md`.
