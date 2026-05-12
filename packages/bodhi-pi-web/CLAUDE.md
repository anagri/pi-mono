# bodhi-pi-web

Reference browser host for `@bodhiapp/bodhi-pi`. Vite + React + TypeScript app on the main thread; agent runs in a dedicated Web Worker. Main↔Worker speaks ACP framed over `MessagePort`. Feature-equivalent to `bodhi-pi-cli` and to the `bodhi-pi-ws-server` + `bodhi-pi-ws-frontend` pair — every bodhi-pi capability has a Playwright spec here proving it works through the worker against a real LLM.

**Parity counterparts:** `packages/bodhi-pi-cli` (Node CLI) and `packages/bodhi-pi-ws-frontend` + `packages/bodhi-pi-ws-server` (split WS host). New features land here AND in those packages — see `packages/bodhi-pi/CLAUDE.md` for the parity rule.

`README.md` covers user-facing setup. `ai-docs/plans/` carries the milestone plans (M1–M16) with rationale for each design choice.

All the bodhi-pi-* runtimes, including this are Proof of Concepts, so there is no production deployment of these PoCs, there is no backwards compatability requirement, no data migration requirment, makes development of bodhi-pi quicker with these PoCs checking it works in all runtimes.

## Feature surface (the parity contract)

Each row below is a user-visible capability. The same row must be visible in `bodhi-pi-cli` and in the `bodhi-pi-ws-*` pair, observable through analogous DOM/CLI affordances.

- **Streaming chat round-trip.** Text prompt → user message persists, assistant chunks stream into one message, status flips `idle → streaming → idle`.
- **Tool-call cards.** Inline cards with `[data-testid=tool-call][data-tool-name][data-tool-status=running|completed|failed]`, optional preview (first ~400 chars).
- **Cancellation.** Composer Send button morphs to Stop while streaming; click cancels in-flight prompt; status returns to `idle`.
- **Slash commands.** `/help`, `/model [id]`, `/sessions`, `/new`, `/resume <id>`, `/close`, `/delete <id>` dispatch locally on the main thread; project commands and skills flow to `conn.prompt`.
- **Project commands + skills + scripted skills.** Discovered from `.bodhi-pi/commands/`, `.bodhi-pi/skills/`; scripted skills run via the host's `ScriptExecutor` (`run_script` tool).
- **Extensions.** Auto-loaded from `.bodhi-pi/extensions/*.{js,mjs,cjs}` per session; can hook `tool_result` etc.
- **Cross-provider.** OpenAI + Anthropic in one session; `/model <id>` switches mid-thread; `data-current-model` updates.
- **Session lifecycle.** Auto-resume the last session on reload (per `(host, userId)` scope); replay history on resume; tool-call cards re-render as completed; failed tools surface as `data-tool-status=failed`.
- **Observability via EventsPanel.** Two tabs — `lifecycle` (every `BodhiPiEvent`) and `wire` (every ACP frame in either direction). Specs assert through `[data-testid=event-row]` only.
- **Chat-state attribute.** `[data-testid=chat-page][data-test-state=...]` for blackbox state waits.

## Architecture pillars

**Agent + adapters live entirely in the worker.** Main thread holds a `ClientSideConnection` and the React UI. The worker constructs `Filesystem`, `SessionStore`, `ScriptExecutor` from `@bodhiapp/bodhi-pi-browser` and feeds them to `createBodhiPiAgent`. No agent logic on the main thread.

**ACP transport is byte-stream over `MessagePort`.** Worker spawn → `MessageChannel` → main posts `{ type: "init", agentPort: port2 }` (transferable). Both sides wrap their port via `createMessagePortStream(port)` from `bodhi-pi-browser`, then feed it to ACP SDK's `ndJsonStream` to get a `Stream` for `ClientSideConnection` (main) / `AgentSideConnection` (worker).

**Workspace is single-folder, FSA-backed, persistent.** Chrome `showDirectoryPicker({ mode: "readwrite" })` returns a `FileSystemDirectoryHandle`; we save it in IndexedDB via `idb-keyval`. ZenFS's `WebAccess` backend wraps it; `vfs.mount(/mnt/<handle.name>, backend)` exposes it through the Node-fs-shaped API bodhi-pi expects. The agent's `cwd` is `/mnt/<handle.name>`.

**Boot gate is non-skippable.** No granted handle → `<DirectoryGate>` blocks the chat surface. After grant → `<RuntimeProvider>` mounts → worker spawns → ACP `initialize` → `loadSession` (if last id in `sessionStorage`) or `newSession`. Status flips `initializing → idle`.

**Slash commands route on the main thread.** A line starting with `/` whose name is NOT in `availableCommands` (announced by the agent via `available_commands_update`) runs locally via `ui/commands.ts`. Anything else forwards to `conn.prompt` — bodhi-pi expands project-defined commands and skills before the LLM sees them. Source pattern lifted from `bodhi-pi-cli/src/repl/commands.ts`.

**Tests bypass the FSA picker via seed injection.** Playwright `addInitScript` sets `window.__bodhiPiWebSeed = { name, files }` before page load; `bootstrap.ts` short-circuits past IndexedDB and the picker, mounting an `InMemory` ZenFS backend with the seed files. **This is the *only* whitebox bridge** — there is no DOM affordance that can replace Chrome's File System Access picker bypass. No CDP flags, no native dialogs in CI.

**EventsPanel is the canonical observability surface.** A `<EventsPanel>` mounts next to `<ChatPage>` unconditionally (production + e2e + manual smoke) and exposes two tabs:

- **lifecycle** — every `BodhiPiEvent` the worker emits (19 types) is forwarded via `self.postMessage` and pushed to `useEventStore`.
- **wire** — every JSON-RPC frame crossing the agent `MessagePort` in either direction, captured by the byte-level `tapReadable` / `tapWritable` wrappers in `agent/wire-tap.ts` (worker side).

Specs read the panel via `[data-testid="event-row"]` locators with `data-event-source`, `data-event-type`, `data-event-direction`, `data-event-method`, `data-rpc-id`, etc. Zero `page.evaluate` / `window.*` access from tests. The store push paths run outside React so the panel never feedback-loops.

## Key files

| Path | Role |
|---|---|
| `src/main.tsx` | React root |
| `src/App.tsx` | Bootstrap → DirectoryGate or RuntimeProvider+ChatPage; owns `handleUnmount` |
| `src/env.ts` | `readEnv()` — reads `VITE_*_API_KEY`, builds the Model registry |
| `src/workspace/bootstrap.ts` | Reads seed → loads IndexedDB handle → returns `{ ready, ... }` |
| `src/workspace/types.ts` | `WorkspaceConfig` discriminated union (mode: `"fsa" \| "seed"`) |
| `src/agent/types.ts` | `InitMessage` shape posted to the worker |
| `src/agent/worker.ts` | Worker entry — mounts FS, builds adapters, spins up `AgentSideConnection` |
| `src/agent/runtime.ts` | `startAgentRuntime()` — spawns worker, handshake, `ClientSideConnection` |
| `src/agent/render.ts` | `dispatchNotification()` — ACP `sessionUpdate` → chat-store actions (text chunks, tool cards, available_commands) |
| `src/agent/session-storage.ts` | per-tab last-sessionId persistence |
| `src/agent/crypto-shim.ts` | `node:crypto` alias → `globalThis.crypto.randomUUID` (vite alias bypasses crypto-browserify) |
| `src/agent/wire-tap.ts` | `tapReadable` / `tapWritable` — byte-level pass-through TransformStreams that emit each ndjson frame as it crosses the agent MessagePort |
| `src/store/chatStore.ts` | Zustand store. Messages with optional `toolCall` for inline tool-call cards |
| `src/store/eventStore.ts` | Zustand store backing `<EventsPanel>`: `lifecycle[]` (BodhiPiEvent records) + `wire[]` (raw ndjson frames). Capped FIFO at 500 each |
| `src/ui/RuntimeProvider.tsx` | Owns `conn`, sessionId, models, availableCommands. Exposes `prompt`, `cancelPrompt`, `unmount` via React context |
| `src/ui/ChatPage.tsx` | `<StatusBar/><MessageList/><Composer/>` |
| `src/ui/EventsPanel.tsx` | Always-visible sidepanel with `lifecycle` / `wire` tabs. `[data-testid="event-row"]` with attribute-encoded fields for blackbox specs |
| `src/ui/Composer.tsx` | Send button morphs to Stop while `status==="streaming"` (M12) |
| `src/ui/StatusBar.tsx` | Mount path / model / session id pill + Unmount button |
| `src/ui/DirectoryGate.tsx` | Pick / Re-grant flow — `requestPermission` MUST run from a click handler (FSA spec) |
| `src/ui/MessageList.tsx` | Renders text messages and `<ToolCallCard>` interleaved by store order |
| `src/ui/ToolCallCard.tsx` | `[data-testid="tool-call"][data-tool-name][data-tool-status]` |
| `src/ui/commands.ts` | Slash-command dispatcher — `/help`, `/model`, `/sessions`, `/new`, `/resume`, `/close`, `/delete` |
| `e2e/fixtures.ts` | Auto-seeds default workspace; exposes `chat: ChatPage` and `events: EventsPanel` fixtures |
| `e2e/helpers/seed.ts` | `seedWorkspace(page, seed)` → `addInitScript` injection (the only sanctioned whitebox bridge) |
| `e2e/pages/ChatPage.ts` | Page Object — `messages(role)`, `toolCalls({name?, status?})`, `waitForState`, `lastMessage` |
| `e2e/pages/EventsPanel.ts` | Page Object — `lifecycleRows({type?, toolName?})`, `wireRows({method?, direction?, kind?, rpcId?})`, `selectTab` |
| `e2e/examples/` | Mountable demo workspace (commands + skills + sample data) for manual smoke |

## Source code rules

- **No `node:*` imports in `src/**`.** ESLint's `no-restricted-imports` enforces it. Anything Node-shaped goes through the `vite-plugin-node-polyfills` includes (`path`, `buffer`, `events`, `stream`, `util`) or our `crypto-shim.ts` alias.
- **No `@bodhiapp/bodhi-pi-node` imports.** That package is for `bodhi-pi-cli` only; pulling it into the browser bundle bloats it with `better-sqlite3` natives. Repo-level `check:browser-smoke` guards.
- **Worker file uses `/// <reference lib="webworker" />`.** `self` is `DedicatedWorkerGlobalScope`. `import` paths must resolve at build time — Vite handles `new URL('./worker.ts', import.meta.url)` for the spawn.
- **`InitMessage` is the worker's only contract.** Add fields here when the worker needs more from the host. Handle is structured-cloneable across `postMessage`, no separate sidechannel needed for v1.
- **`bootstrap.ts` is the single seam for FSA-vs-seed.** The runtime/test distinction is encapsulated by a `WorkspaceProvider` interface (returned from `bootstrapWorkspace`); downstream code (App, DirectoryGate, RuntimeProvider, runtime, worker, InitMessage) must not branch on `workspace.mode` or read `window.__bodhiPiWebSeed`/`window.showDirectoryPicker`. Those globals stay file-local to `bootstrap.ts`.
- **No `recordEvents` flag, no `window.*` event log.** Event capture is unconditional — the worker registers handlers + the wire-tap on every boot and posts records to the main thread, which pushes into `useEventStore`. Specs read panel rows via DOM locators, not `page.evaluate`. The only sanctioned whitebox bridge in the e2e suite is the FSA seed (`__bodhiPiWebSeed`) — which has no DOM-side equivalent.
- **`requestPermission` must run from a user gesture.** That's why `DirectoryGate.tsx` calls it directly inside the button click. After `showDirectoryPicker({mode:"readwrite"})` resolves, the handle is already granted — do NOT call `requestPermission` again, the activation token is consumed (manual smoke caught this in M7 hardening).
- **Vite dev port is `35173 --strictPort`.** Playwright `webServer.reuseExistingServer: false`. Fail loud on conflicts; never silently hijack another app's port.
- **`AsyncFunction`-based `ScriptExecutor` requires `unsafe-eval` CSP.** Vite dev/preview have no CSP by default. Document for production deploys.
- **No hardcoded default model.** `bodhi-pi` core no longer falls back to a fixed model id. The host derives the initial model from configured provider auth (`VITE_OPENAI_API_KEY`, `VITE_ANTHROPIC_API_KEY`, etc.); when none resolves, the runtime exposes `currentModelId === null` and the UI must hint to add a provider or pick a model. Anthropic registers as a switch target only when `VITE_ANTHROPIC_API_KEY` is set.
- **Don't peek inside the worker.** Cross-realm boundary; assertions go through ACP notifications + the chat store. Mirrors bodhi-pi's "drive via `ClientSideConnection` only" rule.

## Test conventions

- **One Playwright spec per feature**, ported from a corresponding `bodhi-pi/e2e/*.e2e.ts` test where possible. Same prompts, same assertion patterns, real provider-backed models (`gpt-4o-mini` is the conventional cheap-default the suite seeds when `VITE_OPENAI_API_KEY` is set; the runtime no longer guarantees it). Cross-provider parity in `cross-provider.spec.ts`.
- **Use `data-testid` selectors via the POM.** No CSS selectors in specs. Add new locators to `e2e/pages/ChatPage.ts` (chat surface) or `e2e/pages/EventsPanel.ts` (lifecycle/wire observability) rather than inlining.
- **No `page.evaluate` / `window.*` reads.** Every observable signal (chat state, tool cards, lifecycle events, ACP wire frames) is exposed via DOM `data-*` attributes and asserted through Playwright locators. The single sanctioned exception is the FSA-seed `addInitScript` in `helpers/seed.ts`; everything else flows through `<EventsPanel>`.
- **Assert via auto-retrying matchers** (`toContainText`, `toHaveAttribute`, `toHaveCount`). `chat.send` doesn't await the slash-command handler — one-shot snapshots race against React commits. The capture-sessionId pattern (`expect(sysLocator).toContainText(/sessions:/); const sys = await sysLocator.textContent();`) is the canonical workaround.
- **Workspace seed lives in `test.use({ workspaceSeed })`.** Each describe gets its own clean folder; tests don't share state.
- **Seed bytes live on disk under `e2e/data/<scenario>/`.** Specs build seeds via `loadScenario(name)` from `e2e/helpers/seed.ts` (recursive walk → flat `Record<seedPath, utf8>`); inline string literals are reserved for trivial cases like `files: {}`. Mirrors cli's `test/fixtures/<scenario>/` pattern; cli-mirroring scenarios (`commands-echo`, `commands-say-tuesday`, `skills-say-hello`, `skills-days-since-birthday`, `extensions-redact-secrets`) carry the same bytes as cli except `skills-days-since-birthday/SKILL.md` bakes in `/mnt/demo/...` instead of cli's `{SCRIPT_PATH}` placeholder (web's mount path is deterministic, so no runtime templating needed).
- **Session storage / IndexedDB is per-context.** Playwright spawns a fresh browser context per test → tests are isolated automatically.
- **`workers: 1, fullyParallel: false`.** Real LLM rate limits + the `webServer` dev server are single-tenant. Don't change this without measuring.
- **No e2e for cancel button.** The default OpenAI model (typically `gpt-4o-mini`) finishes too fast to reliably catch the streaming state in automation. Manual smoke verified.
- **Examples folder is for humans, not specs.** Specs continue using their own programmatic seeds for locality. `e2e/examples/` is mounted manually via the FSA picker.

## Milestone history

M1–M5 in `ai-docs/plans/web-m1-to-m5.md` (transport + UI + agent + model switch + sessions). M6–M11 in `ai-docs/plans/what-we-want-to-purrfect-newell.md` historical revisions (Dexie + ZenFS-FSA + tool cards + commands + skills + scripted skills). M12–M16 in the same plan file (cancel button + Anthropic + edit/ls/find + tool-failure/replay + skills/commands edge cases). 21 specs total green; 25 unit tests in `bodhi-pi-browser`. See git log for the per-milestone commit messages.
