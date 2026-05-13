# Port the WebSocket runtime into `bodhi-pi/e2e/` — fourth vitest project

## Context

`packages/bodhi-pi/e2e` runs the shared e2e suite (`e2e/shared/**/*.e2e.ts`) under three Vitest projects today: `|in-memory|`, `|cli|`, `|http|`. A WebSocket-based ACP transport already exists as two standalone packages (`packages/bodhi-pi-ws-server`, `packages/bodhi-pi-ws-frontend`) with its own Playwright e2e — but it does **not** participate in the shared suite, so cross-runtime regressions on the WS transport are invisible until someone runs the standalone package tests.

The events + extensions e2e work landed every cross-runtime behavior (lifecycle events, fixture loading) behind a transport-agnostic harness. The remaining step is to add a fourth `|ws|` project so the same `e2e/shared/**/*.e2e.ts` files exercise WebSocket-over-ACP uniformly. Once done, `npm run test:e2e` (and therefore `just test` line 48) reports four project labels and one runtime's worth of additional test invocations, and a single PR catches regressions across all four transports.

**Strong recommendation honored**: extend `packages/bodhi-pi/e2e/test-app-http/` to expose a `/acp-ws` endpoint and a `/ws/` frontend route, rather than creating a parallel `test-app-ws/` workspace. Verified feasible:
- `src/server/server.ts` uses raw `createServer()` → `server.on('upgrade', …)` grafts on cleanly.
- `src/server/agent/wire-agent.ts` factory shape (`(conn) => Agent`) matches ws-server's per-connection signature; only the agent lifetime differs.
- `src/server/auth/token.ts` codec (`base64url(JSON({id,email}))`) is byte-identical to ws-server's — one token shape across `/acp` and `/acp-ws`.
- `jiti` is already a test-app-http dep; no new tooling for extensions.
- Frontend is a flat single-page React app (no router today) → adding `react-router-dom` introduces routing in one place, no migration cost.

**Headless ACP only.** No Playwright in this PR. The `/ws/` frontend exists for manual claude-in-chrome smoke; the deferred Playwright work will decide later whether to colocate or create a runner workspace.

## Decisions locked with the user

- **Frontend in scope** (full port + claude-in-chrome smoke).
- **Routing**: introduce `react-router-dom` to test-app-http. `<BrowserRouter>` + `<Routes>`: `/` → existing HTTP app, `/ws/*` → new WS app. Vite needs SPA-fallback config (`historyApiFallback`).
- **Separate spawn for ws-only** in `e2e/global-setup.ts`. One binary (test-app-http), two spawned instances: the existing HTTP spawn (exports `BODHI_PI_E2E_HTTP_BASE_URL`, `BODHI_PI_E2E_HTTP_DATA_DIR` — unchanged) and a new WS spawn on its own port + dataDir (exports `BODHI_PI_E2E_WS_BASE_URL`, `BODHI_PI_E2E_WS_DATA_DIR`). Clean per-project isolation; no cross-tenant SQLite contention.

## Semantics to port from `bodhi-pi-ws-server`

- **Stateful-per-connection agent lifecycle.** One AcpAgent per WS upgrade, alive for the connection. WS `close` → agent evicted + any in-flight prompt cancelled. Reconnect = fresh agent rehydrated from SQLite. *This is the whole reason `|ws|` is a fourth project, not a flavor of `|http|`.*
- **Auth at upgrade only.** `Sec-WebSocket-Protocol: bodhi-pi.v1, bearer.<base64url-JSON({id,email})>`. No per-message re-validation. Token codec identical to test-app-http's existing one — reuse `src/server/auth/token.ts`.
- **Per-user SQLite + workspace.** `<dataDir>/users/<userId>/workspace/` and shared `sessions.db` scoped by `userId` — exactly as test-app-http already does for HTTP. No new code, just routed through both transports.
- **Frame format**: NDJSON JSON-RPC over text frames via the ACP SDK's `ndJsonStream`. A thin adapter wraps the `ws` socket into Web `ReadableStream`/`WritableStream`. Mirror `packages/bodhi-pi-ws-server/src/transport/ws-stream.ts`.
- **Lifecycle events**: fire-and-forget `conn.extNotification("_bodhi-pi/lifecycle/event", record)` per agent event — same shape and frame as the HTTP+SSE path so `harness.events` populates identically.
- **Heartbeat**: WS protocol ping every 30s, drop on no-pong.
- **Models / API keys** flow through the existing `WireAgentOptions { models, defaultModelId, getApiKey }` injected at `buildServer` time — no duplication.

## Phases

Depth-first, one commit per phase. Each phase ends with a green gate before the next begins. Pattern lifted from the events + extensions work (see `git log --grep "bodhi-pi e2e events"` and `git log --grep "bodhi-pi e2e extensions"`).

### Phase 1 — Server-side `/acp-ws` endpoint

Touch `packages/bodhi-pi/e2e/test-app-http/`:

- `package.json` — add `"ws": "^8.18.0"` + `"@types/ws"` devDep.
- `src/server/transport/ws-stream.ts` — port `wsToStream(ws): { readable, writable }` from `packages/bodhi-pi-ws-server/src/transport/ws-stream.ts`.
- `src/server/auth/upgrade.ts` — port subprotocol parsing + `authenticateUpgrade(req)` + `handleAgentUpgrade(wss, req, socket, head, onConnection)` from ws-server. Reuse the existing `auth/token.ts` decoder.
- `src/server/agent/wire-agent-ws.ts` — sibling to existing `wire-agent.ts`. Returns `(conn: AgentSideConnection) => Agent` per WS connection. Lifecycle-event handlers close over the per-WS `conn`, fire `extNotification("_bodhi-pi/lifecycle/event", record)`.
- `src/server/server.ts` — instantiate `WebSocketServer({ noServer: true })`; `httpServer.on('upgrade', …)` routes `/acp-ws` upgrades through `handleAgentUpgrade`; per-connection setup creates a fresh agent via `wireAgentForConnection(opts)` bound to `(userId, workspace)`, wires `ndJsonStream(wsToStream(socket))` into `AgentSideConnection`, registers heartbeat + close cleanup (cancel in-flight prompts, dispose agent).
- Smoke script `e2e/smoke/ws-smoke.ts` — hand-rolled Node WS client. Mint a test token, open WS to `/acp-ws`, send `initialize` + `newSession` + `session/prompt`, assert one `agent_start`/`agent_end` notification pair lands. Run with `tsx`.

**Gate**: `tsx e2e/smoke/ws-smoke.ts` exchanges frames and exits 0. `cd packages/bodhi-pi/e2e/test-app-http && npm run build` clean. Commit: `bodhi-pi e2e ws phase 1: /acp-ws endpoint on test-app-http`.

### Phase 2 — Node WS client + harness branch + fourth vitest project

Touch `packages/bodhi-pi/e2e/`:

- `helpers/ws-connection.ts` — Node-side `BodhiPiAcpConnection` impl mirroring `helpers/http-connection.ts`. Use the `ws` npm package (Node-native `WebSocket` lacks the `headers`/`protocols` constructor option for the subprotocol bearer). Implements all 10 methods from `packages/bodhi-pi/src/client/types.ts:20-31`. Wires `onUpdate` for `session/update` notifications and `onLifecycleEvent` for `_bodhi-pi/lifecycle/event` notifications — same callback shape as `http-connection.ts:285-286`.
- `helpers/runtime.ts` — extend the `BodhiPiRuntime` type and `getRuntime()` to recognize `"ws"`.
- `setup/ws.ts` — one-liner: `import { setRuntime } from "../helpers/runtime.js"; setRuntime("ws");`.
- `vitest.e2e.config.ts` — fourth project block: `{ name: "ws", setupFiles: ["./e2e/setup/ws.ts"], include: ["e2e/shared/**/*.e2e.ts"] }` — identical glob to in-memory + http.
- `global-setup.ts` — add second spawn of `test-app-http` on its own port (port: 0 → ephemeral) + own tmpDir; `waitForListening` reused; export `BODHI_PI_E2E_WS_BASE_URL` and `BODHI_PI_E2E_WS_DATA_DIR`. Teardown kills both processes + cleans both tmpDirs.
- `helpers/harness.ts` — add `ws` branch parallel to the http branch (`harness.ts:251-311`): mints fresh `userId` per test, encodes bearer token, constructs `WsAcpConnection({ baseUrl: process.env.BODHI_PI_E2E_WS_BASE_URL!, token, onUpdate, onLifecycleEvent })`, returns the standard `E2EHarness` shape. Reuses the existing fixture-symlink path (`harness.ts:276-278`) into the per-user workspace under `BODHI_PI_E2E_WS_DATA_DIR`.
- `e2e/CLAUDE.md` — append one sentence noting the fourth runtime + its env vars.

**Shared-suite integration (the load-bearing step)**: by including `e2e/shared/**/*.e2e.ts` in the fourth project's `include`, every test under `e2e/shared/` runs an additional time tagged `|ws|`. No new `runIf` skips expected — the events + extensions work removed all runtime gates. Audit during this phase: if any test legitimately needs a `ws`-specific skip, add `test.runIf(!isRuntime("ws"))` with a one-line comment explaining the limitation.

**Gate**:
- `cd packages/bodhi-pi && npm run test:e2e -- --project ws` green.
- `cd packages/bodhi-pi && npm run test:e2e` green across all four projects.
- Commit: `bodhi-pi e2e ws phase 2: harness branch + fourth vitest project against e2e/shared`.

### Phase 3 — Frontend port (`/ws/` route in test-app-http)

Touch `packages/bodhi-pi/e2e/test-app-http/`:

- `package.json` — add `"react-router-dom": "^7"`.
- `src/frontend/main.tsx` — wrap `<App />` in `<BrowserRouter>`.
- `src/frontend/App.tsx` — `<Routes>` with `/` → existing `HttpApp` (the current chat component, extracted), `/ws/*` → new `WsApp`.
- `src/frontend/lib/ws/transport.ts` — port from `packages/bodhi-pi-ws-frontend/src/lib/transport.ts`. Browser-native `WebSocket` + subprotocols `[bodhi-pi.v1, bearer.<encoded>]`.
- `src/frontend/lib/ws/ws-stream.ts` — port the browser-side WS↔Web-Streams adapter.
- `src/frontend/lib/ws/auth.ts` — port browser token codec (`btoa`-based, base64url shim).
- `src/frontend/pages/WsApp.tsx` — minimal chat shell composing existing `Chat`, `Settings`, `EventsPanel`, `StatusBar` components through a transport abstraction (`Connection` interface satisfied by both `acp-http-client.ts` and the new ws transport). Reuse `useChat`, `useEventLog`, `useLifecycleLog`, `useSettings` hooks unchanged — they're transport-agnostic given a `BodhiPiAcpConnection`.
- `vite.config.ts` (or equivalent) — add SPA fallback so `/ws/` deep-links resolve to `index.html`.

**Manual smoke via claude-in-chrome**:
1. `cd packages/bodhi-pi/e2e/test-app-http && npm run dev` — one Node process boots server + Vite.
2. Visit `http://localhost:<vite-port>/` — verify HTTP+SSE chat sends a prompt and streams a response. Inspect EventsPanel.
3. Visit `http://localhost:<vite-port>/ws/` — verify WS chat connects, sends a prompt, streams a response, and EventsPanel populates with lifecycle + wire frames.
4. Capture a screenshot of each route showing a completed turn (record findings under `ai-docs/reviews/` or attach to the PR description).

**Gate**: both routes functional in claude-in-chrome; `npm run build` (server + frontend) clean. Commit: `bodhi-pi e2e ws phase 3: /ws/ frontend route in test-app-http`.

### Phase 4 — Justfile cleanup + full `just test` regression gate

Touch `justfile`:

- **Drop line 69** (`bodhi-pi-ws-frontend — test:e2e (playwright)`) — its semantic coverage is now subsumed by `bodhi-pi` `test:e2e` line 48 (Playwright surface stays deferred).
- **Keep lines 65–66** (`bodhi-pi-ws-server` build + unit test) and **line 68** (`bodhi-pi-ws-frontend` build) for now — they're unit-level, not e2e; removal is a follow-up tracked alongside the workspace deletion.

Confirm: `just test` line 48 (`npm --workspace @bodhiapp/bodhi-pi run test:e2e`) already runs the consolidated four-project Vitest report. No new justfile entry needed for `|ws|`; it rides on the existing line by virtue of being a vitest project.

**Gate**:
- `just test` end-to-end green.
- Any failures: triage genuine vs flaky. **Rerun any failing step once** before concluding it's broken (events + extensions phasing established this pattern — see commits `45017b01`, `acb98b34`). If still failing after rerun, fix or revert.
- Commit: `bodhi-pi e2e ws phase 4: drop ws-frontend playwright e2e from justfile; full regression gate`.

## Critical files to modify

Server (Phase 1):
- `packages/bodhi-pi/e2e/test-app-http/package.json` (deps)
- `packages/bodhi-pi/e2e/test-app-http/src/server/server.ts` (upgrade routing)
- `packages/bodhi-pi/e2e/test-app-http/src/server/transport/ws-stream.ts` (new)
- `packages/bodhi-pi/e2e/test-app-http/src/server/auth/upgrade.ts` (new)
- `packages/bodhi-pi/e2e/test-app-http/src/server/agent/wire-agent-ws.ts` (new)

Harness (Phase 2):
- `packages/bodhi-pi/e2e/helpers/ws-connection.ts` (new)
- `packages/bodhi-pi/e2e/helpers/harness.ts` (ws branch)
- `packages/bodhi-pi/e2e/helpers/runtime.ts` (extend type)
- `packages/bodhi-pi/e2e/setup/ws.ts` (new)
- `packages/bodhi-pi/e2e/vitest.e2e.config.ts` (fourth project)
- `packages/bodhi-pi/e2e/global-setup.ts` (second spawn)
- `packages/bodhi-pi/e2e/CLAUDE.md` (one-sentence note)

Frontend (Phase 3):
- `packages/bodhi-pi/e2e/test-app-http/package.json` (`react-router-dom`)
- `packages/bodhi-pi/e2e/test-app-http/src/frontend/main.tsx` (BrowserRouter)
- `packages/bodhi-pi/e2e/test-app-http/src/frontend/App.tsx` (Routes)
- `packages/bodhi-pi/e2e/test-app-http/src/frontend/pages/WsApp.tsx` (new)
- `packages/bodhi-pi/e2e/test-app-http/src/frontend/lib/ws/{transport,ws-stream,auth}.ts` (new — ports)
- `packages/bodhi-pi/e2e/test-app-http/vite.config.ts` (SPA fallback if missing)

Cleanup (Phase 4):
- `justfile` (drop line 69)

## Existing utilities to reuse (do not re-implement)

- `packages/bodhi-pi/e2e/test-app-http/src/server/auth/token.ts` — `encodeToken` / `decodeToken` (byte-identical to ws-server's). Used by both `/acp` and `/acp-ws`.
- `packages/bodhi-pi/e2e/test-app-http/src/server/filesystem/user-workspace.ts` — `resolveUserWorkspace`. Both transports share.
- `packages/bodhi-pi/e2e/test-app-http/src/server/sessions/sqlite-session-store.ts` — same DB, same userId scoping.
- `packages/bodhi-pi/e2e/helpers/events-assert.ts` — `flushEvents`/`waitForAgentEndBalance` already used by all three runtimes; ws plugs in unchanged.
- `packages/bodhi-pi/e2e/helpers/seed-bodhi-pi.ts` + `helpers/extension-loaders/` — fixture loaders. Ws follows http's symlink-into-workspace strategy (`harness.ts:276-278`).
- `packages/bodhi-pi/e2e/helpers/http-connection.ts` — template for `ws-connection.ts`; same method surface.

## Inline-not-import constraint

`packages/bodhi-pi/e2e` must NOT import from `@bodhiapp/bodhi-pi-ws-server` or `@bodhiapp/bodhi-pi-ws-frontend` (same rule the http port followed). Files are ported — copy-paste-adapted — into `e2e/test-app-http/` and `e2e/helpers/`. The standalone packages stay on disk as legacy; removal is a separate follow-up.

## Verification end-to-end

1. **Per-phase gate** as listed above.
2. **Phase 2 anchor**:
   - `cd packages/bodhi-pi && npm run test:e2e -- --project ws` — green.
   - `cd packages/bodhi-pi && npm run test:e2e` — reports four project labels (`|in-memory|`, `|cli|`, `|http|`, `|ws|`); total test count = previous baseline + (count of `e2e/shared/**` × 1).
3. **Phase 3 manual smoke** via claude-in-chrome at both `/` and `/ws/` of `npm run dev`.
4. **Phase 4 final**:
   - `just test` from repo root — green. Allowed: one rerun of a failing step to discriminate flaky from broken (precedent: events + extensions phasing).
   - Confirm `just test` line 48 covered the ws project in its output (look for `|ws|` in the vitest summary).

## End state

- `cd packages/bodhi-pi && npm run test:e2e` shows four project labels; `e2e/shared/**` runs under all four uniformly.
- `cd packages/bodhi-pi/e2e/test-app-http && npm run dev` boots one Node process + Vite; `/` shows HTTP+SSE chat, `/ws/` shows WS-backed chat — both manually smoked via claude-in-chrome.
- `just test` green; no regressions in other workspaces.
- `packages/bodhi-pi-ws-server/` + `packages/bodhi-pi-ws-frontend/` remain on disk (legacy); their justfile playwright e2e entry is dropped, build/unit-test entries remain pending a follow-up.
- No new Playwright work; `e2e/ws-playwright/` is NOT created.
