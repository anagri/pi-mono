# Plan: Functional & E2E Parity for bodhi-pi-ws-* with bodhi-pi-web

## Context

The repo currently has two reference host apps for the `bodhi-pi` core:

- **`bodhi-pi-web`** — browser-only host. UI on the main thread, agent runtime in a Web Worker, ACP framed over `MessagePort`. Workspace via FSA (Chrome) or seeded ZenFS (tests). 18 e2e specs (M3–M16) covering chat, sessions, models, fs-tools, commands, skills, extensions, lifecycle/wire events, cancellation, cross-provider, tool failure/replay.
- **`bodhi-pi-ws-server` + `bodhi-pi-ws-frontend`** — split host. Server runs the agent in Node, exposes ACP over WebSocket with a bearer-token subprotocol and multi-tenant SQLite. Frontend is a thin React client. 18 e2e specs (M1–M12) covering similar ground with two visible gaps below.

The user has now declared a **parity rule**: any feature added to `bodhi-pi` core MUST land in `bodhi-pi-web` *and* in `bodhi-pi-ws-server` + `bodhi-pi-ws-frontend`. This plan closes the gaps that exist today, sets up sustained parity, and turns ws-frontend e2e from serial-and-slow into concurrent-and-fast by leaning on the multi-tenancy and per-test-server isolation we already have.

Both apps are test hosts, not production — adding test-only UI affordances for blackbox observability is fair game.

---

## Findings

### A. Functional parity audit

Categories where `ws-frontend`/`ws-server` already match `bodhi-pi-web`:

| Capability | Web | WS | Notes |
|---|---|---|---|
| Streaming chat round-trip | ✅ | ✅ | both via ACP `agent_message_chunk` |
| Tool-call card with running/completed/failed | ✅ | ✅ | `data-tool-status` on both |
| Tool preview (first ~400 chars) | ✅ | ✅ | |
| `/help`, `/model`, `/sessions`, `/new`, `/resume`, `/close`, `/delete` | ✅ | ✅ | local dispatchers in both UIs |
| Project commands + skills + scripted skills | ✅ | ✅ | scripted skill works in WS too — register state in server CLAUDE.md is stale, see fix below |
| Cross-provider in one session | ✅ | ✅ | |
| Extensions (`.bodhi-pi/extensions/*.{js,mjs,cjs}`) | ✅ | ✅ | per-connection load on server |
| Tool failure / replay-on-resume | ✅ | ✅ | |
| Cancellation (`Stop` button) | ✅ | ✅ | |
| Auto-resume last session on reload | ✅ | ✅ | scoped by `(serverUrl, userId)` in WS |

Real **gaps** to close:

1. **Lifecycle events panel.** `bodhi-pi-web`'s `EventsPanel` has TWO tabs: `lifecycle` (19 `BodhiPiEvent` types — `agent_start`, `before_provider_request`, `after_provider_response`, `tool_execution_start/end`, `model_select`, `turn_start/end`, …) and `wire` (raw ACP frames). `ws-frontend` only has the wire tab. The lifecycle stream never crosses the WebSocket today. This is the load-bearing observability surface that `events.spec.ts` and several follow-on specs assert against in web; it is the single largest parity gap.
2. **`run_script` registration on server.** `ws-server/src/CLAUDE.md` still says "ScriptExecutor not registered". `m8-scripted-skill.spec.ts` passes, so it is in fact registered (per-user workspace dir is the sandbox). CLAUDE.md needs to be corrected, or — if it really is unregistered and the spec is racing on something else — the registration needs to land. Verify before editing.
3. **Composer state attribute.** Web has `[data-testid=chat-page][data-test-state=streaming|idle|closed|error|...]` at the chat-root level; ws-frontend has `data-chat-status` only on the status panel. Move/duplicate it onto a chat-root container so `expect(chat).toHaveAttribute('data-test-state', 'idle')` works the same way in both.
4. **Status bar `[data-mount-path]` / `[data-session-id]` shape.** Web exposes both on the status bar; ws-frontend exposes `data-current-session-id` (different name, same intent) and no mount-path equivalent. Align names — picking the WS-friendly versions everywhere is fine, but the names should be one set, not two.
5. **`__bodhiPiWebSeed` analogue not needed** — ws-frontend mounts the workspace server-side via the per-test spawn, so no in-page seed bridge is required. (Documenting this so future work doesn't re-introduce one.)

### B. E2E test audit

Spec-by-spec mapping (kept terse):

| Web spec | WS spec | Status |
|---|---|---|
| `chat.spec.ts` | `m2-prompt.spec.ts` | parity |
| `model-switch.spec.ts` | `m12-model-switch.spec.ts` | parity |
| `sessions.spec.ts` | `m5-sessions.spec.ts` | parity |
| `workspace.spec.ts` | `m10-workspace.spec.ts` | parity |
| `fs-tools.spec.ts` | `m10-fs-tools.spec.ts` | parity |
| `commands.spec.ts` | `m7-commands.spec.ts` | parity |
| `skills.spec.ts` | `m8-skills.spec.ts` | parity |
| `scripted-skill.spec.ts` | `m8-scripted-skill.spec.ts` | parity |
| `events.spec.ts` (lifecycle + wire) | `m11-event-stream.spec.ts` (wire only) | **gap — lifecycle missing** |
| `model-persists.spec.ts` | (none) | **gap** — add WS spec |
| `cross-provider.spec.ts` | `m12-cross-provider.spec.ts` | parity |
| `extensions.spec.ts` | `m9-extensions.spec.ts` | parity |
| `tool-failure.spec.ts` | `m12-tool-failure.spec.ts` | parity |
| `tool-replay.spec.ts` | `m12-tool-replay.spec.ts` | parity |
| (none) | `m1-handshake.spec.ts`, `m6-spawn.spec.ts`, `m11-auto-resume.spec.ts` | WS-only, transport-specific — keep |

### C. Why ws-frontend e2e is slow today

`packages/bodhi-pi-ws-frontend/playwright.config.ts`:
- `workers: 1`, `fullyParallel: false` — serial.
- `webServer.reuseExistingServer: false` — Vite is rebuilt for each `bun e2e` invocation (acceptable across CI runs, painful locally).
- Per-test ws-server spawn (`spawnTestServer`) plus full Vite cold-boot is fine for isolation but pays the LLM-latency tax in series.

The **infra needed for concurrency already exists**:
- `e2e/helpers/spawn-server.ts` already does `--port 0` + tmpdir + cleanup → each test gets its own server with its own SQLite.
- `e2e/helpers/seed.ts` materializes scenarios into the spawned tmpdir → no shared workspace state.
- `bodhi-pi-ws-server` is multi-tenant by `userId` (auth subprotocol bearer is `base64url({id, email})`) — different specs already use different ids (e.g. `m11-auto-resume` uses `220` vs `221`). Cross-tenant access is blocked at the SQLite layer.
- Playwright gives each test a fresh browser context (own localStorage, own IndexedDB).

So we can flip to parallel workers safely; the only real ceiling is OpenAI/Anthropic rate limits. `gpt-4o-mini` has very high RPM on standard tier — 4 workers is comfortable.

---

## Plan

### 1. Establish the parity rule in CLAUDE.md (touches all four packages)

Update each CLAUDE.md to declare: every user-visible feature in `bodhi-pi` ships to `bodhi-pi-web` AND `bodhi-pi-ws-server` + `bodhi-pi-ws-frontend`; PRs that change one without the others must justify in the description.

- **`packages/bodhi-pi/CLAUDE.md`** — add a "Runtime hosts" section listing the three hosts and pointing to each host's CLAUDE.md. State the parity rule.
- **`packages/bodhi-pi-web/CLAUDE.md`** — add a "Parity counterpart" line pointing at `bodhi-pi-ws-frontend` + `bodhi-pi-ws-server`. Add a "Feature surface" bullet list (the inventory in Findings A) so future work has one source of truth.
- **`packages/bodhi-pi-ws-server/src/CLAUDE.md`** — replace the "ScriptExecutor not registered" line with current reality (verify first). Add the "Parity counterpart" line. Add a "Feature surface" list mirroring web.
- **`packages/bodhi-pi-ws-frontend/CLAUDE.md`** — *create* (does not exist today). Mirror the structure of `bodhi-pi-web/CLAUDE.md`: architecture, feature surface, testability affordances, e2e conventions, parity counterpart.

### 2. Close the lifecycle-events parity gap

The `BodhiPiEvent` stream is emitted by the agent in `ws-server`. To surface it in `ws-frontend`:

- **`bodhi-pi-ws-server`**: add a notification-only ACP method (e.g. `_bodhi-pi/lifecycle/event`) the agent calls on every `BodhiPiEvent`, OR piggyback on a session-update notification with `kind: "_bodhi-pi/lifecycle"`. Pick the second — it stays inside the existing `sessionUpdate` channel, no protocol surgery, and is naturally per-session/per-tenant.
  - Wire in `src/agent/wire-agent.ts` next to the existing notification fan-out.
- **`bodhi-pi-ws-frontend`**: extend `src/lib/transport.ts` to recognize the new kind and feed it into a new `eventStore` (parallel to the existing wire log). Replace the single-tab `EventStreamPanel` with a tabbed `EventsPanel` matching web's shape:
  - tabs: `lifecycle | wire`, attribute `data-active-tab`
  - rows: `[data-testid=event-row][data-event-source=lifecycle|wire][data-event-type=…][data-session-id=…][data-tool-name=…]…`
  - same FIFO cap (500) as web
  - keep the existing wire-tab behavior intact

### 3. Add chat-root `data-test-state` and align attribute names

- `ws-frontend/src/App.tsx` (or chat container) — add `data-testid="chat-page"` with `data-test-state=idle|streaming|closed|error|connecting|disconnected`.
- Rename `data-current-session-id` → `data-session-id` to match web; keep `data-current-model` (web also uses that name).
- Update `e2e/pages/AppPage.ts` to expose `expectChatState(state)` mirroring web's POM.

### 4. Add the missing `model-persists` WS spec

Port `packages/bodhi-pi-web/e2e/model-persists.spec.ts` to `packages/bodhi-pi-ws-frontend/e2e/m12-model-persists.spec.ts`: switch model, `/new`, verify default; `/resume <id>`, verify restored.

### 5. Add a lifecycle-events WS spec

Port the lifecycle assertions from `packages/bodhi-pi-web/e2e/events.spec.ts` to `m11-event-stream.spec.ts` (extend the existing file): assert at least `agent_start`, `before_provider_request`, `after_provider_response`, `tool_execution_start`, `tool_execution_end`, `turn_end` rows appear after a tool-using prompt.

### 6. Turn on parallel e2e in ws-frontend

`packages/bodhi-pi-ws-frontend/playwright.config.ts`:

```ts
fullyParallel: true,
workers: process.env.CI ? 2 : 4,
webServer: {
  command: "vite --port 35273 --strictPort",
  reuseExistingServer: !process.env.CI, // share Vite across workers locally
  timeout: 30_000,
},
```

- Vite is shared across workers (it has no per-test state — each test points at its own ws-server).
- Each test's ws-server is already isolated via `spawnTestServer({port: 0, dataDir: tmpdir, workspaceDir: tmpdir})`.
- Each test must already pass `email` + `id` distinct from siblings. **Audit existing specs** and have `fixtures.ts` derive a unique `(id, email)` per test from `testInfo.testId` / `testInfo.workerIndex` so future specs cannot collide by accident:
  - `id = 1_000_000 + hash32(testInfo.titlePath.join('/'))`
  - `email = `e2e-${id}@bodhi-pi.test``
  - expose via `app` fixture and have `setSettings()` default to it when caller omits.
- Confirm Playwright contexts isolate localStorage (default behavior — yes).

Apply the same `fullyParallel: true, workers: …` flip to `bodhi-pi-web`'s `playwright.config.ts` only if its workers can also be parallelized — but web's tests share a single Vite + single FSA seed bridge per page context, which is already isolated, so this should be a clean flip too. Treat the web flip as a stretch goal (out of scope of "ws-frontend slow"), call out as follow-up.

### 7. Verify and document the current `run_script` story on the server

Before editing `bodhi-pi-ws-server/src/CLAUDE.md`: run `grep -rn "ScriptExecutor\\|registerScriptExecutor\\|run_script" packages/bodhi-pi-ws-server/src` and the existing m8-scripted-skill spec; confirm what's actually registered and how the per-user workspace bounds it. Update CLAUDE.md to match reality. If it really is unregistered and the spec is somehow passing on a different code path, that's a real bug to log separately, not silently fix here.

---

## Critical files

- `packages/bodhi-pi/CLAUDE.md` — parity rule
- `packages/bodhi-pi-web/CLAUDE.md` — parity counterpart link, feature surface
- `packages/bodhi-pi-ws-server/src/CLAUDE.md` — fix script-executor line, parity link, feature surface
- `packages/bodhi-pi-ws-frontend/CLAUDE.md` — **new file**
- `packages/bodhi-pi-ws-server/src/agent/wire-agent.ts` — emit lifecycle events as `sessionUpdate` notifications
- `packages/bodhi-pi-ws-frontend/src/lib/transport.ts` — split lifecycle vs wire streams
- `packages/bodhi-pi-ws-frontend/src/ui/EventsPanel.tsx` — tabbed panel (rename + restructure existing `EventStreamPanel`)
- `packages/bodhi-pi-ws-frontend/src/App.tsx` — `data-testid=chat-page` with `data-test-state`
- `packages/bodhi-pi-ws-frontend/e2e/fixtures.ts` — per-test `(id, email)` derivation, expose on `app`
- `packages/bodhi-pi-ws-frontend/e2e/pages/AppPage.ts` — `expectChatState`, `expectLifecycleRow`
- `packages/bodhi-pi-ws-frontend/playwright.config.ts` — `fullyParallel: true`, workers, `reuseExistingServer`
- `packages/bodhi-pi-ws-frontend/e2e/m12-model-persists.spec.ts` — **new spec**
- `packages/bodhi-pi-ws-frontend/e2e/m11-event-stream.spec.ts` — extend with lifecycle assertions

## Reusable utilities (do not duplicate)

- `packages/bodhi-pi-ws-server/src/auth/token.ts` → `encodeToken`, `decodeToken`
- `packages/bodhi-pi-ws-server/src/sessions/sqlite-session-store.ts` → `createSqliteSessionStore({db, userId})`
- `packages/bodhi-pi-ws-frontend/e2e/helpers/spawn-server.ts` → `spawnTestServer` (already does port 0 + tmpdir + cleanup)
- `packages/bodhi-pi-ws-frontend/e2e/helpers/seed.ts` → `loadScenario`, `writeFiles`
- `packages/bodhi-pi-web/e2e/pages/EventsPanel.ts` → use as the structural template when building ws-frontend's POM extension

## Verification

The repo is npm + node (root `package-lock.json`, `engines.node >= 20`, `justfile` uses `npm --workspace …`). All commands below match.

1. **Type/build clean.** `npm --workspace @bodhiapp/bodhi-pi-ws-server run build && npm --workspace @bodhiapp/bodhi-pi-ws-frontend run build` succeed.
2. **Server unit tests still green.** `npm --workspace @bodhiapp/bodhi-pi-ws-server run test` (vitest).
3. **WS-frontend e2e passes serially first.** Run `npm --workspace @bodhiapp/bodhi-pi-ws-frontend run test:e2e -- --workers=1` to confirm the new lifecycle wiring + new spec + renamed attributes work before flipping concurrency on.
4. **WS-frontend e2e passes in parallel.** `npm --workspace @bodhiapp/bodhi-pi-ws-frontend run test:e2e` (config now `workers: 4`, `fullyParallel: true`). Wall time should drop ~3–4× vs serial. No flakes across 3 consecutive runs.
5. **Lifecycle parity spot-check.** Manually run web's `events.spec.ts` (`npm --workspace @bodhiapp/bodhi-pi-web run test:e2e -- events.spec.ts`) and ws-frontend's extended `m11-event-stream.spec.ts` and diff the asserted event-type sets — should be the same set.
6. **Full repo gate.** `just test` from the monorepo root walks every package in dep order — run after the changes settle.
7. **CLAUDE.md round-trip.** A new fictional feature (e.g. "add `/whoami`") would be visible from each CLAUDE.md to know it must land in all three hosts.
