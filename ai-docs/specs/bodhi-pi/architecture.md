# Architecture

bodhi-pi is an embeddable, runtime-agnostic ACP agent. Every platform concern is **injected** by the Host; the package itself owns the LLM loop, session state, ACP wire, and tool registry.

## The three roles

bodhi-pi has **three** roles — Agent, Host, Client — separated by the ACP Transport seam. **UI** (rendering layer) is a sub-concept inside Client, not a fourth peer role.

```
┌────────────────── Client ──────────────────────────────────────┐
│  ClientSideConnection peer (sends prompt/extMethod;            │
│  consumes sessionUpdate)                                       │
│  + UI: REPL · React app · chrome-ext page                      │
│  + transport-client adapters (http fetch+SSE / ws stream /     │
│    MessagePort)                                                │
│  Lives under test-apps/<host>/src/client/{react,acp,deps,lib}/ │
└────────────────────────────┬───────────────────────────────────┘
                             │ Transport (stdio / WS / HTTP+SSE /
                             │ MessagePort / in-process pair)
┌────────────────────────────▼ Host ─────────────────────────────┐
│  build deps → createBodhiPiAgent(config) → AgentSideConnection │
│  Adapters: Filesystem · SessionStore · KvStore ·               │
│            ScriptExecutor · Terminal · McpConnectionProvider · │
│            ExtensionFactories                                  │
│  Lives under test-apps/<host>/src/host/                        │
└────────────────────────────┬───────────────────────────────────┘
                             │ ACP method dispatch
┌────────────────────────────▼ Agent (BodhiPiAcpAgent) ──────────┐
│  ModelRegistry · McpService · KvService · SettingsService ·    │
│  SessionGraphService · SessionInfoService ·                    │
│  CompactionOrchestrator · ExtensionRunner · EventDispatcher    │
│  per-session: SessionState → pi-agent-core Agent → prompt loop │
└────────────────────────────────────────────────────────────────┘
```

In single-process Hosts (cli, browser-worker, chrome-ext) Host and Client run in the same OS process linked by an in-process or `MessagePort` Transport. In split Hosts (http) the Client runs in a browser tab; the Host lives in a Node.js server process; the Transport is HTTP+SSE or WebSocket.

## Dependency injection contract

`createBodhiPiAgent(config)` at `src/acp/agent.ts:150-158` is the only entry point. The `BodhiPiConfig` shape (`src/acp/agent.ts:67-119`):

| Field | Required | Purpose |
|---|---|---|
| `sessionStore` | yes — `src/acp/agent.ts:151` throws | Session CRUD/append/leaf/list |
| `filesystem` | yes — `src/acp/agent.ts:154` throws | Sandboxed FS for tools + project artefacts (AGENTS.md, `.bodhi-pi/`) |
| `kvStore` | optional | Auth keys (`auth/<provider>`), MCP entries (`mcp/<slug>`); ACP reads mask `secret:true` values |
| `scriptExecutor` | optional | When set, `run_script` built-in tool is registered |
| `terminal` | optional | When set, `bash` built-in tool is registered |
| `models`, `defaultModelId`, `getApiKey` | optional | Additive host model catalogue + default; pi-ai catalogue is filtered by stored auth |
| `extensionFactories` | optional | Pre-loaded extensions (Host discovers + wraps as `RegisteredExtension[]`) |
| `mcpConnectionProvider` | optional | Defaults to `createInProcessMcpConnectionProvider()`; multi-tenant Hosts inject per-user |
| `supportsMcpStdio` | optional, default `true` | When `false`, `_bodhi-pi/mcp/add` rejects `command=` with `-32601` |
| `homeDir`, `globalFilesystem` | optional, Node-only | Global settings layer at `<homeDir>/.bodhi-pi/settings.json` |
| `compaction`, `defaultThinkingLevel`, `systemPrompt`, `appendSystemPrompt` | optional | Host-explicit overrides |
| `eventHandlers`, `logger` | optional | Lifecycle hooks + non-fatal error sink |

**No silent defaults.** Factory throws at construction time when required fields are missing — the only exception is `systemPrompt` (falls back to the composed built-in prompt). See [`packages/bodhi-pi/CLAUDE.md`](../../../packages/bodhi-pi/CLAUDE.md) "Source code rules".

## Agent internal composition

The `BodhiPiAcpAgent` class at `src/acp/agent.ts:162-555` is a façade that delegates to seven services constructed in its constructor:

| Service | File | Owns |
|---|---|---|
| `ModelRegistry` | `src/models/registry.ts` | pi-ai catalogue filtering, auth-aware model resolution, `setSessionConfigOption` |
| `KvService` | `src/kv/kv-service.ts` | `_bodhi-pi/kv/{get,set,list,remove}` + secret masking |
| `McpService` | `src/mcp/mcp-service.ts` | `_bodhi-pi/mcp/{add,remove,connect,disconnect,reconnect,list,tools,include,exclude,oauth/start,oauth/finish,oauth/cancel,oauth/discover,oauth/register}` + hydration + DCR add-flow |
| `SettingsService` | `src/settings/settings-service.ts` | `_bodhi-pi/session/settings/{get,set,unset,list}` + layered merge |
| `SessionInfoService` | `src/sessions/session-info-service.ts` | `_bodhi-pi/session/{config,setName,stats,export}` |
| `SessionGraphService` | `src/sessions/session-graph-service.ts` | `_bodhi-pi/session/{tree,navigate,entries,fork,clone,delete}` + cross-branch summarization |
| `CompactionOrchestrator` | `src/sessions/compaction-orchestrator.ts` | `_bodhi-pi/session/compact` + proactive `prepareNextTurn` hook + overflow recovery |
| `SubagentService` | `src/subagents/subagent-service.ts` | `_bodhi-pi/subagent/{list,run,children}` + in-process child-session spawn + progress mirroring + `SUBAGENT_MAX_DEPTH` recursion guard (cached on `SessionState.subagentDepth`) + per-status `evictChild` lifecycle + bundled + extension-registered profile registry + `subagent_start` / `subagent_end` lifecycle events forwarded over `LIFECYCLE_EVENT_METHOD` + `context: "fresh" \| "fork"` (fork inherits a filtered parent-transcript slice via `cloneTranscriptSlice`) |

Each service exposes `register(): Array<[method, handler]>`; the façade flattens them into `extHandlers` at `src/acp/agent.ts:256-264` and dispatches via `extMethod` at `src/acp/agent.ts:481-485`.

The `EventDispatcher` (`src/events/dispatcher.ts`) is the cross-service nervous system. Services emit lifecycle events (`session_start`, `session_shutdown`, `tool_call`, `tool_result`, `before_provider_request`, `after_provider_response`, `mcp_status_change`, `mcp_tools_change`, …); the dispatcher fans them out to Host-supplied `eventHandlers`, Extension-registered handlers, and internal wiring (`src/acp/event-wiring.ts`) that translates to ACP `sessionUpdate` notifications on the wire.

## `src/` layout

```
src/
├── _internal/        utility helpers (frontmatter, object, sort) — used internally only
├── acp/              ACP wire surface
│   ├── agent.ts          BodhiPiAcpAgent façade + createBodhiPiAgent factory
│   ├── event-wiring.ts   internal handlers translating events → sessionUpdate
│   ├── prompt-loop.ts    runPromptLoop + subscribeToAgent
│   ├── notifications.ts  ACP-shape helpers + guards
│   └── system-prompt.ts  buildSystemPrompt composer
├── client/           Client-side SDK seed (BodhiPiClient, createBodhiPiClient,
│                     model + auth + slash-arg helpers consumed by Hosts'
│                     client/ folders — see client-sdk-seed.md)
├── commands/         project-defined prompt-template discovery (.bodhi-pi/commands/*.md)
├── events/           EventDispatcher + handler types
├── extensions/       host-loaded factory runtime (types, runner, merge, tool-adapter, events-bus)
├── filesystem/       Filesystem interface + in-memory adapter
├── kv/               KvStore interface + KvService + in-memory adapter
├── mcp/              McpService + McpStore + McpConnectionLifecycle + McpRegistry
│                     + McpConnectionProvider interface + in-process default
│                     + mcp-client + mcp-tool-adapter + slug/types
│                     + KvOAuthProvider + OAuthStateKv + oauth-state-token (OAuth 2.1 PKCE)
│                     + mcp-stdio-env (resolveStdioEnv)
├── models/           ModelRegistry + provider-stream options resolution
├── script-executor/  ScriptExecutor interface
├── sessions/         SessionStore + SessionEntry union + session-state + bootstrap
│                     + compaction + branch-summary + build-context + resource-loader
│                     + SessionInfoService + SessionGraphService + CompactionOrchestrator
├── settings/         layered settings (defaults/global/project/host/session) + SettingsService
├── skills/           skill discovery (.bodhi-pi/skills/*.md) + Skill type
├── subagents/        sub-agent profile discovery (.bodhi-pi/agents/*.md)
│                     + SubagentService (spawn + handlers) + buildChildSessionState
│                     + composeSubagentSystemPrompt — see subagents.md
├── terminal/         Terminal interface
├── tools/            built-in tools (read/write/edit/ls/find/grep/run_script/bash/subagent)
│                     + _accumulate + _text-encoding + file-mutation-queue
├── wire/             leaf protocol module (constants, validators, converters)
│                     — only this module knows ACP method names
├── version.ts        BODHI_PI_VERSION
└── index.ts          public exports barrel
```

**Domain folder rule** (per `feedback_bodhi_pi_src_layout`): each domain folder owns both data types AND its `*Service`. No `src/acp/services/` nesting. `wire/` is the leaf protocol module so domain services never import ACP constants from each other.

**Import discipline** (per `packages/bodhi-pi/CLAUDE.md`): `Agent` is imported from `@earendil-works/pi-agent-core/dist/agent.js` (deep import), **not** from the barrel — the barrel re-exports Node-only modules that break browser builds. This is intentional and must not be "fixed".

## Cross-cutting concerns

- **Filesystem walks** for project artefacts (`AGENTS.md`, `CLAUDE.md`, `.bodhi-pi/settings.json`, `.bodhi-pi/commands/`, `.bodhi-pi/skills/`) go through the injected `Filesystem`, start at session `cwd`, ascend via `path.posix.dirname` to the mount root. Core never imports `node:fs`/`node:os`.
- **ACP `fs/*` and `terminal/*` methods are deliberately absent** — orthogonal to host-injected `Filesystem`/`Terminal`.
- **No env-var API key reading in core.** All auth flows through `_bodhi-pi/kv/set auth/<provider>` and the injected `KvStore`.
- **Stable ACP over `unstable_*`.** Non-spec features always ship as `_bodhi-pi/<area>/<verb>` extensions, never as ACP `unstable_*` fields.

## Per-Host runtime matrix

| Host | Process model | Transport | Notable adapter shape |
|---|---|---|---|
| cli (`test-apps/cli/`) | single Node process | in-process pair | NodeFilesystem + SQLite-backed SessionStore + NodeKvStore + Node ScriptExecutor + Node Terminal |
| http (`test-apps/http/`) | Node HTTP server, browser UI | HTTP+SSE (and WebSocket sibling under same package) | **Per-turn agent rebuild** — Agent is constructed fresh each prompt; SessionStore + KvStore + per-user `ServerMcpStore` survive across rebuilds |
| browser (`test-apps/browser/`) | browser tab + Web Worker | `MessagePort` between worker and main thread | ZenFS Filesystem (FSA-backed) + Dexie SessionStore + Dexie KvStore + AsyncFunction ScriptExecutor; no stdio MCPs |
| chrome-ext (`test-apps/chrome-ext/`) | extension worker + popup + sandbox iframe | `MessagePort` via chrome messaging + sandboxed eval | Same browser adapters + sandbox-bridged AsyncFunction executor; no stdio MCPs |

Detail per Host in [hosts.md](./hosts.md). Shared adapters in `test-apps/node-adapters/` + `test-apps/app-utils/`.

## Where to read next

- [acp.md](./acp.md) — every method, error code, side effect, sequence diagrams for the 5 most complex flows.
- [lifecycle.md](./lifecycle.md) — what `buildSessionState` / `rehydrateSession` actually do, SessionEntry union, DAG semantics.
- [mcp.md](./mcp.md) — the recent decomposition narrative + connection/inclusion model.
