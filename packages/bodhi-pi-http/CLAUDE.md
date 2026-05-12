# bodhi-pi-http

HTTP+SSE-hosted reference client for `@bodhiapp/bodhi-pi`. Single Node project: bare `node:http` server + Vite/React frontend, multi-tenant SQLite (Drizzle), per-user workspace dirs, **MCP-Streamable-HTTP-shaped** ACP wire.

`README.md` covers user-facing setup. `DEVELOPMENT.md` covers per-turn lifecycle, bypass rationale, noted-skips. Design doc: `ai-docs/plans/bright-dreaming-popcorn.md`.

All the bodhi-pi-* runtimes, including this are Proof of Concepts, so there is no production deployment of these PoCs, there is no backwards compatability requirement, no data migration requirment, makes development of bodhi-pi quicker with these PoCs checking it works in all runtimes.

## Architecture pillars

**Each turn = one HTTP request.** `POST /acp` for `session/prompt` opens a long-lived SSE response. Agent is built fresh from persisted state, runs the turn, tears down. No agent state is held between requests.

**Single endpoint `POST /acp`, MCP-Streamable-HTTP shape.** All ACP methods POST here. Response is `application/json` for non-streaming methods and `text/event-stream` for `session/prompt` + `session/load`. Body is pure ACP JSON-RPC.

**Auth via `Authorization: Bearer <base64url(JSON({id,email}))>`.** Per-request validation in HTTP middleware. No login endpoint; client mints the token. Same trust posture as `bodhi-pi-ws-server` (no signature for the PoC).

**Bypass `AgentSideConnection` for HTTP.** Thin `HttpAcpConn` stub exposes only the methods the agent calls inward (`sessionUpdate` → SSE writer; `requestPermission`/`fs.*` throw because bodhi-pi never calls them). The handler dispatches the inbound JSON-RPC method directly to `agent.prompt(...)`, `agent.newSession(...)`, etc.

**Transparent `resumeSession` before `prompt`.** Each fresh agent has no in-memory session. The handler invokes `agent.resumeSession({sessionId, cwd})` (hydrate without history replay) before `agent.prompt(...)`. Pure use of existing bodhi-pi capability — no agent changes needed.

**Cancel via in-memory `Map<sessionId, AbortController>`.** Process-local registry. `session/cancel` looks up and aborts. `res.on("close")` also aborts (client disconnect = cancel). Single-node by design.

**Single SQLite file with `user_id` column.** `./.bodhi-pi-http/sessions.db`. Drizzle migrations on boot. Mirrors `bodhi-pi-ws-server`.

**Per-user shared workspace.** `./.bodhi-pi-http/users/<userId>/workspace/`.

**`--workspace <dir>` is single-tenant override.** All users share one cwd; multi-tenant DB isolation still active. Used by e2e fixtures; do NOT enable in production.

## Key files

| Path | Role |
|---|---|
| `src/server/index.ts` | Entry: dotenv, parseArgs, buildServer, listen |
| `src/server/server.ts` | `buildServer({port, dataDir, ...})` — http server, routing, static |
| `src/server/cli-args.ts` | `parseArgs(argv)` for `--port`, `--data-dir`, `--workspace`, `--help` |
| `src/server/auth/token.ts` | `encodeToken` / `decodeToken` |
| `src/server/auth/middleware.ts` | `requireAuth(req)` parses Authorization |
| `src/server/acp/handler.ts` | `POST /acp` router; JSON vs SSE per method |
| `src/server/acp/http-acp-conn.ts` | AgentSideConnection-shaped object for SSE methods |
| `src/server/acp/sse.ts` | SSE writer helpers |
| `src/server/acp/inflight.ts` | `Map<sessionId, AbortController>` |
| `src/server/agent/wire-agent.ts` | per-request bodhi-pi factory + extension loader |
| `src/server/sessions/` | SQLite schema, migrate, multi-tenant store |
| `src/server/filesystem/user-workspace.ts` | per-user cwd resolution |
| `src/server/static.ts` | serve `dist/public/` + SPA fallback |
| `src/frontend/lib/acp-http-client.ts` | thin fetch+SSE client mirroring `ClientSideConnection` |
| `src/frontend/lib/auth.ts` | browser `encodeToken` + localStorage |
| `src/frontend/lib/sse-parser.ts` | async iterator over `text/event-stream` |
| `test/helpers/test-server.ts` | `startTestServer({...})` for integration tests |
| `test/helpers/http-acp-client.ts` | test-side fetch+SSE driver |

## Source code rules

- **Auth lives at the HTTP middleware seam.** Once a request passes `requireAuth`, downstream handlers don't re-validate.
- **`buildServer` is the test boundary.** Tests call `buildServer({port: 0})` to pick a random free port. Never hand-build the wiring elsewhere.
- **No agent logic in this package.** Wire transports, auth, dispatch ACP. Anything else belongs in `bodhi-pi`.
- **Pure ACP wire.** Body is ACP JSON-RPC. We do not invent REST endpoints or non-spec methods (extensions go through `_bodhi-pi/<area>/<verb>` per the established convention).
- **Frontend imports no agent.** `react`, `react-dom`, ACP types only. No `@bodhiapp/bodhi-pi`, no `better-sqlite3`. The agent runs server-side.

## Test conventions

- `test/` for unit + integration. Integration tests boot a real server on port 0, drive it with `fetch` + a small SSE parser. No mocks of HTTP.
- Each integration test owns its server lifecycle via `beforeEach`/`afterEach`.
- Cancel-related tests use the faux provider with controlled token-stream timing (deterministic). Real-LLM tests live under `e2e/`.
- The **`multi-prompt` integration test** is the load-bearing proof: two independent HTTP requests, agent built fresh per request, second turn must see the first's history.
