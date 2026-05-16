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
- **Host vs Client**:
  - HOST: `cli.ts`, `agent.ts`, `config.ts`
  - CLIENT: `repl/repl.ts`, `repl/commands.ts`, `repl/render.ts`, `repl/headless.ts`
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
- **Host vs Client**:
  - HOST: `server/index.ts`, `server/server.ts`, `server/cli-args.ts`, `server/static.ts`, `server/provision.ts`, `server/agent/wire-agent*.ts`, `server/acp/*`, `server/auth/*`, `server/filesystem/user-workspace.ts`, `server/mcp/server-mcp-store.ts`, `server/transport/ws-stream.ts`
  - CLIENT: `frontend/main.tsx`, `frontend/App.tsx`, `frontend/adapter-http.ts`, `frontend/adapter-ws.ts`, `frontend/lib/*`, `frontend/index.html`, `frontend/index.css`
  - Split is clean — no mixed-concern files.
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
- **Host vs Client**:
  - HOST: `frontend/worker.ts`, `ui-lib/runtime/bootstrap-worker.ts`, `ui-lib/runtime/adapter.ts`, `ui-lib/runtime/types.ts`, `ui-lib/runtime/wire-tap.ts`
  - Adapters (HOST-side, reused by chrome-ext): `ui-lib/filesystem/zenfs-filesystem.ts`, `ui-lib/sessions/{dexie-session-store.ts, db.ts}`, `ui-lib/kv/dexie-kv-store.ts`, `ui-lib/script-executor/*`, `ui-lib/extensions/*`, `ui-lib/sandbox/sandbox-bridge.ts`
  - CLIENT: `frontend/main.tsx`, `frontend/App.tsx`, `frontend/adapter.ts`, `frontend/lib/crypto-shim.ts`, `ui-lib/ui/**/*.tsx`
- **Quirks**: Web Worker boundary forces every Agent/Client interaction through async message passing. ZenFS is async-only (vs Node's sync `fs`). Dexie schema migration is the upgrade path for SessionEntry shape changes. MCP slugs reconnect from KV on worker restart.

## chrome-ext (`test-apps/chrome-ext/`)

- **Entrypoint**: `src/main.tsx` (React root); `src/worker.ts` is the agent worker; `src/sandbox/sandbox.ts` is the MV3 sandbox iframe for unsafe-eval scripts.
- **Agent construction**: identical to browser via `bootstrapAgentWorker()` from `test-apps/browser`. Differences:
  - Sandboxed script executor + extension loader because MV3 CSP forbids `unsafe-eval` in the service worker — eval routed through the sandbox iframe.
  - Crypto shim (`src/agent/crypto-shim.ts`) for `SubtleCrypto` in the sandbox context.
- **ACP transport**: `MessagePort` ndjson over chrome runtime messaging; same `createMessagePortStream` as browser.
- **Host vs Client**:
  - HOST: `worker.ts`, `agent/sandbox.ts`, `agent/crypto-shim.ts`, `sandbox/sandbox.ts`
  - CLIENT: `main.tsx`, `App.tsx`, `adapter.ts`
  - Plus everything inherited from `test-apps/browser/src/ui-lib/`.
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
