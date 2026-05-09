# bodhi-pi WS-server PoC: hosted multi-user agent over WebSocket

## Context

`@bodhiapp/bodhi-pi` is a port of `coding-agent` to ACP, with strict agent-client separation. We have proven it through two reference hosts: `bodhi-pi-cli` (Node CLI, embedded agent) and `bodhi-pi-web` (browser, agent in a Web Worker). Both prove the agent works against a real LLM through ACP — but both are single-process, single-tenant.

Next we want to validate bodhi-pi as a **versatile agent framework** by lighting up the hosted-backend topology: agent runs on a server, multiple users connect from browsers, each user has multiple sessions, sessions persist to a database, server holds a session in memory while the WS is open and drops it on disconnect. We are running two separate PoCs to compare transports — **WebSocket** (this plan) and Streamable HTTP (a later plan). Streamable HTTP is out of scope here.

Goal of this plan: produce a working WebSocket PoC end-to-end (server boots, browser connects with auth, runs prompts, sees streaming, sees history on reconnect, two users isolated), built **evolutionarily and test-driven** in 5 commit-shippable milestones following the same spec-driven shape as `web-m1-to-m5.md` and `m4-3-review-downstream.md`.

## Scope decisions (locked)

| # | Decision | Notes |
|---|---|---|
| 1 | **Single package: `packages/bodhi-pi-ws-server`** | Defer the bodhi-pi-server lib split until extraction reveals itself. One Node app contains transport, persistence, auth, agent wiring. |
| 2 | **Frontend: `packages/bodhi-pi-ws-frontend`** | Already bootstrapped (clean Vite+React 19+TS scaffold). Build minimally per milestone — do not bulk-port from `bodhi-pi-web`. |
| 3 | **Auth = subprotocol bearer at upgrade-time** | Browser sends `new WebSocket(url, ['bodhi-pi.v1', 'bearer.<base64url-json>'])`. Server reads `Sec-WebSocket-Protocol` on upgrade, decodes payload `{id, email}`, attaches to connection ctx, echoes `bodhi-pi.v1` back. ACP `authenticate` stays a no-op (auth happens at transport layer). |
| 4 | **Token format = `base64url(JSON({id, email}))`**, plain payload. No `header.payload.signature` shape, no signature. Future swap to real JWT is a constant-time replacement of the decode helper. |
| 5 | **Connection model = WS per browser tab → its own AcpAgent → its own sessions Map** | No server-wide hot cache. Drop everything on `ws.close`. In-flight prompts are cancelled. Reconnect = fresh agent + re-hydrate from SQLite. |
| 6 | **In-flight prompt collision: out of scope** | Frontend disables send while a prompt streams. Server does not enforce. (Future: pi-agent message-queue / branching makes this concrete.) |
| 7 | **DB = single SQLite file with `user_id` column** | `./.bodhi-pi-server/sessions.db`. Drizzle schema, migrations on boot. SessionStore factory takes `userId` and scopes every read/write. |
| 8 | **Per-user shared workspace** | `./.bodhi-pi-server/users/<userId>/workspace/`. All of a user's sessions share their workspace (analogous to running multiple `claude code` invocations in the same dir). Selecting a workspace per session is future work. |
| 9 | **Heartbeat = WebSocket protocol ping every 30s, drop on no-pong** | Built-in ws library behavior; no client code. Handles laptop-sleep + NAT idle cleanly. |
| 10 | **`ScriptExecutor` not registered** | The `run_script` tool does not exist on the server. Multi-tenant child_process is unsafe without sandboxing. Future work. |
| 11 | **Server framework = `node:http` + `ws`** | Same stack as BodhiSearch `ws-acp-client`. Mount HTTP routes alongside (`/healthz`). Full control over upgrade handler. |
| 12 | **Test gates = unit + integration(faux LLM) + e2e(real LLM)** per milestone. CI runs unit+integration; e2e gated by `.env` keys. Same harness pattern as `bodhi-pi-cli/test/helpers/`. |
| 13 | **Multi-user e2e via UI Settings** | Frontend ships a Settings panel (email, numeric id, "send token" checkbox). Playwright drives two browser contexts, each fills different values, no `page.evaluate` injection. Black-box pattern; matches the only existing whitebox carve-out (FSA seed) in `bodhi-pi-web`. |

## Out of scope

- Streamable HTTP transport (separate PoC)
- Real JWT signing / OAuth integration / Bodhi App auth
- Per-session workspace, volume mounts, workspace selection UI
- Server-wide hot session cache, eviction TTLs, multi-server clustering, sticky-session routing
- In-flight prompt queueing or branching
- ScriptExecutor sandboxing
- Frontend feature parity with `bodhi-pi-web` (skills UI, command palette, tool-call rendering polish, etc.)

## Package layout

```
packages/
  bodhi-pi-ws-server/              # NEW — Node app
    src/
      index.ts                     # main(): readEnv → buildServer → listen
      auth/
        token.ts                   # encodeToken / decodeToken (base64url JSON)
        upgrade.ts                 # handleUpgrade(req, socket, head)
      transport/
        ws-stream.ts               # WebSocket ↔ WHATWG Stream adapter (Stream for ndJsonStream)
      sessions/
        schema.ts                  # Drizzle: users, sessions, entries (with user_id)
        migrate.ts                 # migrate-on-boot
        sqlite-session-store.ts    # MultiTenantSessionStore (factory takes userId)
      filesystem/
        user-workspace.ts          # per-user NodeFilesystem rooted at <data>/users/<id>/workspace
      agent/
        wire-agent.ts              # createBodhiPiAgent wiring per WS connection
      server.ts                    # buildServer({ port, dataDir, models }) → http.Server
    test/                          # vitest unit + integration
    e2e/                           # vitest real-LLM e2e (no browser; multi-WS-client)
    drizzle/                       # generated migrations
    package.json
    tsconfig.json
    vitest.config.ts
    drizzle.config.ts
    .env.example
    README.md
    CLAUDE.md

  bodhi-pi-ws-frontend/            # already bootstrapped
    src/
      main.tsx                     # existing
      App.tsx                      # rewritten per milestone
      transport/
        ws-transport.ts            # WS client w/ subprotocol bearer + ndJsonStream split
      stores/
        chatStore.ts
        settingsStore.ts           # email, id, sendToken (persisted to localStorage)
      ui/
        Settings.tsx
        Chat.tsx
        SessionList.tsx            # M5
        Composer.tsx
        StatusBar.tsx
    e2e/
      fixtures.ts
      pages/ChatPage.ts
      *.spec.ts
    playwright.config.ts
    package.json
```

## Architecture: connection lifecycle

```
1. Browser opens tab → user fills Settings (email, id, sendToken=true) → clicks Connect (or first send).
2. Frontend calls new WebSocket('ws://host:8788/agent', ['bodhi-pi.v1', `bearer.${base64url(JSON.stringify({id, email}))}`]).
3. Server upgrade handler:
   - parses Sec-WebSocket-Protocol, finds 'bearer.*' element
   - decodes → { id, email }; rejects on malformed (HTTP 401 close)
   - upserts into users table (id, email, last_seen_at)
   - accepts upgrade, echoes 'bodhi-pi.v1' subprotocol
   - attaches ctx = { user, sessionStore: storeFor(user.id), filesystem: fsFor(user.id), models } to ws
   - wraps ws in ws-stream.ts adapter → ACP ndJsonStream → AgentSideConnection
   - calls createBodhiPiAgent(config) → AcpAgent
4. ACP frames flow:
   - client: initialize → server: { protocolVersion: 1, authMethods: [], agent: {...}, _meta: {...} }
   - client: session/new (or session/load with sessionId)
     - session/new: store.create(userId) → in-memory SessionState built fresh
     - session/load: store.load(userId, sessionId) → re-hydrate piAgent, replay history via sessionUpdate notifications
   - client: session/prompt → streams sessionUpdate notifications → response on completion
5. ws.close (tab closed, network lost, no-pong):
   - any in-flight piAgent.cancel() awaited
   - sessions Map dropped
   - DB rows untouched (entries already persisted)
6. Reconnect = step 1 again; client passes last sessionId via session/load.
```

## Wire format

NDJSON JSON-RPC 2.0 over WebSocket text frames. The bodhi-pi SDK's `ndJsonStream` already handles framing on both sides. Our only adapter is `transport/ws-stream.ts` which exposes a WS as a `{ readable: ReadableStream<Uint8Array>, writable: WritableStream<Uint8Array> }`. Pattern lifted from `BodhiSearch/pi-mono/packages/ws-acp-client/src/transport/ws-transport.ts`.

Server pings every 30s via `ws.ping()`; ws library auto-replies pong client-side. If no pong arrives within 30s of a ping, server calls `ws.terminate()`.

## Critical files referenced

| Path | Why |
|---|---|
| `packages/bodhi-pi/src/index.ts` | `createBodhiPiAgent`, `BodhiPiConfig`, `SessionStore`, `Filesystem`, `AgentSideConnection`, `ndJsonStream` |
| `packages/bodhi-pi/src/acp/agent.ts:132` | `BodhiPiAcpAgent` — sessions Map, ACP method handlers |
| `packages/bodhi-pi/src/sessions/session-store.ts:71` | `SessionStore` interface to implement |
| `packages/bodhi-pi-node/src/sessions/sqlite-session-store.ts` | reference Drizzle SqliteSessionStore (single-tenant) |
| `packages/bodhi-pi-node/src/sessions/schema.ts` | reference Drizzle schema (sessions, entries) |
| `packages/bodhi-pi-node/src/sessions/migrate.ts` | reference migrate-on-boot |
| `packages/bodhi-pi-node/src/filesystem/node-filesystem.ts` | reference NodeFilesystem (cwd-rooted; reusable as-is, just construct with per-user cwd) |
| `packages/bodhi-pi-cli/test/helpers/in-process-connection.ts` | pattern for integration tests: pair AgentSideConnection ↔ ClientSideConnection in-process |
| `packages/bodhi-pi-cli/test/helpers/faux-script.ts` | faux LLM harness for deterministic integration tests |
| `packages/bodhi-pi-web/e2e/pages/ChatPage.ts` | POM template to mirror in ws-frontend e2e |
| `packages/bodhi-pi-web/e2e/fixtures.ts` | Playwright fixture pattern (config injection without page.evaluate) |
| `BodhiSearch/pi-mono/packages/ws-acp-client/src/transport/ws-transport.ts` | reference WS↔Stream adapter to lift |
| `BodhiSearch/pi-mono/packages/ws-acp-client/src/server.ts` | reference upgrade handler shape (note: their auth is via ACP authenticate, ours is at upgrade — diverge here) |

---

## M1 — Walking skeleton + auth

**Scope.** Server boots on a configured port, accepts WS upgrade with subprotocol bearer auth, decodes the token, replies to ACP `initialize` with empty `authMethods`, pings every 30s. No bodhi-pi factory yet, no sessions, no DB. Frontend: Settings panel (email, id, sendToken checkbox) persisted to localStorage; Connect button; status pill (connecting / connected / disconnected / unauthorized). No chat surface yet.

**Files.**

| Path | Change |
|---|---|
| `packages/bodhi-pi-ws-server/package.json` | NEW — deps: `ws`, `@bodhiapp/bodhi-pi`, `tsx`, `typescript`, `vitest` |
| `packages/bodhi-pi-ws-server/src/auth/token.ts` | NEW — `encodeToken({id,email})`, `decodeToken(s): {id,email}` (base64url, JSON.parse, validate types, throw on bad) |
| `packages/bodhi-pi-ws-server/src/auth/upgrade.ts` | NEW — `handleUpgrade(req, socket, head, wss, onConnection)` parses subprotocol, decodes, calls `wss.handleUpgrade` with `'bodhi-pi.v1'` accepted, passes ctx to onConnection |
| `packages/bodhi-pi-ws-server/src/transport/ws-stream.ts` | NEW — `wsToStream(ws): { readable, writable }` |
| `packages/bodhi-pi-ws-server/src/server.ts` | NEW — `buildServer({ port })` returns `{ httpServer, close }`. Mounts `/healthz`. Registers WS at `/agent`. On ws connection: wraps stream → AgentSideConnection → minimal `AcpAgent` stub that only handles `initialize` + ignores rest with method-not-found. Starts 30s ping interval. |
| `packages/bodhi-pi-ws-server/src/index.ts` | NEW — entry: read env (PORT default 8788), `buildServer().listen(port)` |
| `packages/bodhi-pi-ws-server/.env.example` | NEW — PORT=8788 |
| `packages/bodhi-pi-ws-server/CLAUDE.md` | NEW — same shape as bodhi-pi-cli/CLAUDE.md |
| `packages/bodhi-pi-ws-frontend/src/stores/settingsStore.ts` | NEW — Zustand-ish store, persisted to localStorage, `{ email, id, sendToken }` |
| `packages/bodhi-pi-ws-frontend/src/transport/ws-transport.ts` | NEW — `connect({ url, token? })` returns a Stream-shaped pair via `ndJsonStream` (client side); auto-reconnect off for now (manual Connect button) |
| `packages/bodhi-pi-ws-frontend/src/ui/Settings.tsx` | NEW — three fields + Save button. `data-testid="settings-{email,id,sendToken,save}"` |
| `packages/bodhi-pi-ws-frontend/src/ui/StatusBar.tsx` | NEW — `data-testid="status"` `data-status="connecting|connected|disconnected|unauthorized"` |
| `packages/bodhi-pi-ws-frontend/src/App.tsx` | rewrite — Settings + Connect button + StatusBar; on Connect → ws-transport.connect → ACP `initialize` → renders agent name from response |
| `packages/bodhi-pi-ws-frontend/playwright.config.ts` | NEW — `webServer` runs both `npm run dev:server` (in ws-server) + `npm run dev` (frontend); `workers: 1, fullyParallel: false` |
| `packages/bodhi-pi-ws-frontend/e2e/fixtures.ts` | NEW — fixture starts server, exposes `app: AppPage` |
| `packages/bodhi-pi-ws-frontend/e2e/pages/AppPage.ts` | NEW — `setSettings`, `connect`, `expectStatus`, `expectAgentName` |

**Implementation notes.**
- `decodeToken`: convert base64url → utf8 → JSON.parse; assert `typeof id === 'number'`, `typeof email === 'string'`. Anything else throws → 401 close.
- `handleUpgrade` rejects (writes `HTTP/1.1 401\r\n\r\n` then `socket.destroy()`) when (a) no subprotocol header, (b) no `bearer.` element, (c) decode throws.
- Server-side `AcpAgent` stub: `initialize → { protocolVersion: 1, agentInfo: {name:'bodhi-pi-ws', version:'0.1.0'}, authMethods: [], capabilities: {} }`. Other methods throw `MethodNotFound`.

**TDD / gate-check tests.**
- Unit (`packages/bodhi-pi-ws-server/test/auth/token.test.ts`): roundtrip encode/decode; rejects malformed base64; rejects wrong types.
- Integration (`packages/bodhi-pi-ws-server/test/server-handshake.test.ts`): start server on random port; open `ws` client with valid subprotocol → expect ACP `initialize` reply + `bodhi-pi.v1` accepted. Negative: missing subprotocol → 401. Bad token → 401. Heartbeat: client refuses to pong → server `terminate` within ~60s.
- E2E (`packages/bodhi-pi-ws-frontend/e2e/m1-handshake.spec.ts`): Playwright fills Settings (email, id, sendToken=true), clicks Save, clicks Connect → `data-status="connected"` appears, agent name renders. Repeat with sendToken=false → `data-status="unauthorized"`.

```bash
npm run test -w bodhi-pi-ws-server
npm run test:e2e -w bodhi-pi-ws-frontend -- m1-handshake
```

**Commit:** `feat(bodhi-pi-ws-server): M1 walking skeleton with subprotocol bearer auth`

---

## M2 — Single-prompt round-trip with in-memory store

**Scope.** Wire `createBodhiPiAgent` per WS connection with `createInMemorySessionStore()` and a per-user `NodeFilesystem` (rooted at the per-user workspace dir, but no DB yet). Frontend: chat surface — composer, message list, send button, streaming text rendering. One real-LLM e2e proves end-to-end with `gpt-4o-mini`.

**Files.**

| Path | Change |
|---|---|
| `packages/bodhi-pi-ws-server/src/agent/wire-agent.ts` | NEW — `wireAgentForConnection({ ctx, conn })` reads models from env, builds `BodhiPiConfig` with in-memory sessionStore + per-user NodeFilesystem (mkdir -p), no scriptExecutor, returns `AcpAgent` |
| `packages/bodhi-pi-ws-server/src/filesystem/user-workspace.ts` | NEW — `userWorkspace(dataDir, userId): { cwd, fs: Filesystem }`, ensures dir |
| `packages/bodhi-pi-ws-server/src/server.ts` | swap stub agent → `wireAgentForConnection` |
| `packages/bodhi-pi-ws-server/.env.example` | + `OPENAI_API_KEY=`, `BODHI_PI_SERVER_DATA_DIR=./.bodhi-pi-server` |
| `packages/bodhi-pi-ws-frontend/src/stores/chatStore.ts` | NEW — messages array, status, append-streaming-chunk action |
| `packages/bodhi-pi-ws-frontend/src/ui/Composer.tsx` | NEW — textarea + Send; disabled while streaming |
| `packages/bodhi-pi-ws-frontend/src/ui/MessageList.tsx` | NEW — renders text messages with `data-testid="message"`, `data-role` |
| `packages/bodhi-pi-ws-frontend/src/ui/Chat.tsx` | NEW — composes StatusBar + MessageList + Composer; on first send issues `session/new` → `session/prompt` |
| `packages/bodhi-pi-ws-frontend/src/App.tsx` | wire Settings → Connect → Chat |

**Implementation notes.**
- Reuse `bodhi-pi-node/src/filesystem/node-filesystem.ts` directly (peer-import via workspace). It is single-tenant by construction — we just construct one per user with the correct cwd.
- Reuse `createInMemorySessionStore()` from bodhi-pi for M2; **no SQLite yet**. Sessions vanish on disconnect — that is fine; M3 fixes it.
- Frontend renders `sessionUpdate` notifications via a tiny dispatcher (lift the shape from `bodhi-pi-web/src/agent/render.ts`, but minimal — text chunks only, no tool cards yet).

**TDD / gate-check tests.**
- Integration (`test/prompt-roundtrip.test.ts`): start server, open WS client, `initialize` → `session/new` → `session/prompt` with a faux-LLM model (use the harness pattern from `bodhi-pi-cli/test/helpers/faux-script.ts`; inject via env-substituted models config) → assert streaming chunks arrive in order, ends with `stop_reason: end_turn`. Verify a file written by an in-prompt tool call lands in the per-user workspace dir.
- E2E (`e2e/m2-prompt.spec.ts`): real-LLM "reply with the single word ping". Mirrors `bodhi-pi-web/e2e/chat.spec.ts:3-30`. Model = `gpt-4o-mini`. Workers=1.

```bash
npm run test -w bodhi-pi-ws-server
OPENAI_API_KEY=… npm run test:e2e -w bodhi-pi-ws-frontend -- m2-prompt
```

**Commit:** `feat(bodhi-pi-ws-server): M2 first prompt round-trip with in-memory store`

---

## M3 — SQLite persistence + multi-tenant isolation

**Scope.** Replace in-memory store with SQLite. Drizzle schema with `user_id` on every row. `MultiTenantSessionStore` factory scoped per user. Migrations on boot. `session/load` re-hydrates and replays history via `sessionUpdate`. **No frontend changes** beyond optionally exposing `sessionId` in URL hash for reload-survives.

**Files.**

| Path | Change |
|---|---|
| `packages/bodhi-pi-ws-server/drizzle.config.ts` | NEW |
| `packages/bodhi-pi-ws-server/src/sessions/schema.ts` | NEW — `users` (id PK, email, created_at, last_seen_at), `sessions` (id, user_id FK, created_at, updated_at, title), `entries` (composite PK (session_id, seq), at, kind, payload JSON, **plus user_id denormalized for query speed**) |
| `packages/bodhi-pi-ws-server/src/sessions/migrate.ts` | NEW — runs Drizzle migrations on `buildServer()` |
| `packages/bodhi-pi-ws-server/src/sessions/sqlite-session-store.ts` | NEW — factory `createSqliteSessionStore({ db, userId })` returning `SessionStore`. Every method WHERE-clauses on user_id; `list/load/append/delete` reject cross-user reads. |
| `packages/bodhi-pi-ws-server/src/auth/upgrade.ts` | + on accept: `INSERT OR REPLACE INTO users` |
| `packages/bodhi-pi-ws-server/src/agent/wire-agent.ts` | swap `createInMemorySessionStore()` → `createSqliteSessionStore({ db, userId: ctx.user.id })` |
| `packages/bodhi-pi-ws-frontend/src/stores/chatStore.ts` | + `sessionId` field; persist last id to localStorage per (server-url, userId) |
| `packages/bodhi-pi-ws-frontend/src/ui/Chat.tsx` | on Connect: if last sessionId for this user exists → `session/load`, else `session/new` |

**Implementation notes.**
- Schema mirrors `bodhi-pi-node/src/sessions/schema.ts` shape (entries are append-only with `kind` discriminant), **plus `user_id` columns and composite indexes** `(user_id, updated_at desc)` on sessions, `(user_id, session_id, seq)` on entries.
- `MultiTenantSessionStore.load(sessionId)` first verifies `(user_id, sessionId)` exists; if not, throws — this is the cross-tenant gate.
- DB connection is process-singleton (`better-sqlite3` in WAL mode). Stores share it.

**TDD / gate-check tests.**
- Unit (`test/sessions/store.test.ts`): create as Alice, list as Bob → empty; load Alice's sessionId as Bob → throws; append with mismatched user → throws.
- Integration (`test/persistence.test.ts`): faux-LLM full prompt → reconnect with same userId+sessionId → `session/load` replays N user+assistant entries via sessionUpdate notifications; entry count matches DB.
- E2E (`e2e/m3-isolation.spec.ts`): two Playwright contexts (Alice id=1, Bob id=2), each runs Settings → Connect → send a unique message. Cross-context: Bob refreshes with Alice's sessionId in localStorage (simulated by setting via Settings UI exposing "load by id" field) → expects `data-status="error"` with "session not found". Real LLM optional; faux LLM acceptable here since the assertion is isolation, not LLM behavior. **If the test only asserts isolation, run with faux models** to keep CI green; gate the second e2e on real-LLM continuity (Alice reload-tab → sees previous turn).

```bash
npm run test -w bodhi-pi-ws-server
npm run test:e2e -w bodhi-pi-ws-frontend -- m3-
```

**Commit:** `feat(bodhi-pi-ws-server): M3 SQLite persistence with multi-tenant isolation`

---

## M4 — Frontend wiring polish: streaming UI, tool calls, model picker

**Scope.** With backend feature-stable through M3, harden the frontend: stream rendering with auto-scroll, tool-call cards (lifted minimally from `bodhi-pi-web/src/ui/ToolCallCard.tsx`), model picker driven by server's `setSessionConfigOption`, error banner on protocol errors. Backend changes confined to ensuring `setSessionConfigOption` works under multi-tenant.

**Files.**

| Path | Change |
|---|---|
| `packages/bodhi-pi-ws-frontend/src/ui/ToolCallCard.tsx` | NEW — lift from `bodhi-pi-web/src/ui/ToolCallCard.tsx`, strip features we don't surface |
| `packages/bodhi-pi-ws-frontend/src/ui/MessageList.tsx` | + interleave tool-call cards by store order |
| `packages/bodhi-pi-ws-frontend/src/ui/ModelPicker.tsx` | NEW — dropdown, `data-testid="model-picker"`. On change → `setSessionConfigOption` |
| `packages/bodhi-pi-ws-frontend/src/ui/StatusBar.tsx` | + `data-current-model` attribute |
| `packages/bodhi-pi-ws-frontend/src/stores/chatStore.ts` | + `availableModels`, `currentModel`; tool-call slice |
| `packages/bodhi-pi-ws-frontend/e2e/pages/AppPage.ts` | + `setModel`, `toolCalls(filter)`, `lastMessage(role)` |

**TDD / gate-check tests.**
- Integration (server side): unchanged behavior — `setSessionConfigOption` writes a `model_change` entry with correct user_id. Cross-tenant test: Bob trying to switch model on Alice's session → rejected.
- E2E (`e2e/m4-tool-call.spec.ts`): real-LLM prompt that triggers a `read_text_file` tool against a seed file in the per-user workspace; assert tool-call card renders with `data-tool-name="read_text_file"`, `data-tool-status="completed"`. Mirrors `bodhi-pi-web/e2e/fs-tools.spec.ts`.
- E2E (`e2e/m4-model-switch.spec.ts`): switch from gpt-4o-mini → gpt-4o, send another prompt, status bar reflects. Skipped if only one model in env. Mirrors `bodhi-pi-web/e2e/model-switch.spec.ts`.

```bash
npm run test -w bodhi-pi-ws-server
OPENAI_API_KEY=… npm run test:e2e -w bodhi-pi-ws-frontend -- m4-
```

**Commit:** `feat(bodhi-pi-ws-frontend): M4 streaming UI, tool calls, model picker`

---

## M5 — Multi-session UX: list, switch, delete, reconnect indicator

**Scope.** Frontend gains a session sidebar that calls `session/list`, allows switching between sessions (which triggers `session/load`), creating new ones, and deleting (`_bodhi-pi/session/delete` extMethod). Reconnect indicator shows when ws drops and lets user retry. Backend: nothing new — `session/list` already implemented in M3, just used by frontend now.

**Files.**

| Path | Change |
|---|---|
| `packages/bodhi-pi-ws-frontend/src/ui/SessionList.tsx` | NEW — sidebar; calls `session/list` on Connect; rows have `data-testid="session-row"`, `data-session-id` |
| `packages/bodhi-pi-ws-frontend/src/ui/Chat.tsx` | layout: SessionList + main chat area; "New session" button |
| `packages/bodhi-pi-ws-frontend/src/transport/ws-transport.ts` | + `onClose` exposes reason; reconnect button issues fresh `connect()` |
| `packages/bodhi-pi-ws-frontend/src/ui/StatusBar.tsx` | + Reconnect button visible when `data-status="disconnected"` |
| `packages/bodhi-pi-ws-frontend/e2e/pages/AppPage.ts` | + `sessionRow(id)`, `clickNewSession`, `expectSessionCount` |

**TDD / gate-check tests.**
- E2E (`e2e/m5-sessions.spec.ts`): Alice context — new session, send message, new session, send message, list shows 2 rows; click first, history loads; delete second, list shows 1.
- E2E (`e2e/m5-reconnect.spec.ts`): mid-session, force ws close from server side via a debug helper (e.g., expose a hidden `__test_close` HTTP route guarded by env flag → frontend status flips to disconnected → click Reconnect → status returns to connected → previously-loaded session still shows history (re-hydrates via `session/load`)).

```bash
npm run test -w bodhi-pi-ws-server
OPENAI_API_KEY=… npm run test:e2e -w bodhi-pi-ws-frontend -- m5-
```

**Commit:** `feat(bodhi-pi-ws-frontend): M5 session list, switch, delete, reconnect`

---

## Final acceptance gate

After M5:

```bash
# unit + integration across new package
npm run test -w bodhi-pi-ws-server

# real-LLM e2e (needs OPENAI_API_KEY in .env)
npm run test:e2e -w bodhi-pi-ws-frontend

# typecheck across monorepo
npm run check
```

Manual smoke: open two browser tabs at `http://localhost:35173` (or chosen dev port), set Alice in tab A, Bob in tab B, each runs a prompt, verify session sidebars show only own sessions, reload tabs, verify history. Kill server mid-prompt → tabs go disconnected → restart server → click Reconnect → previously-loaded sessions reload from DB.

## Risks and future work

- **In-flight prompt collision:** frontend prevents but server does not enforce. If/when pi-agent gains message-queue / branching, surface here.
- **Server-wide multi-tab same-session:** per locked decision, second tab loading the same sessionId is allowed and produces independent in-memory state. Both tabs commit to the same append-only log → divergent traversals next reload (the future "branching" feature). Document, do not fix here.
- **ScriptExecutor disabled.** Slash commands that depend on `run_script` will not work. UI should grey them out (deferred to whenever skills/commands UI ships).
- **`better-sqlite3` is synchronous.** Long writes block the event loop. Acceptable for PoC; if it bites, switch to `node-sqlite3-wasm` or queue writes.
- **No rate limiting / abuse controls.** Trivially DoS-able; out of scope.
- **No CSRF / origin check on WS upgrade.** Subprotocol token alone authenticates. For deployed PoC, add `Origin` allowlist to upgrade handler.
- **bodhi-pi-server lib extraction** is the obvious M6+ step once the streamable-HTTP PoC reveals the shared seam. Likely candidates: `transport/ws-stream.ts`, `auth/`, `sessions/*`, `filesystem/user-workspace.ts`.
