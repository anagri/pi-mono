# bodhi-pi M5 — Events + Extensions (cross-runtime)

## Context

bodhi-pi today exposes ACP wire, session lifecycle, filesystem tools, slash commands, skills, and `run_script`. To match coding-agent's surface and unlock host-customisations (input transforms, system-prompt augmentation, tool-call gating, secret redaction, dynamic tool/provider registration) we need the same two-layer mechanism coding-agent uses:

- **Lifecycle events** — discrete hooks fired by the agent runtime. Some events are *mutable* (handler can rewrite payload), some *blocking* (handler can short-circuit).
- **Extension API** — a factory `(pi: ExtensionAPI) => void` that uses events plus registration methods (`registerTool`, `registerCommand`, `registerProvider`, `events.{emit,on}`, `appendEntry`, `sendMessage`).

In coding-agent the extension API is built on top of the event substrate; events come first. We split the same way.

**Cross-runtime constraint.** Per `packages/bodhi-pi/CLAUDE.md`, every new feature must clear the 6-step TDD matrix: core integration → core e2e → bodhi-pi-node adapter → bodhi-pi-browser adapter → bodhi-pi-cli e2e → bodhi-pi-web Playwright. Browser-only and Node-only quirks (FSA permissions, ZenFS async, AsyncFunction CSP; better-sqlite3 native bindings, child_process, jiti's `node:vm` dep) only surface at the host. Skipping any step is a regression risk.

**Headless contract.** No TUI. Drop everything that depends on `ctx.ui.*`, shortcuts, editor/footer/header/widgets, and TUI-specific events (`user_bash`, `model_select` UI flows, `resources_discover`, session-tree). All client↔agent interaction stays on ACP. Tool-call gating in M5.x is **non-interactive** — handlers return `{ block: true, reason }` which surfaces to the agent as a tool error. Interactive permission prompts wait for the separate Permissioner milestone (ACP `session/request_permission`).

**Loader portability.** bodhi-pi core never walks fs. Each runtime gets its own loader as a publishable adapter:

- **Node** (`@bodhiapp/bodhi-pi-node`): jiti-based loader, walks `<cwd>/.bodhi-pi/extensions/*.{ts,js}`. jiti needs `node:fs` + `node:vm` — fine for any Node host.
- **Browser** (`@bodhiapp/bodhi-pi-browser`): JS-only loader, reads `<cwd>/.bodhi-pi/extensions/*.js` from injected `Filesystem` (ZenFS-backed), dynamically imports via `data:text/javascript;base64,…` URL. No `unsafe-eval` requirement (uses native ESM). TS source in browser is **deferred** — needs esbuild-wasm; out of scope for M5.x.

This matches the existing pattern: Filesystem, SessionStore, ScriptExecutor are all host-injected via adapter packages.

**Outcome.** After M5.2 a host can ship a directory of extensions that observe and mutate the agent loop, register custom tools/providers/commands, and gate tool calls — all without touching bodhi-pi internals or the ACP wire. Both the Node CLI and the browser worker prove it on real LLMs.

---

## Phase split

| Milestone | Scope | Public surface |
|---|---|---|
| **M5.1 — Events** | Emit headless lifecycle events from agent runtime; expose handler injection on `BodhiPiConfig`. No extension factory yet. | `BodhiPiConfig.eventHandlers?: BodhiPiEventHandlers` |
| **M5.2 — Extensions** | `ExtensionAPI` factory + runner on top of M5.1 events. Tool/command/provider registration. Inter-extension pub/sub. Custom session entries. Node + browser loaders in adapter packages. | `BodhiPiConfig.extensionFactories?: ExtensionFactory[]`; `ExtensionAPI` type; `createNodeExtensionLoader`; `createBrowserExtensionLoader` |

Each milestone runs the 6-step matrix end-to-end before merge.

---

## M5.1 — Events

### Headless event taxonomy

Mirror coding-agent's names so users can copy patterns. Skip TUI events.

| Event | Payload | Mutability |
|---|---|---|
| `session_start` | `{ sessionId, cwd, reason: "new"\|"load"\|"resume" }` | observe |
| `session_shutdown` | `{ sessionId }` | observe |
| `agent_start` | `{ sessionId, userPrompt }` | observe |
| `agent_end` | `{ sessionId, stopReason, messages, errorMessage? }` | observe |
| `turn_start` | `{ sessionId, turnIndex }` | observe |
| `turn_end` | `{ sessionId, turnIndex, message, toolResults }` | observe |
| `before_agent_start` | `{ sessionId, systemPrompt, userPrompt }` | mutable: handler returns `{ systemPrompt?, userPrompt? }` |
| `input` | `{ sessionId, text, source: "acp" }` | mutable: handler returns `{ text? }` or `{ handled: true }` |
| `before_provider_request` | `{ sessionId, provider, model, payload }` | mutable: handler returns `{ payload? }` |
| `after_provider_response` | `{ sessionId, status, headers, durationMs }` | observe |
| `message_start` / `message_end` | `{ sessionId, message }` | `message_end.message` is mutable in place (redact/transform before persist) |
| `message_update` | `{ sessionId, assistantMessageEvent }` | observe |
| `tool_execution_start` / `tool_execution_update` / `tool_execution_end` | `{ sessionId, toolCallId, toolName, args\|details\|result }` | observe |
| `tool_call` | `{ sessionId, toolCallId, toolName, input }` | mutable + blocking: handler returns `{ block: true, reason }` or mutates `input` in place |
| `tool_result` | `{ sessionId, toolCallId, toolName, result }` | mutable: handler mutates `result.content`/`result.details` in place |
| `model_select` | `{ sessionId, fromModelId, toModelId }` | observe (fired from `setSessionConfigOption`) |

Type discipline: discriminated union `BodhiPiEvent` keyed by `type` (matches coding-agent's `ExtensionEvent` shape, line 950–972 of `coding-agent/src/core/extensions/types.ts`). One overload per event for `EventDispatcher.emit`/`on`.

### Files (M5.1)

| Path | Role |
|---|---|
| `bodhi-pi/src/events/types.ts` (new) | `BodhiPiEvent` union, per-event payload interfaces, `BodhiPiEventHandlers` partial-map type |
| `bodhi-pi/src/events/dispatcher.ts` (new) | `EventDispatcher` — `register(handlers)`, `emit<T>(event)`. Async sequential dispatch. Errors caught + logged. Mutation-aware emitters: `emitToolCall`, `emitToolResult`, `emitInput`, `emitBeforeAgentStart`, `emitBeforeProviderRequest`. |
| `bodhi-pi/src/tools/with-events.ts` (new) | Wrap `AgentTool.execute` to emit `tool_call` (apply mutation, honour `block`) → execute → emit `tool_result` (apply mutation). |
| `bodhi-pi/src/acp/agent.ts` (modify) | Construct `EventDispatcher` from `config.eventHandlers`. Wire emits: per-session `session_start`/`session_shutdown`; in `prompt()` emit `agent_start`/`agent_end`, `turn_start`/`turn_end`. Hook pi-agent-core's `subscribe` for `message_*`, `tool_execution_*`. Apply `input` + `before_agent_start` mutation before invoking `piAgent.prompt`. Emit `model_select` after `setSessionConfigOption`. |
| `bodhi-pi/src/acp/agent.ts` (modify) | Wrap each `AgentTool` via `with-events.ts` so `tool_call`/`tool_result` interception is consistent for built-in and (future) extension tools. |
| `bodhi-pi/src/index.ts` (modify) | Export `BodhiPiEvent`, `BodhiPiEventHandlers`, per-event payload types. |
| `bodhi-pi/test/helpers/harness.ts` (modify) | Accept `eventHandlers` passthrough. |

### Open spike for M5.1

`before_provider_request` / `after_provider_response` access. pi-agent-core may not surface provider-level hooks today. Spike day-1: read `node_modules/@mariozechner/pi-agent-core/src` and `pi-ai/providers/*`. If not exposed, emit only what we can reach (provider info via `model_select` + `agent_start`) and file an upstream issue. Document the gap in `bodhi-pi/DEVELOPMENT.md`.

### TDD matrix — M5.1

| Step | Path | Scope |
|---|---|---|
| **1. core integration** | `bodhi-pi/test/events.test.ts` | One test per event (16 events). Faux provider returning canned text + canned tool calls. Subscribe via `eventHandlers`. Assert dispatch ordering, payload shape, mutation propagation (e.g. `before_agent_start` rewrites system prompt → faux provider receives the rewritten one). |
| **2. core e2e** | `bodhi-pi/e2e/events.e2e.ts` | gpt-4o-mini single turn. Assert event sequence: `session_start` → `agent_start` → `turn_start` → `message_start` → `message_end` → `turn_end` → `agent_end`. Tool-call sub-test prompts "list files" against a real fs adapter; asserts `tool_call`/`tool_result` fire. |
| **3. bodhi-pi-node** | (no new adapter) | Events have no host-side adapter — pure runtime concern. Nothing changes in this package. |
| **4. bodhi-pi-browser** | (no new adapter) | Same. Skip step. |
| **5. cli e2e** | `bodhi-pi-cli/e2e/events.e2e.ts` | Wire `eventHandlers` through `createCliAgent` (`bodhi-pi-cli/src/agent.ts` modify: accept `eventHandlers` option, pass to `createBodhiPiAgent`). Test: collect events into an array via the harness, prompt gpt-4o-mini, assert sequence. |
| **6. web Playwright** | `bodhi-pi-web/e2e/events.spec.ts` | Worker (`bodhi-pi-web/src/agent/worker.ts`) accepts `eventHandlers` from `InitMessage`. Handler appends event types to `window.__bodhiPiEventLog` via a `MessageChannel` postback. Spec seeds workspace, prompts, asserts log. |

### M5.1 verification

```bash
npm --workspace @bodhiapp/bodhi-pi run test
npm --workspace @bodhiapp/bodhi-pi run test:e2e
npm --workspace bodhi-pi-cli run test:e2e
npm --workspace bodhi-pi-web run test:e2e
npm run check
```

---

## M5.2 — Extensions

### `ExtensionAPI` surface (headless subset)

```ts
export interface ExtensionAPI {
  on<T extends BodhiPiEventType>(type: T, handler: BodhiPiEventHandler<T>): () => void;

  registerTool(def: ExtensionToolDefinition): () => void;
  registerCommand(name: string, def: ExtensionCommandDefinition): () => void;
  registerProvider(name: string, config: ProviderConfig): () => void;

  events: { emit(channel: string, data: unknown): void; on(channel: string, handler: (data: unknown) => void): () => void };

  appendEntry(sessionId: string, entry: ExtensionEntryPayload): Promise<void>;
  sendMessage(sessionId: string, content: string): Promise<void>;     // surfaces as ACP agent_message_chunk
}

export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;
```

**Excluded** (TUI-only): `registerShortcut`, `registerMessageRenderer`, `registerFlag`, `getFlag`, `setStatus`, `setEditorComponent`, `setFooter`, `setHeader`, `setWidget`, `ctx.ui.*`. Extensions calling these get a TypeError at registration time.

### Loading model

Core takes pre-loaded factories only via `BodhiPiConfig.extensionFactories?: ExtensionFactory[]`. Two adapter packages provide host-specific loaders:

- **`bodhi-pi-node`** → `createNodeExtensionLoader({ cwd })` → `Promise<ExtensionFactory[]>`
  - Walks `<cwd>/.bodhi-pi/extensions/*.{ts,js}`
  - Uses **jiti** (new dep) to load each file
  - Asserts `default` export is a function
  - First-wins on name collision
  - Errors logged + skipped — peer extensions unaffected
- **`bodhi-pi-browser`** → `createBrowserExtensionLoader({ filesystem, cwd })` → `Promise<ExtensionFactory[]>`
  - Reads `<cwd>/.bodhi-pi/extensions/*.js` from injected `Filesystem` (ZenFS-backed)
  - Encodes source as `data:text/javascript;base64,…` and dynamic-imports
  - Same first-wins + error isolation
  - **JS-only** in M5.2. TS-via-esbuild-wasm deferred.

### Custom session entries

Extensions need to persist arbitrary state. Today `SessionEntry = SessionMessageEntry | ModelChangeEntry`. Add:

```ts
export interface ExtensionEntry {
  type: "extension";
  id: string;
  timestamp: number;
  extensionName: string;
  customType: string;          // user-defined ("web-search-results", "todo-list", …)
  data: unknown;
}
```

- Update `SessionEntry` union, `bodhi-pi/src/sessions/in-memory-session-store.ts`, `bodhi-pi-node/src/sessions/sqlite-session-store.ts`, `bodhi-pi-browser/src/sessions/dexie-session-store.ts`.
- `loadSession` replay: skip extension entries from ACP user/assistant replay; let extensions read them via `SessionStore.readExtensionEntries(sessionId, { extensionName, customType? })` on `session_start`. Mirrors pi-web-access pattern (storage.ts:60–72).

### Files (M5.2)

| Path | Role |
|---|---|
| `bodhi-pi/src/extensions/types.ts` (new) | `ExtensionAPI`, `ExtensionFactory`, `ExtensionToolDefinition` (TypeBox params), `ExtensionCommandDefinition`, `ProviderConfig`, `ExtensionEntryPayload` |
| `bodhi-pi/src/extensions/runner.ts` (new) | `ExtensionRunner` — instantiates factories at agent construction, owns `Map<extensionName, registeredHooks>`, `registerWith(EventDispatcher)`, `getExtensionTools()`, `getExtensionCommands()`, `getExtensionProviders()`. Disposable pattern: every register* returns a teardown closure. |
| `bodhi-pi/src/extensions/events-bus.ts` (new) | Inter-extension pub/sub. Per-runner channel registry. |
| `bodhi-pi/src/extensions/tool-adapter.ts` (new) | Convert `ExtensionToolDefinition` → `AgentTool` for pi-agent-core consumption. |
| `bodhi-pi/src/sessions/session-store.ts` (modify) | Add `ExtensionEntry`, `readExtensionEntries` interface method. |
| `bodhi-pi/src/sessions/in-memory-session-store.ts` (modify) | Implement `readExtensionEntries`. |
| `bodhi-pi/src/acp/agent.ts` (modify) | Construct `ExtensionRunner`, merge extension tools into builtin tools (builtins win on collision), merge extension commands into slash-commands set, merge extension providers into `models` registry. Fire `session_start` via runner. |
| `bodhi-pi/src/index.ts` (modify) | Export `ExtensionAPI`, `ExtensionFactory`, `ExtensionEntry`. |
| `bodhi-pi-node/src/extensions/node-extension-loader.ts` (new) | jiti-based file loader. |
| `bodhi-pi-node/src/sessions/sqlite-session-store.ts` (modify) | Persist `ExtensionEntry`; implement `readExtensionEntries`. |
| `bodhi-pi-node/src/sessions/schema.ts` (modify) | drizzle column adjustments if needed; add migration if column shape changes. |
| `bodhi-pi-node/src/index.ts` (modify) | Export `createNodeExtensionLoader`. |
| `bodhi-pi-node/package.json` (modify) | Add `jiti` dep. |
| `bodhi-pi-browser/src/extensions/browser-extension-loader.ts` (new) | Filesystem-walk + data-URL dynamic import. |
| `bodhi-pi-browser/src/sessions/dexie-session-store.ts` (modify) | Persist `ExtensionEntry`; implement `readExtensionEntries`. |
| `bodhi-pi-browser/src/index.ts` (modify) | Export `createBrowserExtensionLoader`. |
| `bodhi-pi-cli/src/agent.ts` (modify) | Call `createNodeExtensionLoader({ cwd })`, pass factories to `createBodhiPiAgent`. |
| `bodhi-pi-web/src/agent/worker.ts` (modify) | Call `createBrowserExtensionLoader({ filesystem, cwd })` after FS mount, pass factories to `createBodhiPiAgent`. |

### Reuse points (don't reinvent)

- `pi-agent-core`'s `Agent.subscribe` already gives `message_*`, `tool_execution_*`. Hook into it; don't duplicate.
- `pi-ai`'s `Type` (TypeBox) — same schema namespace coding-agent uses. Re-export through `ExtensionAPI` if convenient (`pi.types`).
- `composeSystemPrompt` (`bodhi-pi/src/skills/system-prompt.ts`) — splice extension-contributed prompt fragments before invoking `before_agent_start`.
- `loadProjectCommands` / `loadProjectSkills` — extension commands merge into the same `available_commands_update` list (one source of truth for ACP advertisements).
- `bodhi-pi-cli/test/helpers/cli-harness.ts` — extend for extension-loader integration tests.
- `bodhi-pi-web/e2e/helpers/seed.ts` `WorkspaceSeed` — add `extensions: Record<path, source>` field so Playwright specs can seed `.bodhi-pi/extensions/*.js` straight into the in-memory mount.

### Five extension fixtures (the proof set)

These run **identically** at integration (faux LLM), e2e (real LLM), CLI e2e (Node loader), and web e2e (browser loader) layers. Single source of truth lives in `bodhi-pi/test/helpers/extension-fixtures.ts`; CLI and web tests import the same factory definitions.

| Fixture | Integration assertion (faux) | Real-LLM assertion (gpt-4o-mini) |
|---|---|---|
| **input-transform** (`?quick` prefix) | Faux receives the *transformed* prompt; without prefix it sees original. | `?quick what is 2+2` → response is one short sentence. |
| **pirate / prompt-customizer** | Faux's first `messages[0].content` (system) contains injected pirate rule. | Real LLM response contains pirate-style words (`arr`, `matey`, `ye`). Stable substring assertion. |
| **redact-secrets** | Faux tool returning `sk-ABC123` → assistant's next message never contains it; `tool_result.content` shows `[REDACTED]`. | Mock tool returns a fake secret; final response never echoes it. |
| **dynamic-tools** | `pi.registerTool` at `session_start` → faux LLM's reported tool list contains it; calling it returns canned content. | Real LLM picks the dynamic tool when prompted; observed via `tool_call` event. |
| **registerProvider** | Extension registers a faux provider w/ id `faux-x`; `setSessionConfigOption(model=faux-x)` succeeds; next prompt routes to that provider. | Extension registers Anthropic provider; `setSessionConfigOption(model=claude-haiku-4-5)`; real Claude call returns text. (API-key auth only; OAuth deferred.) |

### TDD matrix — M5.2

| Step | Path | Scope |
|---|---|---|
| **1. core integration** | `bodhi-pi/test/extensions.test.ts` | 5 fixtures × faux LLM. Inline `extensionFactories: [...]` on `BodhiPiConfig`. Assert each fixture's deterministic side-effect. |
| **2. core e2e** | `bodhi-pi/e2e/extensions.e2e.ts` | 5 fixtures × gpt-4o-mini (and one Anthropic for registerProvider). Real LLMs, real adapters. |
| **3. bodhi-pi-node** | `bodhi-pi-node/test/extensions.test.ts` | Unit test for `createNodeExtensionLoader`: tmpdir with 3 fixture extensions (one valid, one syntax error, one missing default export); assert 1 factory returned, 2 errors logged. Plus `bodhi-pi-node/test/sqlite-extension-entry.test.ts` for `ExtensionEntry` round-trip + `readExtensionEntries` filter. |
| **4. bodhi-pi-browser** | `bodhi-pi-browser/src/extensions/browser-extension-loader.test.ts` | Unit test (vitest + fake-indexeddb + in-memory FS): seed 3 fixture JS files, assert loader produces 1 factory + 2 logged errors. Plus `dexie-extension-entry.test.ts` for ExtensionEntry round-trip. |
| **5. cli e2e** | `bodhi-pi-cli/e2e/extensions.e2e.ts` | Drop the 5 fixture extensions on tmpdir as `.bodhi-pi/extensions/*.ts`. CLI loads via `createNodeExtensionLoader`. Real LLM run validates each fixture end-to-end. |
| **6. web Playwright** | `bodhi-pi-web/e2e/extensions.spec.ts` | Seed `__bodhiPiWebSeed.extensions = { "input-transform.js": "...", … }` (5 fixtures, **JS source** — TS in browser deferred). Worker loads via `createBrowserExtensionLoader`. Real LLM run; assert via `ChatPage` POM (state transitions, message content). |

### M5.2 verification

```bash
npm --workspace @bodhiapp/bodhi-pi run test
npm --workspace @bodhiapp/bodhi-pi run test:e2e
npm --workspace @bodhiapp/bodhi-pi-node run test
npm --workspace @bodhiapp/bodhi-pi-browser run test
npm --workspace bodhi-pi-cli run test:e2e
npm --workspace bodhi-pi-web run test:e2e
npm run check
```

---

## Out of scope (deferred)

| Item | Reason |
|---|---|
| Interactive `ctx.requestPermission(...)` via ACP `session/request_permission` | Separate Permissions milestone (already planned). M5.x relies on `block: true` only. |
| TUI primitives (`ctx.ui.*`, shortcuts, editor, footer, widgets) | Headless contract — never landing. |
| Browser TypeScript-source extensions (esbuild-wasm transform) | M5.2 ships JS-only browser loader. TS-in-browser when a real use case appears. |
| Compaction event hooks (`session_before_compact`, `CompactionEntry`) | Phase 6 (compaction) milestone. |
| Subagent / handoff extension primitives | Phase 9+. |
| OAuth provider registration | API-key providers only in M5.2. |
| Tool-override (extensions shadowing built-ins) | Builtins always win in M5.2. Coding-agent has it (`tool-override.ts`); not on critical path. |

---

## Risks / open spikes

1. **`before_provider_request` / `after_provider_response` access in pi-agent-core.** Day-1 spike. If pi-agent-core doesn't surface provider hooks, document gap and emit only reachable events.
2. **`registerProvider` shape stability.** Coding-agent has OAuth scaffolding. We start API-key-only; defer OAuth until a real use case lands.
3. **jiti TS file performance on cold start.** Cache jiti's transformed output in `<cwd>/.bodhi-pi/.cache/extensions/`. Defer if cold-start is acceptable.
4. **Browser dynamic-import CSP.** `import("data:…")` works without `unsafe-eval` but is blocked by strict `script-src` in some hosts. Document required CSP in `bodhi-pi-browser` README.
5. **SQLite/Dexie schema migration for `ExtensionEntry`.** New column may need a drizzle migration in bodhi-pi-node and a Dexie version bump in bodhi-pi-browser. Both must round-trip on existing DBs (no data loss).

---

## Critical files to read before implementing

- `packages/coding-agent/src/core/extensions/types.ts` (lines 426–473 ToolDefinition, 604–972 events, 1084–1311 ExtensionAPI)
- `packages/coding-agent/src/core/extensions/runner.ts` (lines 224–356 lifecycle, 680–1039 emit*)
- `packages/coding-agent/src/core/event-bus.ts` (full file — 34 lines, the inter-extension bus)
- `packages/coding-agent/examples/extensions/input-transform.ts`, `pirate.ts`, `redact-secrets.ts`, `dynamic-tools.ts`, `custom-provider-anthropic/index.ts` (canonical patterns)
- `packages/bodhi-pi/src/acp/agent.ts` (event emit points; lines 300–396 for the `prompt()` loop)
- `packages/bodhi-pi/src/sessions/session-store.ts` (entry union extension)
- `packages/bodhi-pi-cli/src/agent.ts:23–36` (createCliAgent — extension hook point)
- `packages/bodhi-pi-web/src/agent/worker.ts:25–45` (worker bootstrap — extension hook point)
- `packages/bodhi-pi-web/e2e/fixtures.ts`, `e2e/pages/ChatPage.ts`, `e2e/helpers/seed.ts` (Playwright pattern)
- `/Users/amir36/Documents/workspace/src/github.com/BodhiSearch/pi-mono/packages/web-acp-agent/src/agent/extensions/runner.ts` (prior abandoned attempt — Disposable, first-wins, error isolation patterns)

---

## Acceptance

**M5.1 lands when**: 16 integration tests + core e2e + CLI e2e + web Playwright spec all green; no TUI events emitted; host can subscribe via `BodhiPiConfig.eventHandlers`; mutation propagation verified for `before_agent_start` / `tool_call` / `tool_result` / `input` across all three host harnesses.

**M5.2 lands when**: 5 fixture extensions pass at every layer of the 6-step matrix (5 × 6 = 30 assertions); Node loader handles `.ts` + `.js` via jiti; browser loader handles `.js` via data-URL ESM; `ExtensionEntry` round-trips through SQLite + Dexie; builtins still win on tool-name collision; no `ctx.ui.*` surface present.
