# bodhi-pi-web

Reference browser host for `@bodhiapp/bodhi-pi`. Vite + React + TypeScript app on the main thread; agent runs in a dedicated Web Worker. Main↔Worker speaks ACP framed over `MessagePort`. Feature-equivalent to `bodhi-pi-cli` — every bodhi-pi capability has a Playwright spec here proving it works through the worker against a real LLM.

`README.md` covers user-facing setup. `ai-docs/plans/` carries the milestone plans (M1–M16) with rationale for each design choice.

## Architecture pillars

**Agent + adapters live entirely in the worker.** Main thread holds a `ClientSideConnection` and the React UI. The worker constructs `Filesystem`, `SessionStore`, `ScriptExecutor` from `@bodhiapp/bodhi-pi-browser` and feeds them to `createBodhiPiAgent`. No agent logic on the main thread.

**ACP transport is byte-stream over `MessagePort`.** Worker spawn → `MessageChannel` → main posts `{ type: "init", agentPort: port2 }` (transferable). Both sides wrap their port via `createMessagePortStream(port)` from `bodhi-pi-browser`, then feed it to ACP SDK's `ndJsonStream` to get a `Stream` for `ClientSideConnection` (main) / `AgentSideConnection` (worker).

**Workspace is single-folder, FSA-backed, persistent.** Chrome `showDirectoryPicker({ mode: "readwrite" })` returns a `FileSystemDirectoryHandle`; we save it in IndexedDB via `idb-keyval`. ZenFS's `WebAccess` backend wraps it; `vfs.mount(/mnt/<handle.name>, backend)` exposes it through the Node-fs-shaped API bodhi-pi expects. The agent's `cwd` is `/mnt/<handle.name>`.

**Boot gate is non-skippable.** No granted handle → `<DirectoryGate>` blocks the chat surface. After grant → `<RuntimeProvider>` mounts → worker spawns → ACP `initialize` → `loadSession` (if last id in `sessionStorage`) or `newSession`. Status flips `initializing → idle`.

**Slash commands route on the main thread.** A line starting with `/` whose name is NOT in `availableCommands` (announced by the agent via `available_commands_update`) runs locally via `ui/commands.ts`. Anything else forwards to `conn.prompt` — bodhi-pi expands project-defined commands and skills before the LLM sees them. Source pattern lifted from `bodhi-pi-cli/src/repl/commands.ts`.

**Tests bypass the FSA picker via seed injection.** Playwright `addInitScript` sets `window.__bodhiPiWebSeed = { name, files }` before page load; `bootstrap.ts` short-circuits past IndexedDB and the picker, mounting an `InMemory` ZenFS backend with the seed files. No CDP flags, no native dialogs in CI.

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
| `src/store/chatStore.ts` | Zustand store. Messages with optional `toolCall` for inline tool-call cards |
| `src/ui/RuntimeProvider.tsx` | Owns `conn`, sessionId, models, availableCommands. Exposes `prompt`, `cancelPrompt`, `unmount` via React context |
| `src/ui/ChatPage.tsx` | `<StatusBar/><MessageList/><Composer/>` |
| `src/ui/Composer.tsx` | Send button morphs to Stop while `status==="streaming"` (M12) |
| `src/ui/StatusBar.tsx` | Mount path / model / session id pill + Unmount button |
| `src/ui/DirectoryGate.tsx` | Pick / Re-grant flow — `requestPermission` MUST run from a click handler (FSA spec) |
| `src/ui/MessageList.tsx` | Renders text messages and `<ToolCallCard>` interleaved by store order |
| `src/ui/ToolCallCard.tsx` | `[data-testid="tool-call"][data-tool-name][data-tool-status]` |
| `src/ui/commands.ts` | Slash-command dispatcher — `/help`, `/model`, `/sessions`, `/new`, `/resume`, `/close`, `/delete` |
| `e2e/fixtures.ts` | Auto-seeds default workspace; specs override via `test.use({ workspaceSeed })` |
| `e2e/helpers/seed.ts` | `seedWorkspace(page, seed)` → `addInitScript` injection |
| `e2e/pages/ChatPage.ts` | Page Object — `messages(role)`, `toolCalls({name?, status?})`, `waitForState`, `lastMessage` |
| `e2e/examples/` | Mountable demo workspace (commands + skills + sample data) for manual smoke |

## Source code rules

- **No `node:*` imports in `src/**`.** ESLint's `no-restricted-imports` enforces it. Anything Node-shaped goes through the `vite-plugin-node-polyfills` includes (`path`, `buffer`, `events`, `stream`, `util`) or our `crypto-shim.ts` alias.
- **No `@bodhiapp/bodhi-pi-node` imports.** That package is for `bodhi-pi-cli` only; pulling it into the browser bundle bloats it with `better-sqlite3` natives. Repo-level `check:browser-smoke` guards.
- **Worker file uses `/// <reference lib="webworker" />`.** `self` is `DedicatedWorkerGlobalScope`. `import` paths must resolve at build time — Vite handles `new URL('./worker.ts', import.meta.url)` for the spawn.
- **`InitMessage` is the worker's only contract.** Add fields here when the worker needs more from the host. Handle is structured-cloneable across `postMessage`, no separate sidechannel needed for v1.
- **`bootstrap.ts` is the single seam for FSA-vs-seed.** The runtime/test distinction is encapsulated by a `WorkspaceProvider` interface (returned from `bootstrapWorkspace`); downstream code (App, DirectoryGate, RuntimeProvider, runtime, worker, InitMessage) must not branch on `workspace.mode` or read `window.__bodhiPiWebSeed`/`window.showDirectoryPicker`. Those globals stay file-local to `bootstrap.ts`. `recordEvents` derivation belongs to the worker (`workspace.isTest`) — do not thread it as a separate `InitMessage` field.
- **`requestPermission` must run from a user gesture.** That's why `DirectoryGate.tsx` calls it directly inside the button click. After `showDirectoryPicker({mode:"readwrite"})` resolves, the handle is already granted — do NOT call `requestPermission` again, the activation token is consumed (manual smoke caught this in M7 hardening).
- **Vite dev port is `35173 --strictPort`.** Playwright `webServer.reuseExistingServer: false`. Fail loud on conflicts; never silently hijack another app's port.
- **`AsyncFunction`-based `ScriptExecutor` requires `unsafe-eval` CSP.** Vite dev/preview have no CSP by default. Document for production deploys.
- **Default model stays `gpt-4o-mini`.** Anthropic registers as a switch target only when `VITE_ANTHROPIC_API_KEY` is set.
- **Don't peek inside the worker.** Cross-realm boundary; assertions go through ACP notifications + the chat store. Mirrors bodhi-pi's "drive via `ClientSideConnection` only" rule.

## Test conventions

- **One Playwright spec per feature**, ported from a corresponding `bodhi-pi/e2e/*.e2e.ts` test where possible. Same prompts, same assertion patterns, real `gpt-4o-mini`. Cross-provider parity in `cross-provider.spec.ts`.
- **Use `data-testid` selectors via the POM.** No CSS selectors in specs. Add new locators to `e2e/pages/ChatPage.ts` rather than inlining.
- **Assert via auto-retrying matchers** (`toContainText`, `toHaveAttribute`, `toHaveCount`). `chat.send` doesn't await the slash-command handler — one-shot snapshots race against React commits. The capture-sessionId pattern (`expect(sysLocator).toContainText(/sessions:/); const sys = await sysLocator.textContent();`) is the canonical workaround.
- **Workspace seed lives in `test.use({ workspaceSeed })`.** Each describe gets its own clean folder; tests don't share state.
- **Session storage / IndexedDB is per-context.** Playwright spawns a fresh browser context per test → tests are isolated automatically.
- **`workers: 1, fullyParallel: false`.** Real LLM rate limits + the `webServer` dev server are single-tenant. Don't change this without measuring.
- **No e2e for cancel button.** gpt-4o-mini finishes too fast to reliably catch the streaming state in automation. Manual smoke verified.
- **Examples folder is for humans, not specs.** Specs continue using their own programmatic seeds for locality. `e2e/examples/` is mounted manually via the FSA picker.

## Milestone history

M1–M5 in `ai-docs/plans/web-m1-to-m5.md` (transport + UI + agent + model switch + sessions). M6–M11 in `ai-docs/plans/what-we-want-to-purrfect-newell.md` historical revisions (Dexie + ZenFS-FSA + tool cards + commands + skills + scripted skills). M12–M16 in the same plan file (cancel button + Anthropic + edit/ls/find + tool-failure/replay + skills/commands edge cases). 21 specs total green; 25 unit tests in `bodhi-pi-browser`. See git log for the per-milestone commit messages.
