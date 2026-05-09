# bodhi-pi-ws-server

WebSocket-hosted multi-user agent backend for `@bodhiapp/bodhi-pi`. Single Node app: bare `node:http` + `ws`, multi-tenant SQLite (Drizzle), per-user workspace dirs, ACP wire over WS frames.

`README.md` covers user-facing setup. Plan lives in `ai-docs/plans/we-have-packages-bodhi-pi-which-imperative-popcorn.md`.

## Architecture pillars

**Auth at WS upgrade-time, not via ACP `authenticate`.** Browsers can't set `Authorization` on WS upgrade, so the bearer token rides in `Sec-WebSocket-Protocol`: client sends `[bodhi-pi.v1, bearer.<base64url-json>]`. Server reads the header, decodes, attaches `{id, email}` to the connection ctx. ACP `authenticate` stays a no-op.

**Token = `base64url(JSON({id, email}))`**, plain payload. No signature for the PoC; future swap to real JWT is a constant-time replacement of `auth/token.ts`.

**One AcpAgent per WS connection. No server-wide hot cache.** `ws.close` evicts everything; reconnect re-hydrates from SQLite. In-flight prompts are cancelled.

**Single SQLite file with `user_id` column.** `./.bodhi-pi-server/sessions.db`. Drizzle migrations on boot. SessionStore factory takes `userId` and scopes every read/write — cross-tenant access throws.

**Per-user shared workspace.** `./.bodhi-pi-server/users/<userId>/workspace/`. All of a user's sessions share their workspace.

**Heartbeat = WS protocol ping every 30s, drop on no-pong.** Built into the ws library; no client code.

**`ScriptExecutor` not registered.** Multi-tenant child_process is unsafe without sandboxing.

## Key files

| Path | Role |
|---|---|
| `src/index.ts` | Entry: dotenv, `buildServer`, listen |
| `src/server.ts` | `buildServer({port})` — http + ws, upgrade routing, heartbeat |
| `src/auth/token.ts` | `encodeToken` / `decodeToken` (base64url JSON, type-validated) |
| `src/auth/upgrade.ts` | `authenticateUpgrade(req)` reads `Sec-WebSocket-Protocol`, decodes bearer; `handleAgentUpgrade` rejects 401 or accepts |
| `src/transport/ws-stream.ts` | `wsToStream(ws)` → `{readable, writable}` for ACP `ndJsonStream` |
| `src/agent/handshake-agent.ts` | M1 stub `Agent` — only `initialize`. Replaced by `wireAgentForConnection` in M2. |

## Source code rules

- **Auth lives at the transport seam.** Upgrade handler is the only place that reads the bearer token. Once accepted, `UpgradeContext.user` is the truth — handlers downstream do not re-validate.
- **`buildServer` is the test boundary.** Tests call `buildServer({port: 0})` to pick a random free port. Never hand-build the same wiring elsewhere.
- **No agent logic.** Wire transports, route auth, dispatch ACP. Anything else belongs in `bodhi-pi`.

## Test conventions

- `test/` for unit + integration. Integration tests start a real server on port 0, drive a real `ws` client through `ClientSideConnection`. No mocks of WS or ACP.
- Each integration test owns its server lifecycle via `beforeEach`/`afterEach`.
