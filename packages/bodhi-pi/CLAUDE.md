# bodhi-pi

ACP-speaking coding agent. Hosts inject `Filesystem`, `SessionStore`, `ScriptExecutor`; this package owns ACP wire, session lifecycle, and built-in tools.

**DEVELOPMENT.md** covers: Node/toolchain setup, verification commands, ENV files, comments policy, test architecture, test helper catalog, stub strategy (aimock vs faux provider), e2e model selection, and external reference paths (coding-agent, ACP spec, SDK types).

## Architecture pillars

**ACP is the public contract.** Drive via `AgentSideConnection` only. Internal `pi-agent-core` types and session-store impl types (`SessionEntry`, `SessionInfo`, `SessionRecord`) are not re-exported. Tests go through `ClientSideConnection` — never touch the inner `Agent` directly.

**No silent defaults.** Missing required `BodhiPiConfig` field → factory throws. Mandatory: `models`, `defaultModelId`, `getApiKey`, `sessionStore`, `filesystem`. Optional: `scriptExecutor` (skills register `run_script` only when present), `systemPrompt` (pi-agent-core's empty-string default otherwise).

**Stable ACP over `unstable_*`.** Non-spec features use `_bodhi-pi/<area>/<verb>` extensions, advertised via `agentCapabilities._meta["bodhi-pi"]`.

**Mirror coding-agent.** Read `packages/coding-agent/` first, strip TUI/Node parts, replicate field/method shape.

**Reuse dependency types.** Use `pi-agent-core`'s `AgentOptions`, `pi-ai`'s `Model<Api>`, ACP SDK's types directly — no wrapper types until a real semantic mismatch.

## Reference clients & publishable adapters

`bodhi-pi` is **runtime-agnostic** — Filesystem, SessionStore, ScriptExecutor are host-injected. Four reference hosts and two adapter packages prove every feature works across Node, browser-only, and split (server + browser, two transports) deployments:

| Package | Role | Status |
|---|---|---|
| `packages/bodhi-pi-cli` | Reference Node host (REPL CLI) | private workspace package |
| `packages/bodhi-pi-web` | Reference browser host (Vite/React + Web Worker, single-tenant) | private workspace package |
| `packages/bodhi-pi-ws-server` + `packages/bodhi-pi-ws-frontend` | Reference split host — Node WS server (multi-tenant SQLite, ACP over WebSocket) + thin React frontend | private workspace package pair |
| `packages/bodhi-pi-http` | Reference HTTP+SSE split host — single Node project (server+frontend in one package), ACP over MCP-Streamable-HTTP, **per-turn agent rebuild** (proves serialize/deserialize deployment) | private workspace package |
| `packages/bodhi-pi-node` | Publishable Node adapters (`@bodhiapp/bodhi-pi-node`) — `createNodeFilesystem`, `createSqliteSessionStore`, `createNodeScriptExecutor` | publishable npm package |
| `packages/bodhi-pi-browser` | Publishable browser adapters (`@bodhiapp/bodhi-pi-browser`) — `createZenfsFilesystem`, `createDexieSessionStore`, `createBrowserScriptExecutor`, `createMessagePortStream` | publishable npm package |

The adapter packages exist so any third-party host (a different CLI, a desktop wrapper, an extension) can `npm i @bodhiapp/bodhi-pi @bodhiapp/bodhi-pi-{node,browser}` and skip the reference-client code entirely.

## Runtime-host parity rule

Every user-visible feature MUST land in **all four reference hosts**: `bodhi-pi-cli`, `bodhi-pi-web`, the `bodhi-pi-ws-server` + `bodhi-pi-ws-frontend` pair, and `bodhi-pi-http`. Functional parity is required, technical parity is not — different runtimes (Node CLI vs. browser worker vs. WebSocket split vs. HTTP+SSE split) get to use whichever transport / storage / extension-loader fits, but the user-observable behavior and the e2e assertions MUST line up.

A PR that adds a feature to one host without the others is a regression by default. Either:
- include parity changes in the same PR (preferred), or
- explicitly justify and file follow-up work for the missing hosts in the PR description.

Each host's CLAUDE.md carries its own per-runtime feature inventory; treat those inventories as one set of four lenses on the same surface. `bodhi-pi-http` is the **deployment-portability lens**: same agent, same features, but state lives in storage between every turn (per-turn agent rebuild from SQLite).

## Feature workflow (TDD across the matrix)

Every new agent feature lands in this order. **Skipping any step is a regression risk** because Node-only or browser-only assumptions creep in fast:

1. **`bodhi-pi/test/*.test.ts`** — failing integration test against an in-process ACP pair using faux providers / aimock + the in-memory adapter helpers. Make it pass in `src/`.
2. **`bodhi-pi/e2e/*.e2e.ts`** — gpt-4o-mini round-trip proving the feature reaches a real LLM. Use real adapter helpers (not mocks).
3. **`bodhi-pi-node/`** — if the feature requires a host-side adapter (FS, sessions, scripts), implement it here. Add unit tests in `bodhi-pi-node/test/`.
4. **`bodhi-pi-browser/`** — same surface, browser-shaped (ZenFS, Dexie, AsyncFunction). Add unit tests in `bodhi-pi-browser/src/**/*.test.ts` (vitest + fake-indexeddb).
5. **`bodhi-pi-cli/e2e/*.e2e.ts`** — Node host wires through the new feature. Real LLM, real adapters, asserts the feature reaches the user.
6. **`bodhi-pi-web/e2e/*.spec.ts`** — Playwright spec, same shape as the CLI e2e but driven through Chrome + the worker. Real LLM, seeded `window.__bodhiPiWebSeed` workspace.
7. **`bodhi-pi-http/test/integration/*.test.ts`** — server-side integration test (faux provider) proving the feature works under per-turn agent rebuild (each prompt = fresh agent re-hydrated from SQLite). Add `bodhi-pi-http/e2e/*.e2e.ts` for cross-turn behaviors that need a real LLM (e.g., history continuity).

**Why both reference clients?** Browser-only quirks (FSA permission re-grant after picker, ZenFS async-only, AsyncFunction CSP needs) and Node-only quirks (better-sqlite3 native bindings, child_process spawn ergonomics) only surface in the host. The agent's own e2e can't catch them. The two reference clients are our cross-runtime regression net.

**Examples folder for manual smoke.** `packages/bodhi-pi-web/e2e/examples/` is a real on-disk demo workspace with `.bodhi-pi/commands/`, `.bodhi-pi/skills/`, and seeded data files — mount via Chrome's FSA picker to exercise every feature without running the test suite.

## Key files

| Path | Role |
|---|---|
| `src/index.ts` | Public exports barrel |
| `src/version.ts` | `BODHI_PI_VERSION` — bump alongside `package.json` |
| `src/acp/agent.ts` | `createBodhiPiAgent` factory + `BodhiPiAcpAgent` class |
| `src/acp/notifications.ts` | ACP-shape helpers + `isAssistantMessage`/`isToolResultMessage` guards |
| `src/wire/constants.ts` | `MODEL_CONFIG_ID`, `EXT_DELETE_SESSION`, `LIFECYCLE_EVENT_METHOD` |
| `src/sessions/session-store.ts` | `SessionStore` interface + `SessionEntry` union |
| `src/sessions/in-memory-session-store.ts` | `createInMemorySessionStore()` helper |
| `src/filesystem/filesystem.ts` | `Filesystem` interface |
| `src/filesystem/in-memory-filesystem.ts` | `createInMemoryFilesystem()` helper |
| `src/tools/index.ts` | `createBuiltinTools({ filesystem, cwd, scriptExecutor? })` |
| `src/tools/_accumulate.ts` | `accumulateBounded` + `truncationFooter` — canonical truncation for ls/find/grep |
| `src/commands/` | Prompt-template discovery + expansion |
| `src/skills/` | Skill discovery + activation |
| `src/script-executor/` | `ScriptExecutor` interface |
| `test/helpers/harness.ts` | `createTestHarness(...)` — single source of truth for ACP test wiring |

## Source code rules

- **No fallbacks.** Throw at factory time if required field missing. `systemPrompt` is the sole exception.
- **No `node:fs` in core, but `Filesystem`-based walks are allowed.** Core never imports `node:fs`/`node:os`. Walks over project-rooted files (AGENTS.md / CLAUDE.md, `.bodhi-pi/settings.json`, `.bodhi-pi/commands/`, `.bodhi-pi/skills/`) go through the injected `Filesystem`. The walk starts at the session `cwd` and ascends ancestors using `path.posix.dirname` — terminates naturally when the host's mount root is reached (FSA-rooted browser hosts) or at `/` for Node.
- **ACP `fs/*` methods are deliberately absent** — orthogonal to our host-injected `Filesystem`.

## pi-agent-core import policy

`src/acp/agent.ts` imports `Agent` directly from `@earendil-works/pi-agent-core/dist/agent.js`, NOT from the package barrel. This is **intentional and must not be "fixed"** by future agents.

- Upstream `@earendil-works/pi-agent-core` (= `packages/agent`) is no longer runtime-neutral. Its barrel re-exports `harness/session/repo/jsonl.ts`, `harness/session/storage/jsonl.ts`, `harness/session/storage/memory.ts`, `harness/utils/shell-output.ts`, and `harness/env/nodejs.ts` — all of which directly import `node:child_process`, `node:crypto`, `node:fs`, `node:fs/promises`, `node:os`, `node:path`.
- bodhi-pi must run in browser-shipped runtimes (`bodhi-pi-browser`, `bodhi-pi-web`, `bodhi-pi-chrome-ext`). Importing the barrel pulls in those Node-only modules transitively; bundlers' tree-shaking does not reliably strip them because the harness modules have side-effecting top-level `import` statements.
- The `dist/agent.js` deep import gives us only the `Agent` class plus its `pi-ai` dependencies — no Node-specific transitive baggage. Tree-shaking is a non-concern because the import graph is already minimal.
- Type-only imports from `@earendil-works/pi-agent-core` (e.g., `AgentMessage`, `AgentTool`, `AgentToolResult`) are fine — they erase at compile time and don't pull runtime modules.
- Review finding A.3 in `ai-docs/reviews/2026-05-11-bodhi-pi-tech-debt.md` proposed swapping the `dist/` import for the barrel. That finding is obsolete; the analysis above supersedes it (see Decision log entry dated 2026-05-12).

## Test conventions

- No `if (cond) { expect(...) }` — use narrowing helpers and `expect(val, "diag").toBe(...)`.
- No milestone IDs in filenames (`chat.test.ts` not `m2_1_chat.test.ts`).
- Shared helpers live in `test/helpers/` — never duplicate.
- Tool-call tests: prefer `registerFauxProvider` over aimock (aimock SSE isn't always parsed for tool-call rounds).
- `vitest.e2e.config.ts` does NOT use `mergeConfig` — composes `test.include` directly.
- e2e: assert side-effects and stable substrings, not exact model text.
- Per-feature e2e uses `gpt-4o-mini` (non-reasoning). Cross-provider parity lives in `e2e/chat.e2e.ts`.
