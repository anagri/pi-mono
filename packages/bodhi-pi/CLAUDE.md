# bodhi-pi

ACP-speaking coding agent. Hosts inject `Filesystem`, `SessionStore`, `ScriptExecutor`; this package owns ACP wire, session lifecycle, and built-in tools.

**DEVELOPMENT.md** covers: Node/toolchain setup, verification commands, ENV files, comments policy, test architecture, test helper catalog, stub strategy (aimock vs faux provider), e2e model selection, and external reference paths (coding-agent, ACP spec, SDK types).

**Specs are living docs.** `ai-docs/specs/bodhi-pi/` (index, architecture, acp, lifecycle, mcp, extensions-skills-commands, hosts, testing, configuration, client-sdk-seed) + `CONTEXT.md` (glossary) are the source-of-truth architecture map. **Any change to the ACP surface (native or `_bodhi-pi/*`), session lifecycle, MCP wiring, the Host/Client boundary, a new reference Host, or a major feature MUST land with a same-commit spec update.** Touched-method → update `acp.md`'s table + sequence diagrams if behaviour changed. Touched-entry-type → update `lifecycle.md` SessionEntry table. New term → update `CONTEXT.md`. New Host or adapter shape → update `hosts.md`. Stale specs are a regression by default. If unsure where it lands, update `index.md`'s "Read this if…" pointer.

Keep comments to minimal. Do not add comments unless it adds to the code laid out because of some quirks/hackiness in the behaviour.

## Trunk-based development

This repo follows **trunk-based development**: all changes land directly on `main` as small, individually-green commits. There are **no pull requests, no review branches, no merge queues**. Each commit must pass `npm run check`, `npm test`, and (for changes that touch the matrix) `just test-e2e` + `just test-e2e-ui` on its own — bisecting the trunk is the contract that keeps trunk-based development safe.

Practical implications when working in this repo:
- Don't write "in this PR …" / "per the PR description" / "review at PR time" — there is no PR. Write "in this commit", "per the commit message", or just describe what changed.
- Branch only as a private working space; rebase frequently and fast-forward into `main` when done. Long-lived feature branches are an anti-pattern here.
- Don't ask Claude to `gh pr create` or open a pull request — the workflow does not use them.
- Cross-cutting changes (e.g. parity work that touches all four reference Hosts) still land as a sequence of commits, but each intermediate commit must keep the trunk green.

## Architecture pillars

**ACP is the public contract.** Drive via `AgentSideConnection` only. Internal `pi-agent-core` types and session-store impl types (`SessionEntry`, `SessionInfo`, `SessionRecord`) are not re-exported. Tests go through `ClientSideConnection` — never touch the inner `Agent` directly.

**No silent defaults.** Missing required `BodhiPiConfig` field → factory throws. Mandatory: `models`, `defaultModelId`, `getApiKey`, `sessionStore`, `filesystem`. Optional: `scriptExecutor` (skills register `run_script` only when present), `systemPrompt` (pi-agent-core's empty-string default otherwise).

**Stable ACP over `unstable_*`.** Non-spec features use `_bodhi-pi/<area>/<verb>` extensions, advertised via `agentCapabilities._meta["bodhi-pi"]`.

**Mirror coding-agent (headless-only).** Read `packages/coding-agent/` first, strip TUI/Node parts, replicate field/method shape. bodhi-pi has no TUI surface — `registerShortcut`/`registerMessageRenderer`/`registerFlag` and `ctx.ui.*` are intentionally absent from `ExtensionAPI` (`src/extensions/types.ts:75-80`). Naming divergences are formalised in `CONTEXT.md` flagged-ambiguities (e.g. `extension` vs `custom` SessionEntry type).

**Reuse dependency types.** Use `pi-agent-core`'s `AgentOptions`, `pi-ai`'s `Model<Api>`, ACP SDK's types directly — no wrapper types until a real semantic mismatch.

**Major components expose lifecycle events on both rails.** When a new domain service (sub-agent spawn, MCP connect/disconnect, OAuth flow, future "background job runner", etc.) has lifecycle moments (start, end, status-change), it MUST:

1. Define a typed event on `EventDispatcher` (`src/events/types.ts`) and emit it from the service.
2. Forward that event to the wire in `src/acp/event-wiring.ts` via `notifyLifecycle(...) → conn.extNotification(LIFECYCLE_EVENT_METHOD, params)`.
3. Document the wire shape in `ai-docs/specs/bodhi-pi/acp.md` under the `LIFECYCLE_EVENT_METHOD notifications` section, same commit.
4. Add a regression test in `test/` that captures `harness.extNotifications` and asserts the event shape — internal event handlers passing is NOT proof the wire forwarder runs.

Both rails matter. The in-process `pi.on("subagent_start", …)` hook lets extensions react inside the agent process; the wire-level `LIFECYCLE_EVENT_METHOD` notification lets remote clients (web UIs, chrome-ext panels, third-party host integrations) react across the ACP boundary. Skipping the wire forwarder is invisible from the agent's own tests and surfaces only as missing-UI-grouping bugs (cf. v2 subagent transcript grouping shipped grouping-blind because the forwarder was never wired; commit `bafdb900` retro-fixed it).

## Reference Hosts

`bodhi-pi` is **runtime-agnostic** — Filesystem, SessionStore, KvStore, ScriptExecutor, Terminal, McpConnectionProvider are all Host-injected. Four reference Hosts under `test-apps/` prove every feature works across the runtime matrix; shared adapter sets live as sibling infrastructure packages.

| Package | Role |
|---|---|
| `packages/bodhi-pi/test-apps/cli` | Node REPL/headless/RPC Host — stdio Transport, single-tenant SQLite |
| `packages/bodhi-pi/test-apps/http` | HTTP+SSE Host (with WebSocket sibling) — multi-tenant SQLite, **per-turn agent rebuild** (proves serialize/deserialize deployment) |
| `packages/bodhi-pi/test-apps/browser` | Browser Host (Vite/React + Web Worker, ZenFS + Dexie, `MessagePort` Transport) |
| `packages/bodhi-pi/test-apps/chrome-ext` | Chrome MV3 extension Host — same browser adapters + sandbox iframe for unsafe-eval |
| `packages/bodhi-pi/test-apps/node-adapters` | **Shared infrastructure** — Node-side adapters (`createNodeFilesystem`, `createNodeKvStore`, SQLite session stores, `createNodePackageExtensionLoader`, `createBashTerminal`) consumed by cli + http |
| `packages/bodhi-pi/test-apps/app-utils` | **Shared infrastructure** — cross-runtime utilities (`pickDefined`, just-bash adapters) consumed by all four Hosts |

See `ai-docs/specs/bodhi-pi/hosts.md` for full per-Host wiring + Host/Client role split per file.

### Host/Client seam enforcement

Each Reference Host's source lives under `test-apps/<host>/src/{host,client}/`. The seam between the two folders is enforced by `scripts/check-host-client-seam.mjs` (wired into root `npm run check`). A file under `host/` MAY NOT relative-import from `client/` and vice versa. Cross-package imports (`@bodhiapp/...`) are unrestricted — they cross at a published package boundary on purpose.

**Override mechanism**: when a cross-side import is genuinely necessary, put `// seam-exception: <reason>` on the line immediately above the import (or trailing on the same line). The reason MUST be a one-line human explanation, not just a marker.

```ts
// seam-exception: shared port-factory shape; Host uses the same Transferable type
import type { PortBundle } from "../client/acp/port-bundle.ts";
```

Exceptions are reviewed at commit time; prefer refactoring (move the shared symbol to `app-utils/`) over an exception when the type or function is genuinely runtime-neutral.

> **Deprecated reference**: `packages/bodhi-pi-{cli,web,http,ws-server,ws-frontend,chrome-ext,node,browser}` are the previous generation of test apps. They are **not maintained** — historical reference only. All new work lands under `test-apps/`.

## Runtime-Host parity rule

Every user-visible feature MUST land in **all four reference Hosts**: `test-apps/cli`, `test-apps/http`, `test-apps/browser`, `test-apps/chrome-ext`. Functional parity is required, technical parity is not — different runtimes (Node CLI vs. browser Worker vs. HTTP+SSE split vs. chrome-ext sandbox) get to use whichever Transport / storage / extension-loader fits, but the user-observable behavior and the e2e assertions MUST line up.

A commit that adds a feature to one Host without the others is a regression by default. Either:
- include parity changes in the same commit (or a tight sequence of commits, each individually green), or
- explicitly justify the missing Hosts in the commit message and file a follow-up task before landing.

`test-apps/http` is the **deployment-portability lens**: same agent, same features, but state lives in storage between every turn (per-turn agent rebuild from SQLite).

## Feature workflow (TDD across the matrix)

Every new agent feature lands in this order. **Skipping any step is a regression risk** because Node-only or browser-only assumptions creep in fast:

1. **`packages/bodhi-pi/test/*.test.ts`** — failing integration test against an in-process ACP pair using faux providers / aimock + in-memory adapters from `src/`. Make it pass in `src/`.
2. **`packages/bodhi-pi/e2e/*.e2e.ts`** — gpt-4o-mini round-trip proving the feature reaches a real LLM. Use real adapter helpers (not mocks).
3. **`packages/bodhi-pi/test-apps/node-adapters/`** — if the feature requires a Node-side adapter (FS, sessions, scripts, terminal, KV), implement it here. Add unit tests under the same package.
4. **`packages/bodhi-pi/test-apps/browser/src/host/`** — same surface, browser-shaped (ZenFS, Dexie, AsyncFunction). Add unit tests (vitest + fake-indexeddb). chrome-ext consumes the same Host-side code via `@bodhiapp/bodhi-pi-test-app-browser/host/*` subpath imports so changes flow there automatically.
5. **`packages/bodhi-pi/test-apps/cli/e2e/*.e2e.ts`** — cli Host wires through the new feature. Real LLM, real adapters, asserts the feature reaches the user.
6. **`packages/bodhi-pi/test-apps/browser/e2e/*.spec.ts`** + **`packages/bodhi-pi/test-apps/chrome-ext/e2e/*.spec.ts`** — Playwright specs, same shape as the cli e2e but driven through Chrome + the Worker. Real LLM, seeded workspace.
7. **`packages/bodhi-pi/test-apps/http/test/integration/*.test.ts`** — server-side integration test (faux provider) proving the feature works under per-turn agent rebuild (each prompt = fresh agent re-hydrated from SQLite). Add `test-apps/http/e2e/*.e2e.ts` for cross-turn behaviors that need a real LLM (e.g., history continuity).

**Why all four reference Hosts?** Browser-only quirks (FSA permission re-grant after picker, ZenFS async-only, AsyncFunction CSP needs) and Node-only quirks (better-sqlite3 native bindings, child_process spawn ergonomics) only surface in the Host. The agent's own e2e can't catch them. The four reference Hosts are our cross-runtime regression net.

**Examples folder for manual smoke.** Each browser Host carries an on-disk demo workspace with `.bodhi-pi/commands/`, `.bodhi-pi/skills/`, and seeded data files — mount via Chrome's FSA picker to exercise every feature without running the test suite.

## Key files

| Path | Role |
|---|---|
| `src/index.ts` | Public exports barrel |
| `src/version.ts` | `BODHI_PI_VERSION` — bump alongside `package.json` |
| `src/acp/agent.ts` | `createBodhiPiAgent` factory + `BodhiPiAcpAgent` class |
| `src/acp/notifications.ts` | ACP-shape helpers + `isAssistantMessage`/`isToolResultMessage` guards |
| `src/wire/constants.ts` | All `_bodhi-pi/<area>/<verb>` method names + `MODEL_CONFIG_ID`, `THINKING_CONFIG_ID`, `EXT_DELETE_SESSION`, `LIFECYCLE_EVENT_METHOD` |
| `src/sessions/session-store.ts` | `SessionStore` interface + `SessionRecord` / `SessionInfo` |
| `src/sessions/entries.ts` | `SessionEntry` discriminated union (`message`, `mcp_inclusion_set`, `branch_summary`, …) |
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
- **No `node:*` imports in `src/`. No Node globals (`Buffer`, `process`, `__dirname`).** `bodhi-pi/src/` ships into Node CLI, Node HTTP/WS server, browser Web Worker, and MV3 service worker bundles. Any `import … from "node:…"` traps when bundlers externalise it for the browser (e.g. Vite replaces `node:crypto` with a getter-stub that throws on first property read), breaking page load before a single line of agent code runs. Likewise, `Buffer` is a Node global that only works in browser bundles when `vite-plugin-node-polyfills` injects it — adding a polyfill dependency to every downstream Host is a tax we refuse to pay. Canonical replacements: `randomUUID` → `src/_internal/uuid.ts` (wraps `globalThis.crypto.randomUUID()`); POSIX path manipulation → `pathe` (named imports, drop `.posix.` since `pathe` already is POSIX); UTF-8 byte length / byte truncation → `src/_internal/utf8.ts` (`byteLengthUtf8`, `truncateBytesUtf8` over `TextEncoder`/`TextDecoder`). The injected `Filesystem` (NOT `node:fs`) still owns all file I/O — that rule is unchanged; this one extends it.
  - **One explicit exception.** `src/mcp/mcp-client.ts` uses a runtime-gated `await import("@modelcontextprotocol/sdk/client/stdio.js")` inside the stdio branch. That dynamic import resolves only when the Host advertises `supportsMcpStdio: true` (cli only); browser/Worker/MV3/HTTP Hosts pass `false`, the branch is dead, and the bundler does not statically pull `node:child_process`. Do not "fix" this to a top-level import.
- **ACP `fs/*` methods are deliberately absent** — orthogonal to our Host-injected `Filesystem`.

## MCP (Model Context Protocol)

First-party in `src/mcp/`. Decomposed into `McpService` (ACP methods + input dispatch + DCR flow) + `McpStore` (KV + inclusion-entry persistence) + `McpConnectionLifecycle` (connect/disconnect/hydrate + status broadcasts) + `McpRegistry` (per-session inclusion sets + tool fanout) + `KvOAuthProvider` + `OAuthStateKv` (OAuth 2.1 PKCE flow, token persistence, 5-min state TTL) + `oauth-state-token.ts` (cross-runtime state-token + base64url helpers, multi-tenant tenantId prefix) + `mcp-stdio-env.ts` (stdio env vector) + host-injected `McpConnectionProvider` (transports). Full architecture: `ai-docs/specs/bodhi-pi/mcp.md`.

| Surface | Where |
|---|---|
| Persisted config | KV under `mcp/<slug>` — secrets tagged `{value, secret: true}` and masked on ACP reads |
| Hydration | `agent.ts` calls `mcpService.hydrate(sessionId, params.mcpServers, restoredSlugs)` after `buildSessionStateFn` returns. The last `mcp_inclusion_set` entry on the active branch supplies `restoredSlugs`; ACP-native `mcpServers` from `NewSessionRequest` connect ephemerally and promote referenced slugs into the inclusion set |
| Tool surface | `McpRegistry` is per-session; on connect/disconnect/include/exclude it rebuilds `piAgent.state.tools` as `mergeTools(session.tools, registry.getVisibleTools(sessionId))`. Tool names are namespaced `<slug>__<tool>` |
| Slash commands | `/mcps`, `/mcp add|connect|disconnect|reconnect|remove|tools|include|exclude` |
| Extension methods | `_bodhi-pi/mcp/{add,remove,connect,disconnect,reconnect,list,tools,include,exclude}` |

**Connections are global per `<Host-instance, slug>`; visibility is per-session.** A stateless server Host (per-turn rebuild) loses every connection if it relies on the in-process default provider — each turn would reconnect from KV. Such Hosts MUST inject an `McpConnectionProvider` whose lifetime spans agent rebuilds. The reference implementation is `test-apps/http/src/host/mcp/server-mcp-store.ts`, which keys connections by `userId` and survives the per-turn agent rebuild. Single-tenant Hosts (cli, browser, chrome-ext) use the in-process default provider — connections die with the process / worker.

**Transports.** http-streamable everywhere; stdio in Node-spawnable Hosts only. Hosts that cannot spawn (`test-apps/browser`, `test-apps/chrome-ext`) and stateless rebuild Hosts (`test-apps/http`) MUST pass `supportsMcpStdio: false` when constructing the agent. `_bodhi-pi/mcp/add` with `command=` then rejects with `-32601` rather than silently saving an unusable entry.

**Auth.** Input discriminator on `_bodhi-pi/mcp/add` is `auth: "public" | "http-param" | "oauth-preregistered" | "oauth-dcr"` (`McpAuthInputMode`). Both oauth variants collapse to the persisted `McpAuthMode = "public" | "http-param" | "oauth"`; `dcrInfo` on the persisted entry records whether DCR ran and against which issuer. `"http-param"` carries sibling `headers?` and/or `queries?` (at least one required). Secret values (header/query values, `clientSecret`, `tokens.access/refresh`, `dcrInfo.registrationAccessToken`, stdio `env` values) are tagged `secret: true` internally and masked to `"***"` on every ACP-boundary read. Input → resolver dispatch lives in `AUTH_INPUT_RESOLVERS` (`src/mcp/mcp-service.ts`); transport-side attachment lives in `ATTACHERS` (`src/mcp/mcp-client.ts`). Known limitation: interactive `oauth/start` writes are NOT serialised against eager-refresh writes for the same `mcp/<slug>` key — multi-tab + concurrent refresh can race. See `ai-docs/plans/implement-plan-to-fix-enumerated-book.md` (deferred follow-up).

## pi-agent-core import policy

`src/acp/agent.ts` imports `Agent` directly from `@earendil-works/pi-agent-core/dist/agent.js`, NOT from the package barrel. This is **intentional and must not be "fixed"** by future agents.

- Upstream `@earendil-works/pi-agent-core` (= `packages/agent`) is no longer runtime-neutral. Its barrel re-exports `harness/session/repo/jsonl.ts`, `harness/session/storage/jsonl.ts`, `harness/session/storage/memory.ts`, `harness/utils/shell-output.ts`, and `harness/env/nodejs.ts` — all of which directly import `node:child_process`, `node:crypto`, `node:fs`, `node:fs/promises`, `node:os`, `node:path`.
- bodhi-pi must run in browser-shipped runtimes (`test-apps/browser`, `test-apps/chrome-ext`). Importing the barrel pulls in those Node-only modules transitively; bundlers' tree-shaking does not reliably strip them because the harness modules have side-effecting top-level `import` statements.
- The `dist/agent.js` deep import gives us only the `Agent` class plus its `pi-ai` dependencies — no Node-specific transitive baggage. Tree-shaking is a non-concern because the import graph is already minimal.
- Type-only imports from `@earendil-works/pi-agent-core` (e.g., `AgentMessage`, `AgentTool`, `AgentToolResult`) are fine — they erase at compile time and don't pull runtime modules.
- Review finding A.3 in `ai-docs/reviews/2026-05-11-bodhi-pi-tech-debt.md` proposed swapping the `dist/` import for the barrel. That finding is obsolete; the analysis above supersedes it (see Decision log entry dated 2026-05-12).

## Test conventions

- No `if (cond) { expect(...) }` — use narrowing helpers and `expect(val, "diag").toBe(...)`.
- No milestone IDs in filenames (`chat.test.ts` not `m2_1_chat.test.ts`).
- Shared helpers live in `test/helpers/` — never duplicate.
- Tool-call tests **in `test/`**: prefer `registerFauxProvider` over aimock (aimock SSE isn't always parsed for tool-call rounds). aimock is acceptable in `e2e/` + `e2e-ui/` (real-LLM suites; no faux tool-call scripting there).
- `vitest.e2e.config.ts` does NOT use `mergeConfig` — composes `test.include` directly.
- e2e: assert side-effects and stable substrings, not exact model text.
- Per-feature e2e uses `gpt-4o-mini` (non-reasoning). Cross-provider parity lives in `e2e/chat.e2e.ts`.
