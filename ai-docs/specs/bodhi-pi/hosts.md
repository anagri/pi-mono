# Hosts

Four reference Hosts under `packages/bodhi-pi/test-apps/{cli,http,browser,chrome-ext}/`. Each proves the agent surface against a distinct runtime profile. Two shared infrastructure packages (`node-adapters/`, `app-utils/`) provide the adapters every Host consumes.

> **Deprecated reference**: `packages/bodhi-pi-{cli,web,http,ws-server,ws-frontend,chrome-ext,node,browser}/` were the previous generation of test apps. They are **not maintained** and exist only for historical reference. New features land in `test-apps/`. Mentioned here once for breadcrumb only.

## At-a-glance matrix

| Host | Package name | Transport | Tenancy | MCP stdio? | Per-turn agent rebuild? |
|---|---|---|---|---|---|
| cli | `@bodhiapp/bodhi-pi-test-app-cli` | ndjson over stdin/stdout (RPC mode); in-process for REPL/headless | single | yes | no |
| http | `@bodhiapp/bodhi-pi-test-app-http` | HTTP+SSE (and WebSocket sibling under `server/agent/wire-agent-ws.ts`) | multi-tenant (SQLite per user) | yes (server-side) | **yes** |
| browser | `@bodhiapp/bodhi-pi-test-app-browser` | `MessagePort` ndjson between main thread and Web Worker | single | no (`supportsMcpStdio:false`) | no |
| chrome-ext | `@bodhiapp/bodhi-pi-test-app-chrome-ext` | `MessagePort` ndjson via chrome messaging + sandbox iframe | single | no | no |

All four host packages are `private: true`. None is published to npm.

## cli (`test-apps/cli/`)

- **Entrypoint**: `src/cli.ts` (shebang Node entry). Three modes: interactive REPL, headless one-shot, RPC (ndjson over stdio).
- **Agent construction**: `src/agent.ts` calls `createBodhiPiAgent({...})` with adapters from `test-apps/node-adapters/` + `test-apps/app-utils/`:
  - `createNodeFilesystem()`
  - `createSingleTenantSqliteSessionStore({ dbPath })`
  - `createNodeKvStore()`
  - `createNodeScriptExecutor()`
  - `createBashTerminal()` (just-bash)
  - `createNodePackageExtensionLoader()` (optional)
- **ACP transport**: in `cli.ts` an `AgentSideConnection` wraps `ndJsonStream(stdout, stdin)`. In RPC mode the Client lives in another process; in REPL/headless mode the Client is a co-process inside the binary.
- **Host vs Client (per-file)**:

| File | Side | Sub-folder target | Role |
|---|---|---|---|
| `src/cli.ts` | host | `host/` | Shebang entry; wires `AgentSideConnection`+ in-process client pair |
| `src/agent.ts` | host | `host/` | `createBodhiPiAgent` + Node-adapter wiring |
| `src/config.ts` | host | `host/` | CLI arg parsing for Host construction |
| `src/repl/repl.ts` | client | `client/acp/` | Interactive REPL loop; constructs `BodhiPiClient` via `createBodhiPiClient(clientConn,{cwd})` |
| `src/repl/headless.ts` | client | `client/acp/` | Non-interactive Client variant; uses `BodhiPiClient` for one-shot prompts |
| `src/repl/commands.ts` | client | `client/lib/` | Slash dispatcher; imports `BodhiPiClient` type |
| `src/repl/render.ts` | client | `client/lib/` | Terminal output rendering (no React in cli) |

No straddling files. Subset of `client/{react,acp,deps,lib}/` because cli has no React.

- **Quirks**: Single-tenant. Agent lifetime = process lifetime. MCP in-process connections live as long as the CLI. In RPC mode the test harness drives slash commands from outside.

## http (`test-apps/http/`)

The deployment-portability lens — proves the agent works under per-turn rebuild from SQLite.

- **Entrypoint**: `src/server/index.ts` (Node HTTP entry). Frontend at `src/frontend/main.tsx`.
- **Agent construction** (rebuilt **per request**): `src/server/agent/wire-agent-shared.ts:97` → `buildAgentFactory(opts, label)` → `createBodhiPiAgent({...})` with adapters from `test-apps/node-adapters/`:
  - `createNodeFilesystem({ rootCwd })` — per-user workspace under `server/filesystem/user-workspace.ts`
  - `createMultiTenantSqliteSessionStore({ db, userId })`
  - `createNodeKvStore({ dir })` — per-user
  - `createNodeScriptExecutor()`
  - `createJustBashTerminal()` (just-bash)
  - `createNodePackageExtensionLoader()`
  - `mcpConnectionProvider: serverStore.providerFor(userId)` — `ServerMcpStore` from `server/mcp/server-mcp-store.ts` is the bridge that keeps MCP connections alive across the per-turn rebuilds
- **ACP transport**:
  - HTTP+SSE: `AgentSideConnection` instantiated per request in `server/acp/handler.ts`, paired with `createHttpAcpConn()` (`server/acp/http-acp-conn.ts`). Notifications forwarded via `extNotification` to SSE writer.
  - WebSocket sibling: `server/auth/upgrade.ts` + `server/agent/wire-agent-ws.ts` provide a persistent path that doesn't re-build per turn — same `bodhi-pi` agent, different lifetime profile.
  - Client side: `frontend/lib/acp-http-client.ts` + `frontend/lib/sse-parser.ts` + `frontend/lib/ws/transport.ts`.
- **Host vs Client (per-file)**:

| File | Side | Sub-folder target | Role |
|---|---|---|---|
| `src/server/index.ts` | host | `host/` | Node HTTP entry |
| `src/server/server.ts` | host | `host/` | Server boot orchestration |
| `src/server/cli-args.ts` (+`.test.ts`) | host | `host/` | Server-side CLI flag parsing |
| `src/server/static.ts` | host | `host/` | Static asset serving |
| `src/server/provision.ts` | host | `host/` | Per-user workspace + KV/SQLite provisioning |
| `src/server/agent/wire-agent.ts` | host | `host/` | Per-request agent factory |
| `src/server/agent/wire-agent-shared.ts` | host | `host/` | `buildAgentFactory()` — adapter wiring shared across HTTP+WS |
| `src/server/agent/wire-agent-ws.ts` | host | `host/` | WebSocket sibling agent factory (long-lived) |
| `src/server/acp/handler.ts` | host | `host/` | HTTP request → `AgentSideConnection` |
| `src/server/acp/http-acp-conn.ts` | host | `host/` | HTTP+SSE ACP transport adapter (server side) |
| `src/server/acp/sse.ts` (+`.test.ts`) | host | `host/` | SSE writer |
| `src/server/acp/inflight.ts` (+`.test.ts`) | host | `host/` | Per-request inflight tracking |
| `src/server/auth/middleware.ts` (+`.test.ts`) | host | `host/` | Auth middleware |
| `src/server/auth/token.ts` (+`.test.ts`) | host | `host/` | Token issuance/validation |
| `src/server/auth/upgrade.ts` | host | `host/` | WebSocket upgrade auth |
| `src/server/filesystem/user-workspace.ts` | host | `host/` | Per-user FS root resolution |
| `src/server/mcp/server-mcp-store.ts` | host | `host/` | Per-user `McpConnectionProvider` (D11 reference impl) |
| `src/server/transport/ws-stream.ts` | host | `host/` | Server-side WebSocket stream adapter |
| `src/frontend/main.tsx` | client | `client/react/` | React root |
| `src/frontend/App.tsx` | client | `client/react/` | App component |
| `src/frontend/index.html` | client | `client/react/` | HTML shell |
| `src/frontend/index.css` | client | `client/react/` | Styles |
| `src/frontend/adapter-http.ts` | client | `client/acp/` | HTTP+SSE `TransportAdapter` |
| `src/frontend/adapter-ws.ts` | client | `client/acp/` | WebSocket `TransportAdapter` |
| `src/frontend/lib/acp-http-client.ts` | client | `client/acp/` | ACP-over-HTTP client primitives |
| `src/frontend/lib/sse-parser.ts` (+`.test.ts`) | client | `client/acp/` | SSE parser |
| `src/frontend/lib/ws/auth.ts` | client | `client/acp/` | WS auth handshake (client side) |
| `src/frontend/lib/ws/transport.ts` | client | `client/acp/` | WS `Transport` adapter |
| `src/frontend/lib/ws/ws-stream.ts` | client | `client/acp/` | WS stream wiring |
| `src/frontend/lib/event-log.ts` | client | `client/lib/` | Dev-only event log buffer |

No straddling files. Note: `adapter-http.ts` + `adapter-ws.ts` are two parallel transports — kept as separate files by design; do not consolidate.

- **Quirks**: Per-turn rebuild = the agent is **stateless across requests**. State durability lives entirely in `SessionStore`, `KvStore`, `ServerMcpStore`. Validates the rest of the codebase's "no hidden in-memory state" discipline.

## browser (`test-apps/browser/`)

- **Entrypoint**: `src/frontend/main.tsx` (React root). Web Worker at `src/frontend/worker.ts`.
- **Agent construction** (in Web Worker): `src/ui-lib/runtime/bootstrap-worker.ts:209` calls `createBodhiPiAgent({...})` with:
  - `createZenfsFilesystem()` (ZenFS InMemory)
  - `createDexieSessionStore({ dbName })` (IndexedDB)
  - `createDexieKvStore({ dbName })` (IndexedDB; two-table secret segregation `kv` + `kv_secret`)
  - `createBrowserScriptExecutor()` OR `createSandboxedBrowserScriptExecutor()` when a sandbox port is provided
  - `createJustBashTerminal(Bash)` — browser-safe just-bash
  - `createBrowserExtensionLoader()` OR `createSandboxedBrowserExtensionLoader()`
  - `createInProcessMcpConnectionProvider()`
  - `supportsMcpStdio: false`
- **ACP transport**:
  - HOST (Worker side): `AgentSideConnection` wired to `ndJsonStream(writable, readable)` derived from `createMessagePortStream(agentPort)` (`ui-lib/transport/message-port-stream.ts`).
  - Client (main thread): receives `agentPort: MessagePort` from worker init message, runs `ClientSideConnection` to the same ndjson stream.
- **Host vs Client (per-file)**:

| File | Side | Sub-folder target | Role |
|---|---|---|---|
| `src/frontend/worker.ts` | host | `host/` | Web Worker entry; runs `bootstrapAgentWorker()` |
| `src/ui-lib/runtime/bootstrap-worker.ts` | host | `ui-lib/host/` | Worker boot: ZenFS mount + adapter wiring + `createBodhiPiAgent` |
| `src/ui-lib/runtime/adapter.ts` | host | `ui-lib/host/` | `createTransportAdapter({workerFactory, createSandboxPort?})` builder |
| `src/ui-lib/runtime/types.ts` | host | `ui-lib/host/` | Worker init message + bootstrap option types |
| `src/ui-lib/runtime/wire-tap.ts` | host | `ui-lib/host/` | Optional ndjson wire-tap for dev observability |
| `src/ui-lib/filesystem/zenfs-filesystem.ts` | host | `ui-lib/host/` | ZenFS `Filesystem` adapter (Host-injected dep) |
| `src/ui-lib/sessions/dexie-session-store.ts` | host | `ui-lib/host/` | Dexie `SessionStore` adapter |
| `src/ui-lib/sessions/db.ts` | host | `ui-lib/host/` | Dexie schema definition |
| `src/ui-lib/kv/dexie-kv-store.ts` | host | `ui-lib/host/` | Dexie `KvStore` adapter (two-table secret segregation) |
| `src/ui-lib/script-executor/browser-script-executor.ts` | host | `ui-lib/host/` | AsyncFunction `ScriptExecutor` |
| `src/ui-lib/script-executor/sandboxed-browser-script-executor.ts` | host | `ui-lib/host/` | Sandbox-bridged `ScriptExecutor` for MV3 |
| `src/ui-lib/extensions/browser-extension-loader.ts` | host | `ui-lib/host/` | Data-URL ESM extension loader |
| `src/ui-lib/extensions/sandboxed-browser-extension-loader.ts` | host | `ui-lib/host/` | Sandbox-bridged extension loader |
| `src/ui-lib/sandbox/sandbox-bridge.ts` | host | `ui-lib/host/` | Worker-side bridge to the MV3 sandbox iframe |
| `src/ui-lib/lib/worker-fs-bridge.ts` | host | `ui-lib/host/` | Worker-side FS-API bridge (used by `runtime/adapter.ts`) |
| `src/ui-lib/lib/workspace-constants.ts` | shared | `ui-lib/host/` (used at construction only) | Constants — currently consumed only by Host runtime; treat as Host-side until a Client need arises |
| `src/ui-lib/transport/message-port-stream.ts` | shared | `ui-lib/host/` (Host owns the worker side; Client reuses) | `createMessagePortStream` produces a `Stream` pair used by BOTH `AgentSideConnection` (worker/Host) AND `ClientSideConnection` (main thread). The factory itself can be reused from `ui-lib/host/` by importers; the seam is the MessagePort, not this file |
| `src/frontend/main.tsx` | client | `client/react/` | React root (main thread) |
| `src/frontend/App.tsx` | client | `client/react/` | App component |
| `src/frontend/index.html` | client | `client/react/` | HTML shell |
| `src/frontend/adapter.ts` | client | `client/acp/` | Creates `TransportAdapter` wired to the worker |
| `src/frontend/lib/crypto-shim.ts` | client | `client/lib/` | Frontend-bundled SubtleCrypto polyfill |
| `src/ui-lib/ui/AppShell.tsx`, `ChatPanel.tsx`, `DevAcpIo.tsx`, `ErrorBanner.tsx`, `EventsPanel.tsx`, `SetupForm.tsx`, `StatusBar.tsx`, `WirePanel.tsx` | client | `ui-lib/client/react/` | React components |
| `src/ui-lib/ui/app-shell.css` | client | `ui-lib/client/react/` | Styles |
| `src/ui-lib/ui/commands.ts` | client | `ui-lib/client/lib/` | Client-side slash command bindings (uses raw `ClientSideConnection`; not yet `BodhiPiClient` — see `client-sdk-seed.md` § Current consumers) |
| `src/ui-lib/ui/index.ts` | client | `ui-lib/client/` | Barrel re-exports |
| `src/ui-lib/ui/transport.ts` | client | `ui-lib/client/acp/` | Defines `TransportAdapter`, `ConnectCallbacks`, `ConnectResult`, `SetupFormValues` — interface types **candidate for promotion to `test-apps/app-utils/`** (the host/client split prompt's "Shared interface types" task) |
| `src/ui-lib/lib/frame-log.ts` | client | `ui-lib/client/lib/` | Dev-only frame log (consumed by WirePanel/EventsPanel/AppShell + ui/transport.ts) |
| `src/ui-lib/lib/slash-router.ts` | client | `ui-lib/client/lib/` | Slash command router (consumed by AppShell) |
| `src/ui-lib/lib/seed-parser.ts` | **straddles** | `ui-lib/client/lib/` (target — see note) | Pure parser of seed-file YAML/JSON. **Currently consumed by Host (`ui-lib/runtime/adapter.ts:21`) AND http Client (`http/src/frontend/adapter-http.ts`).** Per user decision (host/client split prompt § seed-parser), Host should receive already-parsed `seedFiles` via the worker init message; classification target = Client |

**Straddler count: 1** (`ui-lib/lib/seed-parser.ts`). Resolution deferred to the host/client folder-split prompt where Host's `runtime/adapter.ts` will be reshaped to consume parsed input rather than the parser itself.

- **Quirks**: Web Worker boundary forces every Agent/Client interaction through async message passing. ZenFS is async-only (vs Node's sync `fs`). Dexie schema migration is the upgrade path for SessionEntry shape changes. MCP slugs reconnect from KV on worker restart.

## chrome-ext (`test-apps/chrome-ext/`)

- **Entrypoint**: `src/main.tsx` (React root); `src/worker.ts` is the agent worker; `src/sandbox/sandbox.ts` is the MV3 sandbox iframe for unsafe-eval scripts.
- **Agent construction**: identical to browser via `bootstrapAgentWorker()` from `test-apps/browser`. Differences:
  - Sandboxed script executor + extension loader because MV3 CSP forbids `unsafe-eval` in the service worker — eval routed through the sandbox iframe.
  - Crypto shim (`src/agent/crypto-shim.ts`) for `SubtleCrypto` in the sandbox context.
- **ACP transport**: `MessagePort` ndjson over chrome runtime messaging; same `createMessagePortStream` as browser.
- **Host vs Client (per-file)**:

| File | Side | Sub-folder target | Role |
|---|---|---|---|
| `src/worker.ts` | host | `host/` | MV3 service-worker entry; runs `bootstrapAgentWorker()` from browser ui-lib |
| `src/sandbox/sandbox.ts` | host | `host/` | MV3 sandbox iframe page (runs user-supplied scripts via unsafe-eval — the only place this is allowed in MV3) |
| `src/agent/crypto-shim.ts` | host | `host/` | SubtleCrypto polyfill bundled into the worker + sandbox pages (vite injects via `vite.config.ts`) |
| `src/main.tsx` | client | `client/react/` | React root (popup main thread) |
| `src/App.tsx` | client | `client/react/` | App component |
| `src/adapter.ts` | client | `client/acp/` | `createChromeExtAdapter()` — `TransportAdapter` over chrome runtime messaging |
| `src/agent/sandbox.ts` | client | `client/acp/` | `createSandboxPort()` — runs on **main thread**; creates the sandbox iframe and returns a `MessagePort` the Host can use. **Naming hack**: the `agent/` folder is misleading because this file is Client-side infrastructure (the port factory runs in the popup, not the worker). Per user decision (Phase 1 grilling), do NOT rename; documented here so the role is clear |

Plus all `host/` and `client/` files inherited from `test-apps/browser/src/ui-lib/{host,client}/`.

**Naming collision (do not rename per user decision):** `src/agent/sandbox.ts` (port factory, runs on main thread) AND `src/sandbox/sandbox.ts` (MV3 iframe page). Different roles, identical basename — the table above is the canonical reference for which is which.

- **Quirks**: MV3 service worker shutdown ≈ Dexie + KV persistence assumption. Sandbox iframe is the only place arbitrary user-supplied JS (skill scripts, extension factories) can execute. Identity OAuth flows would land on `chrome.identity.launchWebAuthFlow` (if/when OAuth is re-introduced).

## Shared test infrastructure

These two packages provide adapter implementations consumed by Hosts and integration tests. They are **not** Hosts — they construct no agent themselves.

### `test-apps/node-adapters/` — `@bodhiapp/bodhi-pi-test-app-node-adapters`

Node-side adapter implementations.

Exports:
- `createNodeFilesystem()`
- `createNodeKvStore()`
- `createNodeScriptExecutor()`
- `createSingleTenantSqliteSessionStore()`, `createMultiTenantSqliteSessionStore()`, `Db`, `upsertUser`
- `createNodePackageExtensionLoader()`
- `createBashTerminal()`

Consumers: `test-apps/cli/` (single-tenant SQLite, single-user KV/FS), `test-apps/http/` (multi-tenant SQLite, per-user KV/FS).

### `test-apps/app-utils/` — `@bodhiapp/bodhi-pi-test-app-utils`

Cross-runtime utilities.

Exports:
- `pickDefined` — strips undefined fields from config objects
- `createJustBashTerminal()` — wraps just-bash for Node + browser-safe terminal
- `createJustBashFsAdapter()` — filesystem adapter via just-bash

Consumers: all four Hosts.

## Adding a new Host

If a future Host is added (e.g. a desktop Electron wrapper or a Bun-native CLI), it must:

1. Implement (or reuse) adapters for `Filesystem`, `SessionStore`, optionally `KvStore`, `ScriptExecutor`, `Terminal`, `McpConnectionProvider`.
2. Choose an ACP transport — anything that gives an async byte stream pair (stdio, MessagePort, WebSocket, HTTP+SSE).
3. Set `supportsMcpStdio` correctly. Wrong value here = silent UX bug (`add` succeeds but `connect` fails later).
4. Pass `extensionFactories` discovered by the runtime's own discovery mechanism (Node: `jiti`; browser: data-URL ESM).
5. Mirror the **Host vs Client** folder split — `src/{host,client}/` with canonical `client/{react,acp,deps,lib}/` sub-folders. See the kickoff prompt at `ai-docs/prompts/2026-05-17-bodhi-pi-test-apps-host-client-split.md`.

## See also

- [architecture.md § Per-Host runtime matrix](./architecture.md#per-host-runtime-matrix) — high-level matrix.
- [mcp.md § Multi-tenant story](./mcp.md#multi-tenant-story-http-reference-host) — why http has a custom `McpConnectionProvider`.
- [testing.md](./testing.md) — which Hosts run which test layer.
- `ai-docs/plans/cli-m4-parity-with-bodhi-pi-and-web.md` — historical CLI parity push.
- `ai-docs/plans/web-m17-chrome-ext.md` — chrome-ext addition + browser→shared-infra reversal.
