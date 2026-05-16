# Client SDK seed (`src/client/`)

A thin, runtime-agnostic helper layer over ACP's `ClientSideConnection`. Exported from the `@bodhiapp/bodhi-pi` barrel today, **intended** as the seed of the future `@bodhiapps/bodhi-pi-client-common` package (the SDK extraction is not in flight; this doc documents the as-is surface).

## Why this exists

The raw ACP `ClientSideConnection` is a JSON-RPC peer — every request is `conn.extMethod("_bodhi-pi/foo/bar", params)`. That's fine for one-off calls; tedious for a UI that needs ~30 of them, each with shaped params/responses. `src/client/` collapses the boilerplate into typed methods (`bodhi.mcpAdd({…})`, `bodhi.model("gpt-4o")`, etc.) while leaving the transport entirely to the caller.

This is the **publishable seam** — when extracted to `@bodhiapps/bodhi-pi-client-common`, it becomes the cross-runtime base for `@bodhiapps/bodhi-pi-client-{node,http,websocket,browser,chrome-ext}`, each of which would add a transport-binding layer on top.

## Public surface (from `src/index.ts`)

| Export | From | Role |
|---|---|---|
| `BodhiPiClient` (class) | `src/client/client.ts:121` | The wrapper — ~35 typed methods over ACP |
| `createBodhiPiClient(acp, opts?)` | `src/client/client.ts:487` | Factory; returns a `BodhiPiClient` |
| `flattenModelOptions(option)` | `src/client/config-options.ts:5` | Pure helper — extracts `ModelOption[]` from one ACP `SessionConfigOption` |
| `modelConfigFromOptions(options)` | `src/client/config-options.ts:28` | Pure helper — extracts `{currentModelId, models, option?}` from `configOptions[]` |
| `parseMcpAddArgs(rest)` | `src/client/mcp-slash.ts:17` | Pure parser — turns `["--label","foo","https://…"]` into `ParsedMcpAdd` |
| `ParsedMcpAdd` | `src/client/mcp-slash.ts:2` | Parse result type |
| `BodhiPiClientOptions` | `src/client/types.ts:34` | Constructor options (`{cwd?}`) |

Plus ~70 request/response type re-exports from `src/client/types.ts` (`KvGetParams`, `McpAddResult`, `SettingsListResult`, …) — collectively the **shaped surface** for every `BodhiPiClient` method.

## What `BodhiPiClient` wraps

The constructor accepts a `BodhiPiAcpConnection` (`src/client/types.ts:21-32`) — a minimal interface that the real `ClientSideConnection` satisfies. So in tests you can pass an in-process pair; in production you pass the real connection.

Methods group into seven areas. See `src/client/client.ts` for full signatures.

| Area | Methods |
|---|---|
| Lifecycle | `newSession`, `loadSession`, `resumeSession`, `closeSession`, `prompt`, `cancel` |
| Session config (ACP-blessed) | `setConfigOption`, `model`, `models` |
| Sessions (extension) | `getSessionConfig`, `getSessionTree`, `listSessionEntries`, `getSessionStats`, `setSessionName`, `exportSession`, `compactSession`, `forkSession`, `cloneSession`, `navigateSession` |
| Auth / providers | `addProvider`, `removeProvider`, `getProvider`, `listProviders` |
| MCP | `mcpAdd`, `mcpRemove`, `mcpConnect`, `mcpDisconnect`, `mcpReconnect`, `mcpInclude`, `mcpExclude`, `mcpList`, `mcpTools` |
| KV | `kv.set`, `kv.get`, `kv.list`, `kv.remove` (sub-object) |
| Settings | `settings.list`, `settings.get`, `settings.set`, `settings.unset` (sub-object) |

Two convenience features:
- **Default cwd** — pass `opts.cwd` once at construction; calls that need `cwd` use it unless overridden.
- **Active session memory** — `BodhiPiClient` tracks the last `sessionId` it `newSession`/`loadSession`/`resumed`. Methods that need a sessionId default to it (`SessionRef` pattern).

## What it does NOT cover

- **Transport.** You construct the `ClientSideConnection` yourself (stdio, HTTP+SSE, WebSocket, MessagePort, in-process pair) and pass it in. The future transport-specific SDK packages would provide factories.
- **React or any UI.** Pure callable surface, no rendering.
- **Slash UX.** Slash routing, command discovery, and renderer logic live in each Reference Host's `client/` folder (e.g. `test-apps/cli/src/repl/`). The future `@bodhiapps/bodhi-pi-client-react` could add this.
- **Runtime adapters** (Filesystem, SessionStore, KvStore, etc.). Those are **Host** concerns — see [architecture.md § Dependency injection contract](./architecture.md#dependency-injection-contract). The Client never sees them; it talks to the Host over ACP.

## Seam with ACP SDK

The `@bodhiapp/bodhi-pi` barrel re-exports two ACP-SDK pieces alongside the client helpers (`src/index.ts:1`):

```ts
export { AgentSideConnection, ndJsonStream, type Stream } from "@agentclientprotocol/sdk";
```

`ClientSideConnection` itself is **not** re-exported — consumers import it directly from `@agentclientprotocol/sdk`. Everything else in `BodhiPiClient` is bodhi-pi-proprietary; it just speaks ACP at the wire level.

Wire constants (`MODEL_CONFIG_ID`, `EXT_*` method names) ARE re-exported from `@bodhiapp/bodhi-pi` so Clients can use the same constants the Agent uses. Source: `src/wire/constants.ts`.

## Current consumers

Verified at the time of writing:

| Host | Uses `BodhiPiClient`? | Notes |
|---|---|---|
| `test-apps/cli` | **yes** — `src/repl/{repl.ts,headless.ts,commands.ts}` | Constructs via `createBodhiPiClient(clientConn, {cwd})`. The most complete real-world consumer. |
| `test-apps/http` | no | `src/frontend/lib/acp-http-client.ts` uses raw `ClientSideConnection`. |
| `test-apps/browser` | no | `src/ui-lib/ui/commands.ts:17` carries a comment explaining the choice: "calls `ClientSideConnection` (not the publishable `BodhiPiClient`) so it stays …". |
| `test-apps/chrome-ext` | no | Inherits browser's UI layer. |

The cli precedent shows the SDK seed is **viable** for real Hosts. The browser comment is the explicit "future SDK" deferral — the browser Host wants to swap to `BodhiPiClient` once the package is published.

## Future SDK extraction roadmap (intent only)

Not in flight, not scoped here. Documented so future contributors see the target shape.

```
@bodhiapps/bodhi-pi-client-common         ← current src/client/ moves here
├── BodhiPiClient class + helpers
├── shaped request/response types
└── wire constant re-exports

@bodhiapps/bodhi-pi-client-node           ← stdio + in-process transport factories
@bodhiapps/bodhi-pi-client-http           ← HTTP+SSE transport
@bodhiapps/bodhi-pi-client-websocket      ← WebSocket transport
@bodhiapps/bodhi-pi-client-browser        ← MessagePort + worker boilerplate
@bodhiapps/bodhi-pi-client-chrome-ext     ← chrome runtime messaging + sandbox port factory
```

The host/client folder split (`ai-docs/prompts/2026-05-17-bodhi-pi-test-apps-host-client-split.md`) is the **prerequisite** for this extraction — once each Reference Host has a clean `src/client/` subfolder, the per-runtime client code becomes copy-and-publish into the corresponding npm package.

## See also

- [architecture.md § `src/` layout](./architecture.md) — `client/` placement in the package tree.
- `src/client/client.ts` — implementation.
- `src/client/types.ts` — full shaped surface.
- `src/index.ts` — barrel exports (what consumers see).
- `ai-docs/prompts/2026-05-17-bodhi-pi-test-apps-host-client-split.md` — the folder split that unblocks SDK extraction.
- `packages/bodhi-pi/test-apps/cli/src/repl/repl.ts:74` — `createBodhiPiClient(clientConn, {cwd})` reference call.
