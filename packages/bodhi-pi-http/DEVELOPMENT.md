# bodhi-pi-http — development notes

## Toolchain

- Node `>=20`. Same as the rest of the monorepo.
- `npm install` from monorepo root resolves all deps via npm workspaces.
- Server: `tsx watch src/server/index.ts` in dev; `tsgo -p tsconfig.server.build.json` for prod build.
- Frontend: `vite` (root=`src/frontend`, outDir=`dist/public`).

## Project shape (single package, three folders)

- `src/server/` — Node entry, `POST /acp` handler, SQLite store, per-request agent build.
- `src/frontend/` — React app talking to `/acp`. Deps overlap (browser deps + Node deps in one `node_modules`). tsconfig project references keep type checking honest.
- `test/` — server unit + integration (vitest, real `node:http` server bound to port 0, real `fetch`+SSE clients, faux provider).
- `e2e/` — real-LLM e2e (vitest e2e config, `gpt-4o-mini`).

## Per-turn lifecycle

```
POST /acp { method: "session/prompt", ... }
 ├─ middleware: decode Authorization → user (or 401)
 ├─ build fresh agent via wireAgentForConnection
 ├─ build HttpAcpConn (sessionUpdate → SSE writer)
 ├─ register inflight.set(sessionId, AbortController)
 ├─ res.writeHead(200, "text/event-stream", ...)
 ├─ agent.resumeSession({ sessionId, cwd })   ← transparent hydration
 ├─ agent.prompt(params)                      ← turn streams via sessionUpdate
 ├─ res.on("close") → ctrl.abort()
 ├─ emit final response as last SSE event
 └─ res.end(); inflight.delete(sessionId)
```

The agent is **not** kept alive between HTTP requests. Every prompt re-hydrates from `sqlite-session-store`.

## Bypassing `AgentSideConnection`

The ACP SDK's `AgentSideConnection` expects a long-lived bidirectional Web Stream pair. Feeding a one-shot HTTP request into it is awkward. We instead build a thin `HttpAcpConn` object exposing only the methods the agent calls inward, and pass it to the agent factory directly. See `src/server/acp/http-acp-conn.ts`.

## Noted-skips (intentional)

These ACP capabilities are NOT implemented because bodhi-pi core does not use them today:

- **`fs/read_text_file` / `fs/write_text_file`** — bodhi-pi has its own host-injected `Filesystem` interface (server-side direct, not over ACP). See `packages/bodhi-pi/src/filesystem/filesystem.ts:8` for the explicit comment. `HttpAcpConn.readTextFile/writeTextFile` throw if the agent ever calls them.
- **`session/request_permission`** — bodhi-pi core/agent never calls this. `HttpAcpConn.requestPermission` throws.
- **`session/request_terminal` / `createTerminal`** — terminal capability is not advertised by bodhi-pi.

If a future feature adds these to bodhi-pi, this list moves into the implementation surface (probably as a separate POST `/acp` from the client carrying the response, correlated by JSON-RPC id — see the design doc in `ai-docs/plans/bright-dreaming-popcorn.md`).

## Out of scope (PoC non-goals)

- Multi-node clustering / sticky sessions / load balancing
- In-flight turn resumption across reconnects
- Server-restart-mid-session continuity (the per-request agent rebuild implies this works, but no e2e proof)
- JSON-RPC request batching (single request per POST)
- Real auth (signed JWT, login endpoint, cookies)

These are documented to keep PRs focused.

## Testing posture

- **Unit tests** for token, sse-bridge, inflight registry, cli-args.
- **Integration tests** boot a real `node:http` server (port 0) and drive it with a real `fetch`+SSE client. Faux provider for deterministic streams. The `multi-prompt` test is the **load-bearing proof** of the serialize/deserialize thesis.
- **E2E tests** use real LLM (gpt-4o-mini); guarded by `OPENAI_API_KEY`. Same shape as `bodhi-pi/e2e/`.
- **Frontend Playwright** is configured but specs are deferred (M9 optional).

## Reference clients (parity)

This package is the 4th reference client under bodhi-pi's runtime-host parity rule:

1. `bodhi-pi-cli` (Node, REPL)
2. `bodhi-pi-web` (browser-only, single-tenant Web Worker)
3. `bodhi-pi-ws-server` + `bodhi-pi-ws-frontend` (WebSocket split host)
4. **`bodhi-pi-http`** (HTTP+SSE split host, per-turn agent rebuild)

Future user-visible features must land in all four hosts (or have a follow-up filed). See `packages/bodhi-pi/CLAUDE.md`.
