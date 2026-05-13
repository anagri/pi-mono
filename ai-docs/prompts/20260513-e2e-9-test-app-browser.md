# Kickoff: port the browser runtime into `bodhi-pi/e2e/`

This is a new chat session. Read this prompt end-to-end, explore the codebase, ask clarifying questions, then propose a plan via `ExitPlanMode`. **Do NOT start implementing until the plan is approved.**

## Goal

Add a fifth Vitest project — **`browser`** — to `packages/bodhi-pi/e2e/vitest.e2e.config.ts` so the same `e2e/shared/**/*.e2e.ts` files run a fifth time against a Web-Worker-based agent. Four projects exist today (`in-memory`, `cli`, `http`, `ws`); after this work the consolidated `npm run test:e2e` report shows five project labels (`|in-memory|`, `|cli|`, `|http|`, `|ws|`, `|browser|`) covering the same shared suite uniformly with **zero skips across the board**.

This is meaningfully harder than the cli/http/ws ports because the harness runs in Node but the agent runs inside a Chromium tab. The transport between Node-side test and in-browser agent is **Playwright** driving a minimal page; the bridge you design IS the transport.

A chrome-ext port follows in a separate prompt that reuses everything you build here. Treat that as a downstream consumer when shaping public-ish surface (DOM contract, helper modules, harness shape).

## End-state success criterion (the only metric)

```
cd packages/bodhi-pi && npm run test:e2e
```

shows five `Test Files` labels, zero skipped tests under any project. `just test` exits 0 with no new red vs. the current baseline (post-commit `ce1f7e31`, the KV-refactor: `bodhi-pi e2e` = `101 passed / 0 skipped`).

The existing bodhi-pi-web Playwright suite (`packages/bodhi-pi-web/e2e/`) is **out of scope** and stays untouched — it continues to own the UI surface. test-app-browser is a parallel, ACP-only artifact whose only job is to make `e2e/shared/*` runnable inside a browser realm.

## Where the work happens (strong recommendation)

**A new e2e test-app: `packages/bodhi-pi/e2e/test-app-browser/`** — a minimal Vite + React page with no Node server side. It hosts the agent in a Web Worker (the `bodhi-pi-web` pattern) and exposes ACP wire frames + lifecycle events as DOM elements that Playwright scrapes.

The existing `bodhi-pi-web` workspace stays on disk (mirrors how `bodhi-pi-cli` / `bodhi-pi-http` survived their ports). Eventually a follow-up may delete it once the playwright UI specs migrate, but that's not this prompt.

Why a new test-app rather than reusing `bodhi-pi-web`:

- `bodhi-pi-web` ships a fully-featured chat UI (Composer, MessageList, EventsPanel, RuntimeProvider, sessions sidebar, etc.). For e2e-as-transport we want the **minimum** surface: user form, seed input, ACP request input, frame log, event log. Adding more is harness-fighting.
- `bodhi-pi-web` consumes `@bodhiapp/bodhi-pi-browser`'s shared UI module (`packages/bodhi-pi-browser/src/ui/commands.ts` etc.) — that code path expects RuntimeProvider context, chat store, etc. Stripping it back to "DOM-as-wire" is awkward inside the existing app.
- A clean greenfield page lets you design the DOM contract for machine consumption from scratch — `data-testid="frame"`, `data-frame-direction`, `data-frame-seq`, etc. — without preserving any user-facing affordance.
- bodhi-pi has no production dependencies or dev dependencies on bodhi-pi-* packages, stays that way after the task is complete, what ever utilities you need, you need to port it to bodhi-pi/e2e/helpers/ or other folder inside e2e/ appropriately

Alternative (only mention if blockers emerge during exploration): add a sibling `/test-acp.html` route inside bodhi-pi-web. Justify with concrete reasons if you go that way.

## What to preserve from bodhi-pi-web (semantics, not files)

These are the architectural pillars the new test-app must keep — they're what makes `|browser|` a meaningful fifth project rather than a transport flavor of `|in-memory|`:

- **Agent runs in a dedicated Web Worker.** Main thread holds `ClientSideConnection`; worker holds `AgentSideConnection` + the actual `Agent`. ACP frames cross via a `MessageChannel` / `MessagePort` wrapped in `createMessagePortStream` + `ndJsonStream` from the ACP SDK. **No agent code on the main thread.**
- **The browser adapter shapes** — `createZenfsFilesystem`, `createDexieSessionStore`, `createDexieKvStore`, `createBrowserScriptExecutor`, `createBrowserExtensionLoader`, `bootstrapAgentWorker`, `createMessagePortStream`, `startAgentRuntime`. These currently ship from the sibling package `@bodhiapp/bodhi-pi-browser`. **`bodhi-pi/e2e` does NOT depend on any `@bodhiapp/bodhi-pi-*` sibling package**, only on `@bodhiapp/bodhi-pi` (the core). For this work you port/copy the browser adapter source files into `bodhi-pi/e2e/helpers/` (suggest: a new `e2e/helpers/browser-adapters/` directory mirroring the existing `e2e/helpers/node-adapters/`). The production code paths exercised by these copies ARE the regression target — keep them byte-faithful copies of what ships in `bodhi-pi-browser`, do not "improve" them in passing. See "What to port (and what's already ported)" below for the inventory.
- **InMemory ZenFS for the workspace mount.** Production uses FSA-backed ZenFS (`/mnt/<handle.name>`); test-app-browser must avoid the FSA picker (no user gesture available in CI). Mount an InMemory backend at e.g. `/mnt/test-workspace` and surface that as `h.cwd`. The bypass pattern in `bodhi-pi-browser/src/workspace/bootstrap.ts` (the `window.__bodhiPiWebSeed` global) is the precedent; do NOT use a global — surface seed content as DOM input instead (see "DOM contract" below).
- **Lifecycle events forwarded to main thread.** The worker fires `BodhiPiEvent`s; the main thread captures them (today via `useEventStore`). test-app-browser surfaces these in the DOM for the harness to scrape into `harness.events`.
- **Dexie database isolation per `(userId, email)`.** Production isn't multi-tenant, but the e2e harness will benefit from per-test storage isolation under a shared origin. Mirror bodhi-pi-http's pattern: a user-form on first load, then Dexie names get a `${userId}` suffix (`bodhi-pi-test-${userId}-sessions`, `…-kv`). The new test-app at the new `e2e/test-app-http/src/server/agent/wire-agent.ts:113` precedent (per-user kvStore dir under the parent dir) shows the corresponding server-side pattern; here it's client-side via Dexie dbName.

## DOM contract for the page (sketch — refine during planning)

The page is the harness's wire. Everything must be observable via `data-testid` / `data-*` attributes. No `page.evaluate` reads, no `window.*` peeks (single sanctioned exception is the FSA-seed pattern from prod bodhi-pi-web, which we're replacing here with a DOM input anyway).

Suggested elements (you may refine):

- **Root**: `[data-testid="test-app-root"][data-test-state="needs-init|ready|streaming|closed|error"]` — single source of truth for the page's lifecycle. Mirrors bodhi-pi-ws-frontend's `[data-test-state]` pattern.
- **Single setup form** (state = `needs-init`): one form rendered on load with all three inputs and one submit button:
  - `<input data-testid="user-id" />` — text, required.
  - `<input data-testid="user-email" />` — text, required.
  - `<textarea data-testid="seed-files" />` — workspace seed (may be empty). **Recommended format** (open to refinement during planning):

    ```
    <files>
    <file path="apple.txt">this file has nothing of interest</file>
    <file path="dir/banana.txt">this file mentions banana once</file>
    <file path="bin/img.png" format="binary" type="image/png">BASE64...</file>
    </files>
    ```

    Plain text by default. Add `format="binary"` only if any shared test actually needs binary content (none do today). If the textarea is empty, the workspace mount starts empty — the test's `h.cwd` directory exists but contains nothing.

  - `<button data-testid="setup-submit" />` — single submit. On click: derive Dexie names from `(id, email)`, parse the seed textarea (no-op if empty), mount an InMemory ZenFS at `h.cwd` with the parsed files (or no files), spawn the worker, perform ACP `initialize`, transition to `ready`. One round-trip from needs-init to ready.

- **ACP I/O** (state = `ready|streaming|closed`):
  - `[data-testid="acp-input"]` textarea — accepts ONE JSON-RPC request body per submit.
  - `[data-testid="acp-submit"]` button — sends it down the in-page ACP connection.
  - `[data-testid="acp-cancel"]` button — sends `session/cancel` for the currently-active prompt (page tracks active sessionId from most recent newSession/loadSession response).
- **Frame log** — append-only, every ACP frame crossing the in-page MessagePort, each frame its own DOM element with attributes for direction (`out|in`), kind (`request|response|notification`), method, rpc-id, and a monotonic `data-frame-seq` for poll-since-last-seen cursoring. Payload in `<pre>` textContent.
- **Event log** — same shape as frame log, separate `[data-testid="event-log"]`, `BodhiPiEvent` records appearing as they arrive from the worker.
- **Filesystem-readback slash** — the page intercepts `/file <path>` and `/exists <path>` typed into the ACP input, **does not forward to the agent**, reads ZenFS directly, and emits the result as a synthetic frame (e.g. `_test/file/read`) so the harness's `h.filesystem.readTextFile` can pick it up via the same scrape path as ACP responses.

Streaming is the trickiest piece. For `prompt` / `loadSession` / `resumeSession`, the page receives a series of `session/update` notifications interleaved with chunk-level frames before the final JSON-RPC response. **One option** (you may propose better): each notification appears as its own frame element with `data-frame-kind="notification"` + `data-frame-seq` so the harness scrape can dispatch them into `updates[]` in order, with the final `response` frame resolving the promise. Cancel-timing tests (see `e2e/shared/cancel.e2e.ts`) need the harness to be able to send `session/cancel` mid-stream — consider whether a dedicated `streaming-active` flag on the root element helps the harness know when to fire the cancel.

## What's been built before you (read these first)

- `packages/bodhi-pi/e2e/CLAUDE.md` — conventions you must follow (env-var contract, timeouts, anti-patterns, "don't depend on `@bodhiapp/bodhi-pi-*` from e2e").
- `packages/bodhi-pi/e2e/test-app-http/` — sibling test-app with server + frontend in one workspace. Borrow the frontend half wholesale (no `src/server/`, no `tsconfig.server.json`). Look especially at `src/frontend/lib/acp-http-client.ts` for the existing thin `BodhiPiAcpConnection` implementation pattern.
- `packages/bodhi-pi/e2e/helpers/harness.ts` — four runtime branches today. You add a `browser` branch. Note the harness shape: `{ clientConn, client, updates, events, flushEvents, filesystem, sessionStore, kvStore, cwd, cleanup }`. Note the per-runtime trade-offs (in-memory shares handles; cli/http/ws use proxy shapes).
- `packages/bodhi-pi/e2e/helpers/http-connection.ts` — fetch+SSE client implementing `BodhiPiAcpConnection`. Your browser-connection follows the same interface shape; the wire is different.
- `packages/bodhi-pi/e2e/global-setup.ts` — pattern for spawning shared backends and exporting env vars. Add a Vite dev server + Playwright launch here.
- `packages/bodhi-pi/e2e/setup/{in-memory,cli,http,ws}.ts` — one-liner setup files that set the runtime sentinel.
- `packages/bodhi-pi-web/CLAUDE.md` + `packages/bodhi-pi-web/src/agent/{worker,runtime}.ts` — the production reference for worker spawn / `MessageChannel` / ACP wiring.
- `packages/bodhi-pi-browser/CLAUDE.md` + `packages/bodhi-pi-browser/src/runtime/bootstrap-worker.ts` + `packages/bodhi-pi-browser/src/workspace/bootstrap.ts` — what the worker boots and how seed injection works in prod (you're replacing it with DOM input).
- `packages/bodhi-pi/src/client/types.ts` (`BodhiPiAcpConnection`) — the interface your browser-connection must satisfy.
- `packages/bodhi-pi/e2e/helpers/aimock-fixture.ts` — already used by `cancel.e2e.ts` over the wire; the agent's `resolveProviderBaseUrl` (added in `ce1f7e31`) overrides `Model<Api>.baseUrl` from a KV-stored `auth/<provider>.base_url`, so aimock works under any transport including browser.

## The filesystem-ordering question (critical pre-design decision)

`h.filesystem` is used in shared tests for two purposes:

1. **Seeding** before `clientConn.initialize` — `mkdir`, `writeTextFile` calls populate the workspace the agent later reads. Today every shared test does this strictly pre-init (audit `grep "h.filesystem" packages/bodhi-pi/e2e/shared/`).
2. **Readback** after `clientConn.prompt` — `fs.e2e.ts:51` and `commands.e2e.ts:64` both `readTextFile` post-prompt to verify the agent wrote what it claimed.

A browser harness can't share a `Filesystem` handle between Node (test process) and the in-page ZenFS (worker realm). Two patterns to consider:

**Option A — auto-flush at initialize**: keep `h.filesystem.writeTextFile` working in the harness; queue calls into a Map; on first `clientConn.initialize`, serialize the Map into the page's seed textarea and click init-submit before forwarding the actual `initialize`. Tests don't change. Adds an invariant: writes after `initialize` are illegal (throw loudly) — already true in every existing test.

**Option B — explicit setup step**: introduce a new harness API like `await h.setupFiles({...})` and **rewrite every shared test that uses `h.filesystem.writeTextFile` to call it instead**. Make `h.filesystem` a read-only proxy that surfaces only `readTextFile` / `exists` / `stat` (routed through the `/file` slash). Visual evidence of the FS-precedes-init invariant; bigger blast radius; clearer architecture.

**The user's current preference is Option B** (explicit `h.setupFiles`, rewrite tests). Validate this is sound during your exploration — particularly check that no shared test writes files between `newSession` and `prompt` (which would be a Option-B violation). Surface alternatives in the plan if Option A turns out cleaner.

Either way, post-prompt reads (`readTextFile`, `exists`) route through a page-side slash command on `data-testid="acp-input"` that the page intercepts BEFORE forwarding to the agent.

## Harness method translation (helps the planner think)

Each method of `BodhiPiAcpConnection` (defined in `packages/bodhi-pi/src/client/types.ts`) needs a Playwright translation. Roughly:

| Method | Translation sketch |
|---|---|
| `initialize(params)` | If Option B: serialize previously-staged files into seed textarea + click init-submit (spawns worker), then write `{method:"initialize", params}` into acp-input + click submit + wait for matching response frame. |
| `newSession(params)` | Write request JSON to acp-input + submit + wait for response frame. Page tracks the returned sessionId. |
| `loadSession(params)` | Streaming: write + submit; scrape `session/update` notification frames into `updates[]` as they appear; resolve on final response frame. |
| `resumeSession(params)` | Same as loadSession; no replay notifications expected. |
| `listSessions(params)` | Plain request/response. |
| `closeSession(params)` | Plain request/response. |
| `setSessionConfigOption(params)` | Plain request/response. |
| `prompt(params)` | Streaming, same as loadSession. Notifications carry `agent_message_chunk`, `tool_call`, `tool_call_update`, `agent_thought_chunk`, etc. |
| `cancel(params)` | Click `[data-testid="acp-cancel"]` (page sends `session/cancel` for active sessionId). Alternative: write request JSON to acp-input + submit. Choose during planning; the dedicated button is simpler for cancel-timing tests. |
| `extMethod(method, params)` | Generic JSON-RPC request via acp-input. Used heavily by `BodhiPiClient` (kv, sessions, settings, fork/clone, navigate, etc.). |

The harness-side `Filesystem` proxy:

| Method | Translation sketch |
|---|---|
| `mkdir(path, opts)` | If Option B: throw; tests must use `h.setupFiles`. If Option A: stage in Map. |
| `writeTextFile(path, content)` | Same as mkdir. |
| `readTextFile(path)` | Write `/file <path>` to acp-input + submit + wait for synthetic `_test/file/read` frame, parse contents. |
| `exists(path)` | Either `/file` (treat ENOENT as `false`) or a separate `/exists <path>` slash. |
| `stat(path)` | New `/stat <path>` slash. (Check whether any shared test actually calls `stat` — if not, skip and let it throw.) |

`flushEvents`: poll `[data-testid="event-log"]` child count until it stops growing for ~50ms (or page sets a `data-events-flushed="N"` attribute). Bound the wait.

`cleanup`: close the Playwright `context` (kills the page + its IndexedDB origin). The shared `chromium` instance and the Vite dev server survive between tests for speed.

## What to port (and what's already ported)

**Hard rule:** `bodhi-pi/e2e/**` may import from `@bodhiapp/bodhi-pi` (the core — that's the system under test, fine) and from `@earendil-works/pi-*` (upstream deps, fine). It **must NOT** import from any sibling `@bodhiapp/bodhi-pi-*` workspace package (`-node`, `-browser`, `-cli`, `-http`, `-chrome-ext`, `-ws-server`, `-ws-frontend`, `-web`). That includes both the helpers AND the test-app frontend. Whatever the test-app needs from those siblings must be ported into `bodhi-pi/e2e/`.

This is the rule the cli/http/ws ports already followed. Before suggesting any new port, **list the existing copies** so the planner doesn't duplicate. Today under `packages/bodhi-pi/e2e/helpers/` you'll find:

**Already ported from `@bodhiapp/bodhi-pi-node`** (under `e2e/helpers/node-adapters/`):

- `filesystem.ts` — `createNodeFilesystem` (mirror of `bodhi-pi-node/src/filesystem/node-filesystem.ts`)
- `kv-store.ts` — `createNodeKvStore`
- `key-encoding.ts` — file-safe key encoding helpers
- `script-executor.ts` — `createNodeScriptExecutor`
- `default-db-path.ts` — `defaultDbPath(appDirName?)` helper
- `extension-loader.ts` — Node-side extension loader
- `sessions/sqlite-session-store.ts` + `sessions/schema.ts` + `sessions/migrate.ts` — `createSqliteSessionStore` + drizzle migrations

**Already ported from `bodhi-pi-ws-server`/`-ws-frontend`** (under `e2e/helpers/`):

- `ws-connection.ts` — Node WS client implementing `BodhiPiAcpConnection`
- `http-connection.ts` — Node HTTP+SSE client implementing `BodhiPiAcpConnection`
- `auth.ts` — bearer token mint/verify shared by ws + http test-apps
- `extension-loaders/node-package-loader.ts` — extension-package loader shared by both test-apps

**Already inlined** (e2e-original): `aimock-fixture.ts`, `events-assert.ts`, `harness.ts`, `runtime.ts`, `seed-bodhi-pi.ts`. The current ws + http test-apps under `e2e/test-app-cli/` and `e2e/test-app-http/` consume these via the `@e2e/*` tsconfig path alias rather than via npm dep on the sibling package.

**What's NOT yet ported** (you do this in Phase 1 of this work, suggest a new `e2e/helpers/browser-adapters/` directory):

- `bodhi-pi-browser/src/filesystem/zenfs-filesystem.ts` → `createZenfsFilesystem`
- `bodhi-pi-browser/src/sessions/dexie-session-store.ts` + extension-entry helpers → `createDexieSessionStore`
- `bodhi-pi-browser/src/kv/dexie-kv-store.ts` → `createDexieKvStore`
- `bodhi-pi-browser/src/script-executor/browser-script-executor.ts` → `createBrowserScriptExecutor` (+ the sandboxed variant if needed for skills)
- `bodhi-pi-browser/src/extensions/browser-extension-loader.ts` → `createBrowserExtensionLoader`
- `bodhi-pi-browser/src/transport/message-port-stream.ts` → `createMessagePortStream`
- `bodhi-pi-browser/src/runtime/bootstrap-worker.ts` → `bootstrapAgentWorker` (worker entry)
- `bodhi-pi-browser/src/runtime/runtime.ts` → `startAgentRuntime` (main-thread side, if test-app-browser uses it; the alternative is to build a slimmer custom main-thread bridge directly)
- `bodhi-pi-browser/src/workspace/{provider,bootstrap}.ts` — likely replaced wholesale by the DOM-seed-textarea path; port only the minimum needed (workspace mount logic).

Confirm each port is needed by following the imports from the test-app-browser entry points; do not port modules that turn out unused. Each port is one file (or a small set) copied byte-for-byte from `packages/bodhi-pi-browser/src/` into `packages/bodhi-pi/e2e/helpers/browser-adapters/`, with imports adjusted only as needed to resolve under the new location. Keep a one-line `// ported from packages/bodhi-pi-browser/src/...` reference comment at the top of each ported file so drift is auditable.

**At the Node-harness layer** (test-runner-side, Node code that drives Playwright), add:

- `e2e/helpers/browser-connection.ts` — Playwright-driven `BodhiPiAcpConnection` implementer.
- `e2e/helpers/browser-filesystem.ts` — the `Filesystem` proxy described above (deferred-write + `/file`-slash readback).
- `e2e/helpers/browser-launch.ts` (or similar) — wrapper around `chromium.launch()` + per-test `newContext()` + `newPage()` with the test-app-browser base URL.

The test-app-browser frontend itself (Vite + React + worker) lives under `packages/bodhi-pi/e2e/test-app-browser/src/` and imports from `@e2e/helpers/browser-adapters/...` (via tsconfig path alias, same as test-app-http's `@e2e/*` alias today). It is allowed to import from `@bodhiapp/bodhi-pi` (the core, for types + `parseLoginArgs` etc.) but **NOT** from `@bodhiapp/bodhi-pi-browser` or any other sibling.

## Plumbing checklist

- `packages/bodhi-pi/e2e/test-app-browser/` — new workspace member, `private: true`, Vite + React + worker, strict port (e.g. `35273` to avoid collision with bodhi-pi-web's `35173`).
- `packages/bodhi-pi/e2e/helpers/browser-connection.ts`, `browser-filesystem.ts`, `browser-launch.ts`.
- `packages/bodhi-pi/e2e/helpers/harness.ts` — `createBrowserHarness(opts)` branch.
- `packages/bodhi-pi/e2e/helpers/runtime.ts` — extend `Runtime` union with `"browser"`.
- `packages/bodhi-pi/e2e/setup/browser.ts` — sets the runtime sentinel.
- `packages/bodhi-pi/e2e/vitest.e2e.config.ts` — fifth project block.
- `packages/bodhi-pi/e2e/global-setup.ts` — launch Vite (background process; wait for `ready in NNNms`) and `chromium.launch({headless:true})` (shared across tests). Tear down both.
- `packages/bodhi-pi/e2e/shared/**/*.e2e.ts` — IF Option B, rewrite every test that uses `h.filesystem.writeTextFile` / `mkdir` to use `h.setupFiles({...})` instead.

## Things to explore + decide before writing code

- **Option A vs Option B on the filesystem question** — the user leans Option B; you confirm or push back. Audit `grep -rn "h.filesystem" packages/bodhi-pi/e2e/shared/` and check both seed and readback patterns.
- **DOM contract granularity** — per-frame log is the suggestion; verify it cleanly supports cancel timing in `cancel.e2e.ts` (the `aimock` variant streams chunks; harness sends cancel ~600ms in) and the streaming chunk assertions in `events.e2e.ts`.
- **Streaming surface** — does the page need a `data-test-state="streaming"` flag on the root, or is per-frame scraping sufficient? Pick based on cancel-test ergonomics.
- **Vite dev vs build** — for test-app-browser, dev (`vite --port N`) is fine; you don't need a production build. For chrome-ext (next prompt) you will, but here Vite dev is the lightest path.
- **Playwright launch placement** — spawn once in `global-setup.ts`, or per-harness instance? Once is faster (shared headless Chromium); per-harness is simpler. Vitest's globalSetup runs once per Vitest invocation, so once is correct.
- **Per-test storage isolation** — Playwright contexts already give isolated origin storage. The user-form `(id, email)` provides a belt-and-braces layer (different Dexie dbName too). Confirm both layers are wired before claiming isolation.
- **Test-app-browser self-test** — a small Playwright spec inside `test-app-browser/e2e/` that drives the page through one happy-path round-trip against aimock, decoupled from the shared suite, so you can iterate on the page without waiting for full vitest. This is the test-app's smoke test, NOT part of the shared suite.
- **Cancel button vs JSON cancel** — `cancel({sessionId})` could be the button click or a generic JSON-RPC request. Dedicated button is closer to prod UI (Stop button); generic JSON is more orthogonal. Pick.
- **Worker bundle path under static-ish Vite serving** — `new Worker(new URL("./worker.ts", import.meta.url), {type:"module"})` is the prod pattern. Vite dev resolves this; the chrome-ext prompt will need a static-served equivalent. Note any constraints you notice now.
- **Required env vars** — what does global-setup export? `BODHI_PI_E2E_BROWSER_BASE_URL` (Vite URL) at minimum.
- **Streaming-poll latency budget** — Playwright auto-retrying locators have a default 30ms tick; ACP chunk-level frames may arrive faster. If a test asserts on chunk ORDER, ensure the poll cursor reads in order. Probably fine; verify.
- **30s testTimeout** — some shared tests are budget-tight under the slower transports (compaction's 4 chained prompts). Browser via Playwright adds DOM-scrape latency per RPC; expect a few tests to need the existing documented `60_000` override. Don't add new overrides silently — preserve the convention.

## Suggested phasing (inspiration, not mandate)

The prior cli/http/ws ports landed in 3-6 commits each, one phase per slice with a green gate between phases. For this work, a possible sequence:

1. **Phase 0** — Baseline `just test` + `npm run test:e2e`; quote totals.
2. **Phase 1** — Page skeleton: user form, seed input, ACP I/O, frame/event logs. No worker yet — frames are echoed locally for shape testing.
3. **Phase 2** — Port the browser adapters into `e2e/helpers/browser-adapters/` (see "What to port" above) and wire them into the test-app's worker entry; aimock-driven smoke (one happy-path Playwright spec inside test-app-browser).
4. **Phase 3** — Node-side helpers (`browser-connection.ts`, `browser-filesystem.ts`, `browser-launch.ts`) + harness branch. Compile clean; unit-test the file-format parser + frame poll cursor.
5. **Phase 4** — Vitest project wiring + global-setup; run the kv shared test under `--project browser` end-to-end.
6. **Phase 5** — IF Option B: rewrite shared tests to use `h.setupFiles`. Then drive the full shared suite under the browser project; debug each failure on its merits (cancel timing, streaming order, etc.). **No skips**.
7. **Phase 6** — Full `npm run test:e2e` (all five projects) green, zero skips. Quote totals.
8. **Phase 7** — `just test` regression gate. No new red.

You may resequence freely — this is structure, not script. One commit per phase, each commit ends with the gate it claims to have passed.

## Conventions (non-negotiable, codified in `e2e/CLAUDE.md`)

- `e2e/global-setup.ts` lists required env vars; tests use `process.env.NAME!` directly.
- 30s default `testTimeout`; documented `60_000` override only when truly necessary.
- Flow-consolidate tests when setup is identical; `expect.soft()` for cumulative assertions.
- `bodhi-pi/e2e/**` (both `helpers/` and `test-app-browser/`) must NOT depend on any `@bodhiapp/bodhi-pi-*` sibling package (`-node`, `-browser`, `-cli`, `-http`, `-chrome-ext`, `-ws-server`, `-ws-frontend`, `-web`). Port the source into `e2e/helpers/browser-adapters/` (or the existing `node-adapters/` where applicable) — do NOT add the sibling as a workspace dep. `@bodhiapp/bodhi-pi` (the core) is the one allowed `@bodhiapp/*` import — that's the system under test.
- Before suggesting a port, check what's already inlined under `e2e/helpers/` so you don't duplicate. See the inventory in "What to port (and what's already ported)".
- One commit per phase. Each commit ends with the gate it claims to have passed.
- No skips. If a shared test can't run under browser, refactor it; don't add `runIf` / `test.skip`.
- No `page.evaluate` / `window.*` reads in harness or specs. DOM `data-testid` only.
- No emojis in code/comments/DOM strings.
- Keep comments minimal — essential `WHY` only.

## Workflow

1. Read this prompt + the references above.
2. Capture the baseline (`just test` + `cd packages/bodhi-pi && npm run test:e2e`); quote per-project totals.
3. Spawn `Explore` agent(s) for: (a) worker + adapter wiring in bodhi-pi-web, (b) test-app-http frontend layout, (c) full set of `h.filesystem` calls in `e2e/shared/`.
4. Validate Option A vs Option B by counting actual `h.filesystem` calls in shared tests and their relative timing vs `initialize` / `newSession` / `prompt`. Recommend a decision; the user leans Option B but you confirm with evidence.
5. Refine the DOM contract sketch — specifically streaming and cancel surfaces.
6. Ask clarifying questions where the design has genuine ambiguity (especially DOM contract, port choice, Playwright launch model).
7. Write the plan to `ai-docs/plans/<slug>.md` and call `ExitPlanMode`.
8. Implement phase-by-phase with green gates between phases.

The eventual outcome is one number: `npm run test:e2e` shows five projects, zero skips. Every other decision serves that.
