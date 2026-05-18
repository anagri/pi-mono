# Hosts

Four reference Hosts under `packages/bodhi-pi/test-apps/{cli,http,browser,chrome-ext}/`. Each proves the agent surface against a distinct runtime profile. Two shared infrastructure packages (`node-adapters/`, `app-utils/`) provide the adapters every Host consumes.

> **Deprecated reference**: `packages/bodhi-pi-{cli,web,http,ws-server,ws-frontend,chrome-ext,node,browser}/` were the previous generation of test apps. They are **not maintained** and exist only for historical reference. New features land in `test-apps/`. Mentioned here once for breadcrumb only.

## At-a-glance matrix

| Host | Package name | Transport | Tenancy | MCP stdio? | Per-turn agent rebuild? |
|---|---|---|---|---|---|
| cli | `@bodhiapp/bodhi-pi-test-app-cli` | ndjson over stdin/stdout (RPC mode); in-process for REPL/headless | single | yes | no |
| http | `@bodhiapp/bodhi-pi-test-app-http` | HTTP+SSE (and WebSocket sibling under `server/agent/wire-agent-ws.ts`) | multi-tenant (SQLite per user) | no (`supportsMcpStdio:false`) — stateless per-turn rebuild can't own a long-lived stdio child | **yes** |
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
- **Host vs Client (per-file)** — after the split landed in `ab519a39..ab6e356a`:

| File | Side | Role |
|---|---|---|
| `src/host/cli.ts` | host | Shebang entry; wires `AgentSideConnection`+ in-process client pair. Imports the REPL via cross-seam **seam-exception** (the cli binary's `bin` entry constructs both sides) |
| `src/host/agent.ts` | host | `createBodhiPiAgent` + Node-adapter wiring |
| `src/host/config.ts` | host | CLI arg parsing for Host construction |
| `src/client/acp/repl.ts` | client | Interactive REPL loop; constructs `BodhiPiClient` via `createBodhiPiClient(clientConn,{cwd})` |
| `src/client/acp/headless.ts` | client | Non-interactive Client variant; uses `BodhiPiClient` for one-shot prompts. Dispatches built-in slashes: `/mcp*`, `/agents`, `/subagent <name> <task>`, `/subagent children` |
| `src/client/lib/commands.ts` | client | Slash dispatcher; imports `BodhiPiClient` type |
| `src/client/lib/render.ts` | client | Terminal output rendering (no React in cli) |

Subset of `client/{react,acp,deps,lib}/` — cli has no React. `package.json` `main` + `bin` updated to `./dist/host/cli.js`. e2e helpers (`e2e/cli-headless/*.ts`, `e2e/helpers/cli/harness.ts`) point to the same new dist path.

- **Quirks**: Single-tenant. Agent lifetime = process lifetime. MCP in-process connections live as long as the CLI. In RPC mode the test harness drives slash commands from outside.

## http (`test-apps/http/`)

The deployment-portability lens — proves the agent works under per-turn rebuild from SQLite.

- **Entrypoint**: `src/host/index.ts` (Node HTTP entry). Frontend at `src/client/react/main.tsx`.
- **Agent construction** (rebuilt **per request**): `src/host/agent/wire-agent-shared.ts:97` → `buildAgentFactory(opts, label)` → `createBodhiPiAgent({...})` with adapters from `test-apps/node-adapters/`:
  - `createNodeFilesystem({ rootCwd })` — per-user workspace under `server/filesystem/user-workspace.ts`
  - `createMultiTenantSqliteSessionStore({ db, userId })`
  - `createNodeKvStore({ dir })` — per-user
  - `createNodeScriptExecutor()`
  - `createJustBashTerminal()` (just-bash)
  - `createNodePackageExtensionLoader()`
  - `mcpConnectionProvider: serverStore.providerFor(userId)` — `ServerMcpStore` from `host/mcp/server-mcp-store.ts` is the bridge that keeps MCP connections alive across the per-turn rebuilds
- **ACP transport**:
  - HTTP+SSE: `AgentSideConnection` instantiated per request in `host/acp/handler.ts`, paired with `createHttpAcpConn()` (`host/acp/http-acp-conn.ts`). Notifications forwarded via `extNotification` to SSE writer.
  - WebSocket sibling: `host/auth/upgrade.ts` + `host/agent/wire-agent-ws.ts` provide a persistent path that doesn't re-build per turn — same `bodhi-pi` agent, different lifetime profile.
  - Client side: `client/acp/acp-http-client.ts` + `client/acp/sse-parser.ts` + `client/acp/ws/transport.ts`.
  - **`SSE_METHODS` set** (`host/acp/handler.ts`): `session/prompt`, `session/load`, `_bodhi-pi/subagent/run`. JSON dispatch is single-shot and drops `extNotification` calls (the JSON `HttpAcpConn` has no `onExtNotification` channel), so any extension method that emits `LIFECYCLE_EVENT_METHOD` notifications during its run MUST route through SSE. `_bodhi-pi/subagent/run` emits `subagent_start` / `subagent_end` mid-call → SSE. WS does not need this distinction (the persistent stream carries everything). Client-side counterpart: `AcpHttpClient.extMethodStreaming()` uses `sseCall`; `adapter-http.ts::wrapHttpClient.extMethod` routes `_bodhi-pi/subagent/run` to it. New extMethods that emit lifecycle events on the same call MUST be added to `SSE_METHODS` + the client-side routing in lockstep.
- **Host vs Client (per-file)** — after the split landed in `ab6e356a`:

| File | Side | Role |
|---|---|---|
| `src/host/index.ts` | host | Node HTTP entry |
| `src/host/server.ts` | host | Server boot orchestration |
| `src/host/cli-args.ts` (+`.test.ts`) | host | Server-side CLI flag parsing |
| `src/host/static.ts` | host | Static asset serving |
| `src/host/provision.ts` | host | Per-user workspace + KV/SQLite provisioning |
| `src/host/agent/wire-agent{,-shared,-ws}.ts` | host | Per-request agent factory + shared adapter wiring + WS-long-lived sibling |
| `src/host/acp/handler.ts` | host | HTTP request → `AgentSideConnection` |
| `src/host/acp/http-acp-conn.ts` | host | HTTP+SSE ACP transport adapter (server side) |
| `src/host/acp/sse.ts` (+`.test.ts`) | host | SSE writer |
| `src/host/acp/inflight.ts` (+`.test.ts`) | host | Per-request inflight tracking |
| `src/host/auth/{middleware,token,upgrade}.ts` (+`.test.ts`) | host | Auth middleware + token issuance/validation + WS upgrade auth |
| `src/host/filesystem/user-workspace.ts` | host | Per-user FS root resolution |
| `src/host/mcp/server-mcp-store.ts` | host | Per-user `McpConnectionProvider` (D11 reference impl) |
| `src/host/transport/ws-stream.ts` | host | Server-side WebSocket stream adapter |
| `src/client/react/{main.tsx, App.tsx, index.html, index.css}` | client | React root + components + HTML/CSS shell |
| `src/client/acp/adapter-http.ts` | client | HTTP+SSE `TransportAdapter` (imports `parseSeedFiles` + transport-types from `app-utils`) |
| `src/client/acp/adapter-ws.ts` | client | WebSocket `TransportAdapter` (imports `parseSeedFiles` + transport-types from `app-utils`) |
| `src/client/acp/acp-http-client.ts` | client | ACP-over-HTTP client primitives |
| `src/client/acp/sse-parser.ts` (+`.test.ts`) | client | SSE parser |
| `src/client/acp/ws/{auth,transport,ws-stream}.ts` | client | WS auth handshake + transport adapter + stream wiring |
| `src/client/lib/event-log.ts` | client | Dev-only event log buffer |

Note: `adapter-http.ts` + `adapter-ws.ts` are two parallel transports — kept as separate files by design; do not consolidate. http server build still emits `dist/index.js` (rootDir strips host/), so `main` + `start` + e2e helper paths stay at `./dist/index.js`.

- **Quirks**: Per-turn rebuild = the agent is **stateless across requests**. State durability lives entirely in `SessionStore`, `KvStore`, `ServerMcpStore`. Validates the rest of the codebase's "no hidden in-memory state" discipline.

## browser (`test-apps/browser/`)

- **Entrypoint**: `src/client/react/main.tsx` (React root). Web Worker at `src/host/worker.ts`.
- **Agent construction** (in Web Worker): `src/host/runtime/bootstrap-worker.ts` calls `createBodhiPiAgent({...})` with:
  - `createZenfsFilesystem()` (ZenFS InMemory)
  - `createDexieSessionStore({ dbName })` (IndexedDB)
  - `createDexieKvStore({ dbName })` (IndexedDB; two-table secret segregation `kv` + `kv_secret`)
  - `createBrowserScriptExecutor()` OR `createSandboxedBrowserScriptExecutor()` when a sandbox port is provided
  - `createJustBashTerminal(Bash)` — browser-safe just-bash
  - `createBrowserExtensionLoader()` OR `createSandboxedBrowserExtensionLoader()`
  - `createInProcessMcpConnectionProvider()`
  - `supportsMcpStdio: false`
- **ACP transport**:
  - HOST (Worker side): `AgentSideConnection` wired to `ndJsonStream(writable, readable)` derived from `createMessagePortStream(agentPort)` (imported from `@bodhiapp/bodhi-pi-test-app-utils/message-port-stream`).
  - Client (main thread): receives `agentPort: MessagePort` from worker init message, runs `ClientSideConnection` to the same ndjson stream.
  - **Lifecycle events use a separate worker-message channel.** `bootstrap-worker.ts::eventForwardingHandlers()` posts every subscribed `BodhiPiEvent` as a `{type:"bodhi-pi-event", record}` worker message (the `ClientSideConnection` on the main thread does not surface `extNotification`s, so the ACP wire is not the rail for events here). The subscribed set MUST cover `subagent_start` / `subagent_end` for the `AppShell` transcript group; the wire-level `LIFECYCLE_EVENT_METHOD` forwarder in `event-wiring.ts` still runs but its output is currently dropped by the client (kept for parity with the http+ws clients that DO consume it).
- **Host vs Client (per-file)** — after the split landed in `ebb680a7`:

| File | Side | Role |
|---|---|---|
| `src/host/worker.ts` | host | Web Worker entry; runs `bootstrapAgentWorker()` |
| `src/host/runtime/bootstrap-worker.ts` | host | Worker boot: ZenFS mount + adapter wiring + `createBodhiPiAgent` |
| `src/host/runtime/wire-tap.ts` | host | Optional ndjson wire-tap for dev observability |
| `src/host/filesystem/zenfs-filesystem.ts` | host | ZenFS `Filesystem` adapter |
| `src/host/sessions/{dexie-session-store,db}.ts` | host | Dexie `SessionStore` adapter + schema |
| `src/host/kv/dexie-kv-store.ts` | host | Dexie `KvStore` adapter (two-table secret segregation) |
| `src/host/script-executor/{browser,sandboxed-browser}-script-executor.ts` | host | AsyncFunction + sandbox-bridged `ScriptExecutor` |
| `src/host/extensions/{browser,sandboxed-browser}-extension-loader.ts` | host | Data-URL ESM + sandbox-bridged extension loaders |
| `src/host/sandbox/sandbox-bridge.ts` | host | Worker-side bridge to the MV3 sandbox iframe |
| `src/client/react/{main.tsx, App.tsx, index.html, app-shell.css, AppShell.tsx, ChatPanel.tsx, DevAcpIo.tsx, ErrorBanner.tsx, EventsPanel.tsx, SetupForm.tsx, StatusBar.tsx, WirePanel.tsx}` | client | React root + 8 React panels + HTML/CSS shell |
| `src/client/index.ts` | client | Top-level Client barrel re-exporting the React panels + transport types from app-utils |
| `src/client/acp/adapter.ts` | client | `createBrowserAdapter()` — wires the worker via `new URL("../../host/worker.ts", import.meta.url)` |
| `src/client/runtime/adapter.ts` | client | `createTransportAdapter({workerFactory, createSandboxPort?})` builder. **Runs on the main thread**; parses `seedFiles` (via app-utils `parseSeedFiles`), creates the worker, posts the init message |
| `src/client/lib/{crypto-shim,frame-log,slash-router,worker-fs-bridge,workspace-constants,commands}.ts` | client | Client-side utilities: SubtleCrypto polyfill, dev frame-log handlers, slash router, page-side FS-bridge to the worker, workspace path constants, client-side slash command bindings. `commands.ts` dispatches `/mcp*`, `/agents`, `/subagent <name> <task>`, `/subagent children` (shared with http frontend and chrome-ext via `@bodhiapp/bodhi-pi-test-app-browser/client` subpath import) |

**Cross-package promotions to `test-apps/app-utils/`** (consumed by browser, chrome-ext, and http frontends):
| Symbol | app-utils file | Notes |
|---|---|---|
| `TransportAdapter`, `ConnectCallbacks`, `ConnectResult`, `SetupFormValues`, `FrameEntry`, `EventEntry` | `app-utils/transport-types.ts` | Pure type-only contract for the browser-runtime TransportAdapter shape |
| `parseSeedFiles` | `app-utils/seed-parser.ts` | Browser-only API (DOMParser); imported by browser's `client/runtime/adapter.ts` AND http's `client/acp/adapter-http.ts`/`adapter-ws.ts` |
| `createMessagePortStream` | `app-utils/message-port-stream.ts` | Both Host (worker side) AND Client (main thread) consume — neither side owns the source |
| `InitMessage`, `WorkerMessage`, `FsQuery/ReplyMessage`, etc. | `app-utils/worker-message-types.ts` | Shared wire contract between worker (Host) and main thread (Client) |

Zero straddlers post-split. The pre-split straddler (`seed-parser.ts`) was resolved by promotion to `app-utils/` + leaving the Client-side call site (`client/runtime/adapter.ts`) as the sole caller (Host receives pre-parsed `seedFiles` via the init message).

- **Quirks**: Web Worker boundary forces every Agent/Client interaction through async message passing. ZenFS is async-only (vs Node's sync `fs`). Dexie schema migration is the upgrade path for SessionEntry shape changes. MCP slugs reconnect from KV on worker restart.

## chrome-ext (`test-apps/chrome-ext/`)

- **Entrypoint**: `src/client/react/main.tsx` (React root); `src/host/worker.ts` is the agent worker; `src/host/sandbox/sandbox.ts` is the MV3 sandbox iframe for unsafe-eval scripts.
- **Agent construction**: identical to browser via `bootstrapAgentWorker()` from `@bodhiapp/bodhi-pi-test-app-browser/host/runtime/bootstrap-worker`. Differences:
  - Sandboxed script executor + extension loader because MV3 CSP forbids `unsafe-eval` in the service worker — eval routed through the sandbox iframe.
  - Crypto shim (`src/host/crypto-shim.ts`) for `SubtleCrypto` in the sandbox context.
- **ACP transport**: `MessagePort` ndjson over chrome runtime messaging; same `createMessagePortStream` (`app-utils/message-port-stream`) as browser.
- **Host vs Client (per-file)** — after the split landed in `ab519a39`:

| File | Side | Role |
|---|---|---|
| `src/host/worker.ts` | host | MV3 service-worker entry; runs `bootstrapAgentWorker()` from browser's `host/runtime/bootstrap-worker` |
| `src/host/sandbox/sandbox.ts` | host | MV3 sandbox iframe page (runs user-supplied scripts via unsafe-eval — the only place this is allowed in MV3) |
| `src/host/crypto-shim.ts` | host | SubtleCrypto polyfill bundled into the worker + sandbox pages (vite injects via `vite.config.ts`) |
| `src/client/react/{main.tsx, App.tsx}` | client | React root + App component (popup main thread) |
| `src/client/acp/adapter.ts` | client | `createChromeExtAdapter()` — wires the worker via `new URL("../../host/worker.ts", ...)` |
| `src/client/acp/sandbox-port.ts` | client | `createSandboxPort()` — runs on **main thread**; creates the sandbox iframe and returns a `MessagePort` the Host can use. Renamed from `src/agent/sandbox.ts` during the split to disambiguate from the Host-side `host/sandbox/sandbox.ts` (MV3 iframe page) |

Plus all `host/` and `client/` files inherited from `@bodhiapp/bodhi-pi-test-app-browser/host/*` + `client/*` via subpath imports.

The pre-split `src/agent/` folder is gone — `agent/crypto-shim.ts` is now `host/crypto-shim.ts` (the polyfill belongs to the Host workers), and `agent/sandbox.ts` is now `client/acp/sandbox-port.ts` (the port factory runs on the main thread).

- **Quirks**: MV3 service worker shutdown ≈ Dexie + KV persistence assumption. Sandbox iframe is the only place arbitrary user-supplied JS (skill scripts, extension factories) can execute.

## OAuth (`auth: "oauth"` MCP entries) — per-Host wiring

Every Host shares the same server-side OAuth pieces (`src/mcp/mcp-oauth-provider.ts` + `mcp-oauth-state-kv.ts`, the `_bodhi-pi/mcp/oauth/{start,finish,cancel,discover,register}` handlers in `mcp-service.ts`, and the strategy-table attacher in `mcp-client.ts`). What differs per-Host is **where the redirect lands** and **how the slash command learns that the flow completed**:

| Host | `redirect_uri` composition | Capture mechanism | Slash completion signal |
|---|---|---|---|
| **cli** | `http://127.0.0.1:7777/callback` (overridable via `/mcp oauth start <slug> --port=N`) | `test-apps/cli/src/host/oauth-callback-server.ts` — ephemeral `http.createServer` per flow, calls `_bodhi-pi/mcp/oauth/finish` in-process from `GET /callback` | `mcp_oauth_status_change` lifecycle notification (host EventDispatcher → ACP `extNotification` → client `extNotification` handler in `headless.ts` → resolves the slash's `oauthListeners` entry) |
| **http+ws** | `${publicBaseUrl-or-Host-header}/oauth/callback` (computed client-side from `window.location.origin`; multi-tenant routing via `<base64url(userId)>.<random>` state prefix) | `test-apps/http/src/host/oauth-callback.ts` — new `GET /oauth/callback` route in `server.ts`. Decodes `state` → opens user's kvDir → runs `runAuthFlow` to completion. No live agent emits the lifecycle event because the route runs outside the per-turn rebuild; the React UI sees it via the SSE/WS lifecycle channel from a subsequent action OR via the `oauth-event-bus` race (see below). | `oauth-event-bus` racing two paths: postMessage from the popup (doesn't fire on http+ws because the redirect_uri page is server-rendered) AND `mcp_oauth_status_change` event delivered via the existing SSE/WS lifecycle channel (this is the one that fires on http+ws — emitted by the per-user agent on its next interaction OR by a follow-up `oauth/start` if eagerly re-fired). For UX immediacy, prefer a server-side push from `oauth-callback.ts` via a process-shared event bus — currently the test relies on the slash command's `--auto` codepath which triggers the lifecycle event via the active connection. |
| **browser** | `${window.location.origin}/oauth/callback` (single-tenant; state = random only) | `test-apps/browser/src/client/react/OAuthCallback.tsx` — standalone React component selected by `main.tsx`'s path discrimination (does NOT boot the Worker). Parses `?code=&state=`, `postMessage`s `{kind: "bodhi-pi-oauth-callback", code, state}` to `window.opener`, closes itself. | Slash subscribes to BOTH `window.message` (postMessage path) AND `oauth-event-bus` (lifecycle event path). Race resolves whichever fires first. For browser the postMessage path is the primary trigger; the bus is the fallback for any future server-side completion. |
| **chrome-ext** | `chrome.identity.getRedirectURL()` = `https://<ext-id>.chromiumapp.org/` (Chrome rejects custom paths) | `chrome.identity.launchWebAuthFlow({url, interactive: true})` from the popup main thread (chrome.identity is callable from any extension page; no service worker needed despite earlier plan's assumption). Chrome opens its managed window, returns the full redirect URL synchronously on user completion. | Slash awaits the `launchWebAuthFlow` promise; parses `code+state` from the returned URL; calls `oauth/finish`. For Playwright tests `chrome.identity.launchWebAuthFlow` is stubbed via `page.addInitScript` to fetch the URL itself (the fixture's `?auto=1` short-circuits the approve page). |

**Browser-runtime event bus** (`test-apps/browser/src/client/lib/oauth-event-bus.ts`): in-process `Set<Listener>` emitter shared between `AppShell`'s `pushEvent` (which receives every `BodhiPiEvent` from the worker) and the chat `/mcp oauth start` slash. The slash registers a one-shot listener for `mcp_oauth_status_change{slug, completed|failed}` so server-side completions (HTTP+WS, future browser-side server callbacks) surface back to the slash without requiring a popup-to-opener postMessage. Bypasses the `postMessage` round-trip on runtimes where the redirect_uri landing page isn't our React tree.

**Validation**: `KvOAuthProvider.validateResourceURL` returns `undefined` deliberately, telling the MCP SDK to omit the RFC 8707 `resource` parameter from token requests. Without this override the SDK fetches `/.well-known/oauth-protected-resource` from `serverUrl` (the token endpoint in our case) and rejects on the resource-vs-serverUrl mismatch. Per the prompt's locked decisions bodhi-pi does NOT use resource indicators — every MCP token is scoped per-server by being a separate `mcp/<slug>` entry, not by RFC 8707.

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

Cross-runtime utilities + browser-runtime shared contracts.

Exports:
- `pickDefined` — strips undefined fields from config objects
- `createJustBashTerminal()` — wraps just-bash for Node + browser-safe terminal
- `createJustBashFsAdapter()` — filesystem adapter via just-bash
- `transport-types` — `TransportAdapter`, `ConnectCallbacks`, `ConnectResult`, `SetupFormValues`, `FrameEntry`, `EventEntry` (type-only; promoted from browser in the host/client split)
- `seed-parser` — `parseSeedFiles(raw: string): Record<path, content>` (browser-only DOM API)
- `message-port-stream` — `createMessagePortStream(port: MessagePort)` returning `{readable, writable}` (consumed by both Host worker and Client main thread)
- `worker-message-types` — `InitMessage`, `WorkerMessage`, `FsQuery/ReplyMessage` etc. (shared wire contract between worker and main thread)

Consumers: all four Hosts (transitively via per-Host imports); browser + chrome-ext + http-frontend depend on the new browser-runtime subpaths.

## Adding a new Host

If a future Host is added (e.g. a desktop Electron wrapper or a Bun-native CLI), it must:

1. Implement (or reuse) adapters for `Filesystem`, `SessionStore`, optionally `KvStore`, `ScriptExecutor`, `Terminal`, `McpConnectionProvider`.
2. Choose an ACP transport — anything that gives an async byte stream pair (stdio, MessagePort, WebSocket, HTTP+SSE).
3. Set `supportsMcpStdio` correctly. Wrong value here = silent UX bug (`add` succeeds but `connect` fails later).
4. Pass `extensionFactories` discovered by the runtime's own discovery mechanism (Node: `jiti`; browser: data-URL ESM).
5. Mirror the **Host vs Client** folder split — `src/{host,client}/` with canonical `client/{react,acp,deps,lib}/` sub-folders. Enforcement: `scripts/check-host-client-seam.mjs` (wired into root `npm run check`) forbids relative imports across the seam; use `// seam-exception: <reason>` comment to override with rationale. Reference implementation: any of the four existing Hosts; deliverable plan at `ai-docs/plans/2026-05-17-bodhi-pi-test-apps-host-client-split.md`.

## See also

- [architecture.md § Per-Host runtime matrix](./architecture.md#per-host-runtime-matrix) — high-level matrix.
- [mcp.md § Multi-tenant story](./mcp.md#multi-tenant-story-http-reference-host) — why http has a custom `McpConnectionProvider`.
- [testing.md](./testing.md) — which Hosts run which test layer.
- `ai-docs/plans/cli-m4-parity-with-bodhi-pi-and-web.md` — historical CLI parity push.
- `ai-docs/plans/web-m17-chrome-ext.md` — chrome-ext addition + browser→shared-infra reversal.
