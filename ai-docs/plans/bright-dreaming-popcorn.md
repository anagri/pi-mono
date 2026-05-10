# bodhi-pi-http — stateless-deployment PoC

## Context

The current `bodhi-pi-ws-server` is a stateful, long-lived WebSocket host. Each connection holds an `AcpAgent` in memory; reconnect re-hydrates from SQLite. ACP itself is inherently stateful (sessionId, in-flight turns, streaming notifications), so any non-WS deployment has to answer: *where does turn state live?*

This PoC proves a sharper deployment model:

> **Each turn = one long-lived HTTP request.** The agent is built fresh from persisted state at the start of the request, runs the turn (streaming notifications back as SSE), and is torn down on completion or client disconnect. The next turn (next HTTP request) re-hydrates from store.

No mid-turn resume, no clustering, no sticky sessions. The proof is that two prompts in the same session, sent as two independent HTTP requests, work correctly — meaning all session state truly lives in storage, not in process memory between requests.

Wire shape: **MCP-Streamable-HTTP-style** (single endpoint `POST /acp`, returns either `application/json` or `text/event-stream` depending on method). Body remains pure ACP JSON-RPC — we are framing ACP over HTTP, not redesigning ACP.

This becomes the **4th reference host** (alongside `bodhi-pi-cli`, `bodhi-pi-web`, `bodhi-pi-ws-server`+`bodhi-pi-ws-frontend`), and the parity rule in `packages/bodhi-pi/CLAUDE.md` is updated to reflect this.

## Design

### Wire — `POST /acp` (MCP-Streamable-HTTP shape)

| ACP method | Response Content-Type |
|---|---|
| `initialize`, `authenticate`, `session/new`, `session/list`, `session/cancel`, `session/close`, `_bodhi-pi/session/delete` | `application/json` (single JSON-RPC response) |
| `session/load`, `session/prompt` | `text/event-stream` (notifications as `event: message`, terminating with the final JSON-RPC response) |

Auth: `Authorization: Bearer <base64url(JSON({id,email}))>`. Same token shape as `bodhi-pi-ws-server`. Validated per request. **Not** ACP `authenticate` (which stays a no-op).

### Per-turn lifecycle

```
POST /acp { jsonrpc, id, method: "session/prompt", params: { sessionId, prompt } }
  ├─ middleware: decodeToken(Authorization) → user, or 401
  ├─ wireAgentForConnection({user, dataDir, db, ...}) → factory
  ├─ build HttpAcpConn (sessionUpdate → SSE writer)
  ├─ agent = factory(httpAcpConn)
  ├─ register inflight.set(sessionId, AbortController)
  ├─ res.writeHead(200, { "content-type": "text/event-stream", ... })
  ├─ if not loaded: agent.resumeSession({ sessionId, cwd })   ← transparent hydration
  ├─ agent.prompt(params)   ← runs turn; sessionUpdate calls flow to SSE
  │     res.on('close') → ctrl.abort('client-closed') → agent.cancel({sessionId})
  ├─ emit final response as last SSE event (with matching jsonrpc.id)
  └─ res.end(); inflight.delete(sessionId); GC agent
```

`session/cancel` looks up `inflight.get(sessionId)?.abort()` — runs in any concurrent HTTP request on the same process.

### Bypassing `AgentSideConnection`

Per the SDK contract (Web Streams, long-lived bidirectional), feeding it a one-shot HTTP request is awkward. Instead:

- Build a tiny `HttpAcpConn` object exposing only the methods the agent calls inward: `sessionUpdate(notification)` (load + prompt), and stubs that throw for `requestPermission` / `readTextFile` / `writeTextFile` (bodhi-pi never calls these — see DEVELOPMENT.md note).
- Pass `HttpAcpConn` into the factory returned by `wireAgentForConnection`. The agent treats it as its `AgentSideConnection`.
- The HTTP handler dispatches the inbound JSON-RPC method directly: `await agent.prompt(params)`, `await agent.newSession(params)`, etc.
- For SSE methods, `sessionUpdate` writes one `event: message\ndata: {...}\n\n` line per notification.

### Project layout — single package, three folders

```
packages/bodhi-pi-http/
  package.json              ← single, deps: bodhi-pi + bodhi-pi-node + drizzle + better-sqlite3
                              + react/vite + vitest/playwright
  tsconfig.json             ← root, references server + frontend
  tsconfig.server.json      ← module=node, includes src/server, test, e2e
  tsconfig.frontend.json    ← jsx=react-jsx, includes src/frontend
  vite.config.ts            ← root=src/frontend, build.outDir=dist/public, dev proxy /acp→:3000
  vitest.config.ts          ← server unit + integration (test/**)
  vitest.e2e.config.ts      ← real-LLM e2e (e2e/**.e2e.ts)
  playwright.config.ts      ← skeleton for FE e2e (deferred)
  CLAUDE.md
  README.md
  DEVELOPMENT.md            ← noted-skips: ACP fs/* and session/request_permission
  .env / .env.example       ← provider keys (mirror ws-server)
  src/
    server/
      index.ts              ← entry: dotenv, parseArgs, buildServer, listen
      server.ts             ← buildServer({port, dataDir, ...}) → http server
      cli-args.ts           ← --port --data-dir --workspace --help (mirror ws-server)
      models.ts             ← mirror ws-server (gpt-4o-mini default)
      auth/
        token.ts            ← duplicated from ws-server: encodeToken/decodeToken
        middleware.ts       ← parse Authorization, attach user, return 401
      acp/
        handler.ts          ← POST /acp router; dispatches to JSON or SSE per method
        http-acp-conn.ts    ← AgentSideConnection-shaped object for SSE
        sse.ts              ← SSE writer helpers
        inflight.ts         ← Map<sessionId, AbortController> + register/abort
      filesystem/user-workspace.ts   ← duplicated
      sessions/             ← duplicated SQLite schema, migrate, store
      agent/wire-agent.ts   ← duplicated; same per-request build pattern
      static.ts             ← serve dist/public/* + index.html SPA fallback
    frontend/
      index.html
      main.tsx, App.tsx
      lib/
        acp-http-client.ts  ← fetch + SSE parser exposing ClientSideConnection-like surface
        auth.ts             ← encodeToken (browser btoa); localStorage helpers
        sse-parser.ts       ← async iterator over text/event-stream
      hooks/                ← port useChat / useSessions / useSettings / useEventLog
      components/           ← port EventsPanel, message renderer, prompt input
      ui/                   ← port shadcn primitives
  test/
    helpers/
      test-server.ts        ← startTestServer({...}) — mirror ws-server pattern
      http-acp-client.ts    ← test-side reuse of acp-http-client (fetch+SSE)
      faux-provider.ts      ← reuse pi-ai's registerFauxProvider
    integration/
      auth.test.ts          ← 401 paths, valid bearer
      session-crud.test.ts  ← new/list/load/delete via JSON
      multi-prompt.test.ts  ← KEY PROOF: two prompts, second sees first's history
      cancel.test.ts        ← faux-provider with delay; POST cancel; assert stopReason
      sse-bridge.test.ts    ← unit-ish: stream of notifications wired to SSE format
  e2e/
    chat.e2e.ts             ← real LLM (gpt-4o-mini) happy path through HTTP
```

**No workspace-package split.** One `package.json`, one `node_modules`. Vite handles frontend; vitest handles server tests. Browser deps (`react`, `vite`) and Node deps (`better-sqlite3`, `drizzle-orm`) coexist; tsconfig project refs keep type checking honest.

### Frontend — parity with ws-frontend, transport replaced

`src/frontend/lib/acp-http-client.ts` exposes the **same method surface** as `ClientSideConnection` (so existing hooks port verbatim):

```typescript
interface AcpHttpConnection {
  initialize(p): Promise<InitializeResponse>
  newSession(p): Promise<NewSessionResponse>
  loadSession(p): Promise<LoadSessionResponse>     // internally: SSE; dispatches notifications via onSessionUpdate
  listSessions(p): Promise<ListSessionsResponse>
  prompt(p, signal?): Promise<PromptResponse>     // internally: SSE
  cancel(p): Promise<void>
  extMethod(name, params): Promise<unknown>       // for _bodhi-pi/session/delete
  onSessionUpdate(h): () => void
}
```

`prompt` and `loadSession` open `fetch` with `Accept: text/event-stream`, parse the SSE byte stream into events, dispatch each `session/update` to registered handlers, and resolve with the final response.

Auth: client-side login form takes `id`+`email`, encodes via `btoa(JSON.stringify(...))` (URL-safe base64), stores in `localStorage` keyed by server origin. Each request adds `Authorization: Bearer <token>`. No `/auth/login` endpoint.

WS-only behaviors that **don't** port: reconnect-with-resume (each request is its own; no transport-level reconnect), ping/pong heartbeat (HTTP doesn't need it), `FrameTap`-based byte logging (replaced by per-event log inside `acp-http-client`).

## Implementation milestones (iterative, TDD)

Principle: each step adds the **smallest** code+test pair that drives the next behavior. No code created without a test that exercises it. **All tests green at the end of every step.** Files appear when a test forces them, not on speculation.

### M0 — Package skeleton ✅
Package.json, tsconfigs, vite/vitest/playwright configs, CLAUDE.md, README.md, DEVELOPMENT.md, .env.example, .gitignore. `npm install` resolves; `npm test` runs (zero tests).

### M1 — Auth token + middleware + healthz ✅
- `src/server/auth/token.ts` + `token.test.ts` (encode/decode roundtrip + edge cases).
- `src/server/auth/middleware.ts` + `middleware.test.ts` (Bearer extraction, 401 responses).
- `src/server/server.ts` with `buildServer({port:0})` → `/healthz` + 404 catch-all.
- `test/helpers/test-server.ts` for integration boot.
- `test/integration/healthz.test.ts` (200 ok, 404 fallback).

### M2 — CLI args ✅
- `src/server/cli-args.ts` + `cli-args.test.ts` (port, workspace, data-dir parsing).
- `src/server/models.ts` (resolveModelsFromEnv).
- `src/server/index.ts` entry (dotenv → parseArgs → buildServer → listen).

> Note: M2 also pre-created `sessions/{schema,migrate,sqlite-session-store}.ts` and `filesystem/user-workspace.ts` — these will be exercised by M3b/M3c integration tests when wired through. Acceptable but not ideal; future milestones stick tighter to "code only when next test demands."

### M3a — First ACP method through `/acp`: `initialize`
- `test/integration/acp-initialize.test.ts`: `POST /acp` with `initialize` JSON-RPC, with and without bearer.
- Add: `src/server/acp/handler.ts` (POST /acp router; auth middleware; dispatches `initialize` only).
- Add: `src/server/acp/http-acp-conn.ts` (sessionUpdate stub — throws for now; not exercised yet).
- Add: `src/server/agent/wire-agent.ts` (per-request bodhi-pi factory). Note: this brings in SessionStore + workspace dependencies → first real exercise of M2's plumbing.
- Wire `/acp` route in `server.ts`.

### M3b — `session/new` JSON method
- `test/integration/session-new.test.ts`: initialize → newSession → assert sessionId returned, row in DB.
- Extend handler to dispatch `session/new`.
- Validates SQLite store + per-user workspace creation.

### M3c — `session/list` JSON method
- `test/integration/session-list.test.ts`: alice creates 2 sessions; bob creates 1; alice list returns 2; bob list returns 1.
- Extend handler to dispatch `session/list`.
- Validates multi-tenant isolation in the store.

### M3d — `_bodhi-pi/session/delete` extension method
- `test/integration/session-delete.test.ts`: create → delete → list returns empty.
- Extend handler to dispatch the extension method via `agent.extMethod`-like path.

### M4 — Inflight registry (unit-tested only)
- `src/server/acp/inflight.test.ts` first: register → returns AbortController; abort by sessionId; idempotent if absent.
- `src/server/acp/inflight.ts` minimal Map<sessionId, AbortController>.
- Not yet wired into handler — M5b uses it.

### M5a — SSE writer + `session/prompt` (single turn)
- `src/server/acp/sse.test.ts`: SSE writer formats event/data/id correctly.
- `src/server/acp/sse.ts` writer.
- `test/integration/prompt-roundtrip.test.ts`: faux provider single response; POST prompt; SSE stream has agent_message_chunk + final response with stopReason=end_turn.
- Handler dispatches `session/prompt` to SSE response. `HttpAcpConn.sessionUpdate` writes events.

### M5b — Multi-prompt key proof
- `test/integration/multi-prompt.test.ts`: prompt #1 → faux returns "I am A"; new HTTP request prompt #2 → faux receives history including "I am A".
- Forces `agent.resumeSession({sessionId, cwd})` transparent call before `agent.prompt`.
- **The load-bearing PoC proof.**

### M5c — Cancel
- `test/integration/cancel.test.ts`: faux provider with delayed chunks; POST prompt; mid-stream POST `session/cancel`; SSE closes with `stopReason: "cancelled"`.
- Wire inflight registry into handler. `res.on("close")` also aborts.

### M5d — `session/load` (history replay over SSE)
- `test/integration/session-load.test.ts`: prompt → close; new request session/load → SSE replays user_message_chunk + agent_message_chunk for the prior turn.

### M6a — Frontend skeleton: `index.html` + `main.tsx` + Login form
- Add: `src/frontend/index.html`, `src/frontend/main.tsx`, `src/frontend/App.tsx` (login form only).
- Add: `src/frontend/lib/auth.ts` (browser `encodeToken` via `btoa`; localStorage helpers).
- Manual smoke: `npm run dev:frontend` opens login form at :5173.

### M6b — Frontend ACP client (JSON methods)
- Add: `src/frontend/lib/acp-http-client.ts` with `initialize`, `newSession`, `listSessions`, `extMethod` (JSON paths only).
- Wire login → initialize call. Show user info on success.

### M6c — Frontend sessions list
- Sessions panel: list + new + delete buttons. Calls `acp-http-client`.

### M7a — Frontend SSE parser
- Add: `src/frontend/lib/sse-parser.ts` (async iterator over `text/event-stream`).
- Unit test in vitest with browser-shaped fixtures.

### M7b — Frontend chat: prompt + streaming render
- Extend `acp-http-client` with SSE `prompt` + `loadSession`.
- Port (or write fresh) chat hook from ws-frontend `useChat`. Replace transport with acp-http-client.
- Composer + message list. Send → stream chunks render → final response.

### M7c — Cancel button + session reload
- Composer Send/Stop morph during streaming. Stop calls `cancel`.
- Click a session in the list → loadSession → history replays in chat.

### M8a — Real-LLM e2e (backend)
- `e2e/chat.e2e.ts`: real gpt-4o-mini; spawn server with real models; assert text streams.
- Gated on `OPENAI_API_KEY`.

### M8b — Parity polish + static serving
- Update `packages/bodhi-pi/CLAUDE.md` parity rule: 4 reference hosts.
- `src/server/static.ts`: serve `dist/public/` + SPA fallback when present (so `npm start` works post-build).
- Add npm scripts referenced by `README.md`.

### M9 (optional, deferred) — Playwright FE e2e
Skeleton in M0; specs only if/when visual proof becomes valuable.

## Critical files & reuse

**Reused as-is (imported, not duplicated):**
- `@bodhiapp/bodhi-pi` — `createBodhiPiAgent`, `Agent` interface, `SessionStore`/`Filesystem`/`SessionEntry` types.
- `@bodhiapp/bodhi-pi-node` — `createNodeFilesystem`, `createNodeExtensionLoader`, `createNodeScriptExecutor`.
- `@mariozechner/pi-ai` — model definitions; `registerFauxProvider` in tests.
- `@agentclientprotocol/sdk` — JSON-RPC types only (`InitializeRequest`, `PromptRequest`, etc.). **NOT** `AgentSideConnection`/`ClientSideConnection`/`ndJsonStream`.

**Duplicated from `bodhi-pi-ws-server` (extract later if both hosts persist):**
- `src/server/auth/token.ts` (← `bodhi-pi-ws-server/src/auth/token.ts`)
- `src/server/filesystem/user-workspace.ts` (← `bodhi-pi-ws-server/src/filesystem/user-workspace.ts`)
- `src/server/sessions/{schema,migrate,sqlite-session-store}.ts` (← same paths)
- `src/server/agent/wire-agent.ts` (← `bodhi-pi-ws-server/src/agent/wire-agent.ts`) — drop ws-specific bits
- `src/server/cli-args.ts` (← same path; same flags)
- `src/server/models.ts` (← same path)

**Test pattern reused** from `bodhi-pi-ws-server/test/`: `startTestServer` shape, faux provider lifecycle, port-0 binding.

**Frontend pattern reused** from `bodhi-pi-ws-frontend/src/`: hooks, components, ui all port verbatim once `acp-http-client` exposes the `ClientSideConnection`-shaped API.

## Out of scope (explicit non-goals)

- Multi-node / clustering / sticky sessions / load-balancer routing
- In-flight turn resumption across reconnects
- Server-restart-mid-session continuity (the per-request rebuild implies it would work; not e2e-proven)
- ACP `fs/read_text_file` / `fs/write_text_file` — bodhi-pi uses host-injected `Filesystem` directly (see `packages/bodhi-pi/src/filesystem/filesystem.ts:8`)
- ACP `session/request_permission` — bodhi-pi core/agent does not call this today
- JSON-RPC request batching (single request per POST)
- Cookie-based auth, real JWT signing, login endpoint

DEVELOPMENT.md records these explicitly so future contributors don't re-derive.

## Verification

End-to-end manual smoke (post-M8):

```bash
# from monorepo root
pnpm -F @bodhiapp/bodhi-pi-http build:frontend
pnpm -F @bodhiapp/bodhi-pi-http dev:server   # node :3000

# in browser at http://localhost:3000
#   1. Login with id=1 email=alice@example.com
#   2. Create session → /workspace path appears
#   3. Send prompt "list files in this dir"; observe streaming + tool call
#   4. Send second prompt "what did I just ask"; assert reply references prior turn
#   5. Send a long prompt; click cancel mid-stream; assert SSE closes with stopReason=cancelled
```

Automated:

```bash
# server unit + integration (faux provider)
pnpm -F @bodhiapp/bodhi-pi-http test

# real-LLM e2e (requires OPENAI_API_KEY)
pnpm -F @bodhiapp/bodhi-pi-http test:e2e
```

The **multi-prompt integration test** is the load-bearing automated proof: two independent HTTP requests, agent built fresh per request, second turn's faux-provider input must include the first turn's user+assistant messages — meaning state was reconstructed entirely from SQLite between requests. This is the deployment thesis.

## Parity rule update

Edit `packages/bodhi-pi/CLAUDE.md`:
- Reference hosts table grows from 3 rows to 4 (add `bodhi-pi-http`).
- Feature workflow gains step 7: `bodhi-pi-http` integration test (faux) and/or e2e (real LLM) proving the feature works under per-request agent rebuild.
- Note that `bodhi-pi-http` is the deployment-portability lens: same agent, same features, but state lives in storage between every turn.
