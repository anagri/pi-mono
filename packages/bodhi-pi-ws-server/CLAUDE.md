# bodhi-pi-ws-server

WebSocket-hosted multi-user agent backend for `@bodhiapp/bodhi-pi`. Single Node app: bare `node:http` + `ws`, multi-tenant SQLite (Drizzle), per-user workspace dirs, ACP wire over WS frames.

**Parity counterparts:** `packages/bodhi-pi-ws-frontend` (browser client that talks to this server) and `packages/bodhi-pi-web` (single-tenant browser-only host with the same feature surface). Every user-visible feature in any host must land in all three — see `packages/bodhi-pi/CLAUDE.md` for the rule.

`README.md` covers user-facing setup. Plan lives in `ai-docs/plans/we-have-packages-bodhi-pi-which-imperative-popcorn.md`.

All the bodhi-pi-* runtimes, including this are Proof of Concepts, so there is no production deployment of these PoCs, there is no backwards compatability requirement, no data migration requirment, makes development of bodhi-pi quicker with these PoCs checking it works in all runtimes.

## Feature surface (the parity contract)

What this server enables clients (the ws-frontend, or any other ACP/WS client) to do. Mirrors `packages/bodhi-pi-web/CLAUDE.md`'s feature list:

- **Streaming chat round-trip** via ACP `session/prompt` over WS.
- **Tool execution** through the built-in toolset (`createBuiltinTools`) — read/write/edit/ls/find/grep/run_script.
- **Cancellation** via ACP `session/cancel`.
- **Slash commands, project commands, skills, scripted skills** — handled by `bodhi-pi`'s prompt expansion before the LLM sees the message; the server only wires transport + multi-tenant storage.
- **Extensions.** Auto-loaded per WS connection from `<cwd>/.bodhi-pi/extensions/*.{js,mjs,cjs}`.
- **Cross-provider.** OpenAI + Anthropic registered when their API keys are set in env; `/model <id>` switching travels through ACP `session/setSessionConfigOption`.
- **Session lifecycle.** SQLite-backed multi-tenant session store (scoped by `userId`); reconnect rehydrates from disk; cross-tenant access throws.
- **Lifecycle event stream.** Every `BodhiPiEvent` the agent emits is forwarded to the client via ACP `extNotification("_bodhi-pi/lifecycle/event", ...)`. The ws-frontend renders these in its `EventsPanel` lifecycle tab — parity with `bodhi-pi-web`'s lifecycle tab. Wire frames remain visible client-side via the existing event log.

## Architecture pillars

**Auth at WS upgrade-time, not via ACP `authenticate`.** Browsers can't set `Authorization` on WS upgrade, so the bearer token rides in `Sec-WebSocket-Protocol`: client sends `[bodhi-pi.v1, bearer.<base64url-json>]`. Server reads the header, decodes, attaches `{id, email}` to the connection ctx. ACP `authenticate` stays a no-op.

**Token = `base64url(JSON({id, email}))`**, plain payload. No signature for the PoC; future swap to real JWT is a constant-time replacement of `auth/token.ts`.

**One AcpAgent per WS connection. No server-wide hot cache.** `ws.close` evicts everything; reconnect re-hydrates from SQLite. In-flight prompts are cancelled.

**Single SQLite file with `user_id` column.** `./.bodhi-pi-server/sessions.db`. Drizzle migrations on boot. SessionStore factory takes `userId` and scopes every read/write — cross-tenant access throws.

**Per-user shared workspace.** `./.bodhi-pi-server/users/<userId>/workspace/`. All of a user's sessions share their workspace.

**Heartbeat = WS protocol ping every 30s, drop on no-pong.** Built into the ws library; no client code.

**`ScriptExecutor` registered, scoped by per-user cwd.** `wireAgentForConnection` builds `createNodeScriptExecutor()` per WS connection. The only isolation boundary is the user's workspace directory (the agent's cwd, `<dataDir>/users/<userId>/workspace/` or the `--workspace` override) — there is no syscall-level sandboxing. Acceptable for the test-host scope of this package; production deployments would need to add OS-level sandboxing before exposing this to untrusted users.

**`--workspace <dir>` is single-tenant override.** When set (CLI or `BuildServerOptions.workspaceOverride`), every connecting user uses that dir as their agent cwd, bypassing `ensureUserWorkspace`. Multi-tenant DB isolation (M3) still active. Used by e2e fixture-driven tests; do NOT enable in production.

**Project extensions auto-load per WS connection.** `wireAgentForConnection` calls `createNodeExtensionLoader({ cwd })` on every accept and forwards the result as `extensionFactories` to `createBodhiPiAgent`. Each connection sees its workspace's `.bodhi-pi/extensions/*.{js,mjs,cjs}` exactly once at boot.

## Key files

| Path | Role |
|---|---|
| `src/index.ts` | Entry: dotenv, `parseArgs`, `buildServer`, listen |
| `src/cli-args.ts` | `parseArgs(argv)` for `--port`, `--workspace`, `--data-dir`, `--help` |
| `src/server.ts` | `buildServer({port, dataDir, workspaceOverride?, ...})` — http + ws, upgrade routing, heartbeat |
| `src/auth/token.ts` | `encodeToken` / `decodeToken` (base64url JSON, type-validated) |
| `src/auth/upgrade.ts` | `authenticateUpgrade(req)` reads `Sec-WebSocket-Protocol`, decodes bearer; `handleAgentUpgrade` rejects 401 or accepts |
| `src/transport/ws-stream.ts` | `wsToStream(ws)` → `{readable, writable}` for ACP `ndJsonStream` |
| `src/filesystem/user-workspace.ts` | `resolveUserWorkspace({dataDir, userId, workspaceOverride?})` — single seam |
| `src/agent/wire-agent.ts` | per-connection bodhi-pi factory + `createNodeExtensionLoader` |

## Source code rules

- **Auth lives at the transport seam.** Upgrade handler is the only place that reads the bearer token. Once accepted, `UpgradeContext.user` is the truth — handlers downstream do not re-validate.
- **`buildServer` is the test boundary.** Tests call `buildServer({port: 0})` to pick a random free port. Never hand-build the same wiring elsewhere.
- **No agent logic.** Wire transports, route auth, dispatch ACP. Anything else belongs in `bodhi-pi`.

## Test conventions

- `test/` for unit + integration. Integration tests start a real server on port 0, drive a real `ws` client through `ClientSideConnection`. No mocks of WS or ACP.
- Each integration test owns its server lifecycle via `beforeEach`/`afterEach`.
