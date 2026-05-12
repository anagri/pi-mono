# bodhi-pi development process

How we work on bodhi-pi parity features. This is a retrospective of what worked
during Phases A–F (session-management parity with `packages/coding-agent`) and
the working rules every subsequent phase should follow. Read this once before
starting any phase prompt in this folder.

> **Upstream context (2026-05-11):** The repo was rebased from upstream
> `50993d74` onto `f348a062`, picking up the `@mariozechner/*` →
> `@earendil-works/*` package rename, version bump 0.73→0.74, and a new
> `pi-agent-core/harness/*` subtree that re-implements primitives bodhi-pi
> has been building in parallel. The full diff and adoption opportunities
> are in `ai-docs/research/upstream-sync-2026-05-11.md`. **Run Phase 0
> (`group-0-upstream-alignment.md`) before starting any feature group**;
> it decides which harness primitives, if any, bodhi-pi adopts.

---

## 1. What bodhi-pi is

A headless, host-mediated, ACP-speaking coding agent that runs in Node and in
the browser. It ships as a runtime-agnostic core + two publishable adapter
packages + several reference hosts.

| Package | Role |
|---|---|
| `packages/bodhi-pi` | Runtime-agnostic core. ACP wire, session lifecycle, built-in tools. Hosts inject `Filesystem`, `SessionStore`, `ScriptExecutor`. |
| `packages/bodhi-pi-node` | Publishable Node adapters (`@bodhiapp/bodhi-pi-node`). |
| `packages/bodhi-pi-browser` | Publishable browser adapters AND shared browser-host UI (`@bodhiapp/bodhi-pi-browser`). |
| `packages/bodhi-pi-cli` | Reference Node host — REPL. |
| `packages/bodhi-pi-web` | Reference browser host (Vite/React + Web Worker). |
| `packages/bodhi-pi-chrome-ext` | Reference Chrome MV3 host. Shares `bodhi-pi-browser` UI. |
| `packages/bodhi-pi-ws-server` + `packages/bodhi-pi-ws-frontend` | Reference split host (WS server + thin React client). |
| `packages/bodhi-pi-http` | Reference HTTP+SSE host with **per-turn agent rebuild** (proves serialize/deserialize deployment). |
| `packages/coding-agent` | Reference implementation we mirror functionally — read first, strip TUI/Node specifics, replicate field/method shape. |

**Every user-visible feature must land in all five reference hosts** (cli, web,
chrome-ext, ws-frontend, http). Functional parity required; technical parity
is not (different transports, different storage, different extension loaders
are fine). PARITY.md at `packages/bodhi-pi/PARITY.md` is the source of truth
for what shipped.

---

## 2. The hard rules

### Architecture

- **Stable ACP over `unstable_*`.** Non-spec features ship as
  `extMethod` under the `_bodhi-pi/<area>/<verb>` namespace. Advertise via
  `agentCapabilities._meta["bodhi-pi"]` in the `initialize` response.
- **No silent defaults in `BodhiPiConfig`.** Missing required field → factory
  throws. The one historical exception is `systemPrompt`.
- **No `node:*` imports in browser-shipped code.** `bodhi-pi-browser` and the
  reference browser hosts are CSP-conscious; native FS / native crypto go
  through host-injected adapters.
- **Mirror coding-agent.** When porting a feature, read its source in
  `packages/coding-agent/src/` first, then port the shape and trim what's
  TUI- or Node-specific. AgentMessage in bodhi-pi is `Message` only (no
  custom roles like `bashExecution` / `branchSummary`) — synthesize content
  via user-role messages with tagged framing when needed.

### Slash commands are the user surface

- All user interaction across every host is through `/<command>` slash
  commands typed into the prompt input. No buttons, no modals, no FSA
  pickers — even cross-browser hosts type slashes.
- Each new slash command lands in **every host's** dispatcher:
  - `packages/bodhi-pi-cli/src/repl/commands.ts`
  - `packages/bodhi-pi-browser/src/ui/commands.ts` (shared by web +
    chrome-ext)
  - `packages/bodhi-pi-ws-frontend/src/ui/commands.ts`
  - `packages/bodhi-pi-http/src/frontend/ui/commands.ts`
- Update each host's `/help` text in the same change.

### Blackbox testing

This is the most-broken rule in early phases — re-read carefully:

- **Tests reach the agent ONLY through the public seam.** That means
  `clientConn` (ACP) for core tests; the chat UI (slash + system messages +
  data-testid) for host e2e; HTTP RPC for `bodhi-pi-http` integration tests.
- **No `sessionStore.load(...)` for assertions in tests.** The harness gives
  you the store so it can be _injected_; do not read from it to verify
  agent behaviour.
- **No `createSqliteSessionStore({dbPath: harness.dbPath})` in CLI e2e.**
  Same anti-pattern. Use ACP extension methods that surface the state you
  need (e.g., the `_bodhi-pi/session/entries` / `_bodhi-pi/session/tree`
  blackbox seams we added for fork/clone testing).
- **The one sanctioned whitebox bridge** is the browser filesystem seed via
  Playwright `addInitScript(window.__bodhiPiWebSeed = ...)`. Pure Playwright
  constraint — there's no DOM affordance that can replace Chrome's FSA
  picker bypass. Document it where it occurs.
- **No `page.evaluate` / `window.*` reads in browser e2e.** Every observable
  signal flows through DOM `data-*` attributes (chat-state, tool cards,
  EventsPanel rows).
- If the feature needs a state-inspection seam in the UI for testability,
  **add a slash command for it**. That's how `/entries` and `/tree` were
  born — they exist primarily so the agent's DAG state can be observed from
  the UI without reaching into the store.

### Iterative, minimal, depth-first

- **Minimum scope per phase.** Do what is needed to ship the agreed
  functional outcome. Don't anticipate; don't over-design. If a sub-feature
  is uncertain, ask the user via `AskUserQuestion`.
- **Depth-first per runtime.** Implement a sub-feature in one runtime,
  add/update its e2e, run it, green, commit-able state, then move to the
  next runtime. **Not** "implement everywhere then test everywhere".
- **Order of runtimes within a sub-feature:** core integration test → core
  e2e (real LLM) when applicable → CLI → bodhi-pi-browser shared (web +
  chrome-ext) → ws-frontend → bodhi-pi-http. Build dist artifacts between
  the core layer and the host layers (the browser hosts consume
  `@bodhiapp/bodhi-pi-browser` from `dist/`).
- **TDD.** Write the failing core test before the production code. Then
  pass it. Then move to the next runtime.

### Tests + gate checks

- **Two test layers in `bodhi-pi`:**
  - `bodhi-pi/test/*.test.ts` — integration tests against an in-process
    ACP pair using faux providers (`registerFauxProvider`) or `LLMock`
    (HTTP-based). In-memory adapters.
  - `bodhi-pi/e2e/*.e2e.ts` — real LLM via `gpt-4o-mini`. Real adapters
    (or in-memory; the point is the LLM is real).
- **Per-host e2e:** every visible feature gets a real-LLM e2e in cli, web,
  ws-frontend, http (faux for http when LLM behaviour isn't the variable),
  and chrome-ext. Use `gpt-4o-mini` for all real-LLM e2e — cheaper and
  consistent. The 5-host matrix is the cross-runtime regression net.
- **At each phase boundary run `just test` from the repo root.** Inspect
  failures: re-run the failing spec individually first to check for
  flakiness before assuming a real regression.
- **Pre-commit hook** runs the full `npm run check`: biome + tsgo across
  every package + browser smoke check. It must pass.

### Git workflow

- **Never `--no-verify`.** Pre-commit failures are real regressions or
  formatting drift; fix them.
- **`packages/ai/src/models.generated.ts` is a generated file regenerated
  upstream.** Restore it before commit: `git checkout
  packages/ai/src/models.generated.ts`. Otherwise pre-commit's tsgo trips
  on `claude-sonnet-4` removal from the registry.
- **Commit only at feature complete.** "Feature complete" means all five
  runtimes green for every sub-feature in the phase, full `just test`
  passes (modulo confirmed flakes), `PARITY.md` is updated.
- **One commit per phase**, conventional message:
  `feat(bodhi-pi): <summary> (Phase X)` with a body explaining functional
  outcome + decisions taken. Add the `Co-Authored-By: Claude Opus 4.7
  (1M context) <noreply@anthropic.com>` trailer.

### Code style

- **No comments for obvious code.** Only when WHY is non-obvious: hidden
  constraint, subtle invariant, workaround for a specific bug, behavior
  that would surprise a reader. If removing the comment wouldn't confuse a
  future reader, don't write it.
- **No `as` casts in ACP message handling.** Narrow via discriminator on
  `role` or the standard ACP `sessionUpdate.update.sessionUpdate` field.
- **JSON payloads round-trip** through SQLite/Dexie via the existing
  `payload` columns. Adding a new entry type does not require a schema
  migration — just a discriminator in the JSON.

---

## 3. Per-runtime quirks (learned the hard way)

### bodhi-pi (core)

- Tests live under `test/` and `e2e/`. The harness at
  `test/helpers/harness.ts` is the single source of truth for ACP test
  wiring; extend its options to thread through new config fields.
- Faux provider can also speak HTTP via `LLMock` for chat round-trips —
  see `test/chat.test.ts`'s pattern (start an `LLMock`, override the
  model's `baseUrl`).
- `runCompaction` / `prepareCompaction` / `buildSessionContext` /
  `walkPath` from `src/sessions/` are reusable building blocks; check
  before duplicating.

### bodhi-pi-node

- SQLite + drizzle. Migrations under `drizzle/`; the convention for a
  destructive change is a new `000N_*.sql` + a `_journal.json` entry.
  `CREATE TABLE IF NOT EXISTS` is the default; switch to DROP + CREATE
  when you accept the PoC-stance data loss.

### bodhi-pi-browser

- Shared by `bodhi-pi-web` and `bodhi-pi-chrome-ext`. **One change to its
  `src/ui/*.tsx` lands in two hosts.** Rebuild `bodhi-pi-browser` dist
  (`npm run build`) before running web/chrome-ext e2e — the hosts consume
  `@bodhiapp/bodhi-pi-browser` from `dist/`.
- Dexie schema is loose for non-indexed fields — add columns to row
  objects without bumping the version unless you need indexing.
- The `/worker-entry` subpath exists because the flat barrel transitively
  imports React UI (CSP-incompatible with worker realm). Worker-side code
  must use the subpath.

### bodhi-pi-cli

- In-process ACP pair (no real network transport). Use existing helpers
  in `test/helpers/` for both unit (faux provider) and e2e (real LLM).
- Slash commands print to `process.stdout`; existing tests `vi.spyOn`
  stdout to inspect.

### bodhi-pi-ws-frontend + bodhi-pi-ws-server

- Auth at WS upgrade-time via `Sec-WebSocket-Protocol`. Tests use
  per-test bearer tokens derived from `testInfo.titlePath` for parallel
  tenant isolation.
- Server-side store is multi-tenant SQLite scoped by `userId`. New stored
  fields need both schema column AND every read/write to scope by `userId`.
- ws-frontend uses **inline** ACP method-name constants (`const
  EXT_SESSION_X = "_bodhi-pi/session/x"`) because the package has a "no
  agent imports" rule. Mirror this when adding new methods.

### bodhi-pi-http

- Per-turn agent rebuild. Every HTTP request constructs a fresh agent,
  hydrates session state from SQLite, runs the method, tears down.
- ACP methods that need session state in memory must be added to
  `NEEDS_REHYDRATE` set in `src/server/acp/handler.ts` so `resumeSession`
  runs before dispatch.
- Frontend client `acp-http-client.ts` mirrors `ClientSideConnection`'s
  shape; add a typed method per new ACP extension.

### bodhi-pi-chrome-ext

- MV3 sandbox bridge handles code-eval (`AsyncFunction`, dynamic ESM) on
  the agent worker side. Existing infrastructure handles `run_script` and
  `createBrowserExtensionLoader`; only `pi.on` is proxied today.
- E2E uses `chromium.launchPersistentContext` with `--load-extension`.
  Build via `npm run build` before running specs (the dist gets loaded by
  Chrome).

---

## 4. Decision-making

- **Use `AskUserQuestion` before any architectural fork.** Examples we used:
  storage model (linear vs DAG), migration strategy (drop-and-recreate vs
  ALTER), scope cuts (defer /import? include OAuth?). One round of
  questions early saves three rounds of rework later.
- **`/grill-me` if uncertain.** When the design isn't obvious, ask
  yourself the open questions; if you can't answer, ask the user.
- **Don't generate plans, then execute blindly.** Plans get reviewed.
  Implementation is iterative. Pause and check in if you discover a
  constraint mid-flight that changes the plan.

---

## 5. Concrete starting moves

For any new phase prompt:

1. Read the phase prompt and PARITY.md (`packages/bodhi-pi/PARITY.md`).
2. Read the relevant section of `ai-docs/parity-post-extension.md` to
   confirm functional intent.
3. Read the reference implementation in `packages/coding-agent/src/` for
   the area you're working on.
4. Skim the most recent shipped phase's commit (e.g., `git log -1
   --stat` on `feat(bodhi-pi):` commits) to see the file pattern.
5. Use `AskUserQuestion` to confirm scope cuts before implementation.
6. Create `TaskCreate` tasks for each sub-feature + the PARITY.md
   update.
7. Start with the core integration test (failing) → core impl → core
   green → next runtime.
8. At each runtime boundary: typecheck (`npx tsgo --noEmit -p
   <package>/tsconfig.json`), run that package's tests, move on.
9. At phase boundary: `just test`, restore `models.generated.ts`,
   update PARITY.md, commit.

---

## 6. Glossary of seams you can reuse

| Seam | Where | Use |
|---|---|---|
| `buildSessionContext` / `walkPath` | `bodhi-pi/src/sessions/build-context.ts` | parentId-chain replay, compaction-aware message synthesis |
| `runCompaction` / `prepareCompaction` | `bodhi-pi/src/sessions/compaction.ts` | LLM-backed summarization, file-op tracking |
| `runBranchSummary` / `detectCrossBranch` | `bodhi-pi/src/sessions/branch-summary.ts` | branch-tail summarization |
| `isContextOverflow` | `@earendil-works/pi-ai` | provider-agnostic overflow detection |
| `appendEntry` | `bodhi-pi/src/acp/agent.ts` (private) | persist + advance leaf with parentId wiring |
| `_bodhi-pi/session/entries` / `tree` / `stats` | ACP extension methods | UI-blackbox state inspection |
| `EventsPanel` (`data-testid="event-row"`) | bodhi-pi-browser, bodhi-pi-ws-frontend, bodhi-pi-http frontend | wire + lifecycle observability for tests |
| `createTestHarness` | `bodhi-pi/test/helpers/harness.ts` | in-process ACP pair + faux providers |
| `createCliTestHarness` | `bodhi-pi-cli/test/helpers/cli-harness.ts` | CLI-shaped in-process pair with real SQLite |
| `startTestServer` | `bodhi-pi-http/test/helpers/test-server.ts` | per-test HTTP server on port 0 |
| `spawnTestServer` | `bodhi-pi-ws-frontend/e2e/helpers/spawn-server.ts` | per-test ws-server child process |

---

## 7. What "done" looks like

A phase is done when:

- Every sub-feature in the phase has core integration tests + per-host e2e
  (modulo intentional exceptions documented in PARITY.md).
- `just test` is green at the repo root.
- `packages/bodhi-pi/PARITY.md` reflects the shipped status (move ⏭ rows
  to ✅; add new ⏭ rows for things deferred this phase).
- One commit lands with a `feat(bodhi-pi): … (Phase X)` message; the body
  explains the functional outcome + decisions taken + non-fatal trade-offs.
- The user has been told the phase is complete and asked what's next.
