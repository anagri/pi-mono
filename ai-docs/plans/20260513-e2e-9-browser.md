# bodhi-pi e2e: fifth project `browser` — test-app-browser + Playwright-as-transport

## Context

`packages/bodhi-pi/e2e/vitest.e2e.config.ts` runs the shared suite `e2e/shared/**/*.e2e.ts` against four projects today (`in-memory`, `cli`, `http`, `ws`) — post-commit `ce1f7e31`, the baseline is **101 passed / 0 skipped** for `npm run test:e2e`. This work adds a fifth project, `browser`, that runs the same shared suite a fifth time with the agent inside a Chromium tab's Web Worker, the transport being Playwright driving a minimal Vite page whose DOM is the wire.

The goal is one number: `cd packages/bodhi-pi && npm run test:e2e` reports five `Test Files` labels with **zero skipped tests across the board**, and `just test` exits 0 with no new red. A future chrome-ext port (separate prompt) will reuse the helpers + adapters built here, so the DOM contract and `e2e/helpers/browser-adapters/` directory are public-ish surface.

The existing `bodhi-pi-web` workspace stays on disk and continues to own the UI surface; `test-app-browser` is a parallel, ACP-only minimal page whose only job is to make the shared suite runnable inside a browser realm.

## Locked design decisions

From this session's exploration + clarifying questions:

1. **Filesystem architecture: Option B (`h.setupFiles`).** The audit of `packages/bodhi-pi/e2e/shared/` found 15 mutating `h.filesystem` calls, **all before `clientConn.initialize`**, plus 4 reads (`readTextFile`, `exists`) **all after a `prompt`**. Zero `stat` calls. Option B is fully viable: tests stage seed via `await h.setupFiles({path: content})` once before init; the harness `filesystem` becomes a **read-only proxy** exposing `readTextFile` + `exists` only.
2. **Cancel surface:** dedicated `[data-testid="acp-cancel"]` button. Clicking it sends `session/cancel` through the same in-page ACP connection, so the request appears in the frame log like any other outbound request — uniform observability.
3. **Streaming surface:** root element cycles `[data-test-state="needs-init"|"ready"|"streaming"|"closed"|"error"]`. The page tracks an "in-flight streaming method" set (`prompt` / `loadSession` / `resumeSession`) and sets `streaming` while one is open; harness uses this flag to time `cancel.e2e.ts` mid-stream cancels.
4. **Seed format:** XML `<files><file path="...">content</file></files>` in `[data-testid="seed-files"]` textarea. Parsed in-page via DOMParser. No binary needed (audit confirmed).
5. **Isolation:** two layers — Playwright `browser.newContext()` per harness (fresh IndexedDB origin) **plus** per-test random `userId` whose Dexie dbNames become `bodhi-pi-test-${userId}-sessions` / `…-kv`.
6. **Lifecycle:** Vite dev + `chromium.launch({headless:true})` once in `global-setup.ts`; contexts per harness.
7. **No test-app-browser self-test spec.** Iterate via `--project browser` on the shared suite.
8. **Port:** `35273` (avoid collision with bodhi-pi-web's `35173` and any local Vite default).

## What gets built

### New: `packages/bodhi-pi/e2e/test-app-browser/` (private workspace)

Layout mirrors `e2e/test-app-http/` but **frontend-only**: no `src/server/`, no `tsconfig.server.json`, no spawn-from-Node binary.

```
packages/bodhi-pi/e2e/test-app-browser/
├── package.json                  # private: true; deps: react, react-dom, dexie, @zenfs/core, @zenfs/dom
├── tsconfig.json                 # extends repo base; declares "@e2e/*": ["../*"] path
├── vite.config.ts                # port 35273, strictPort, root src/frontend
├── index.html                    # mounts #root
└── src/frontend/
    ├── main.tsx                  # ReactDOM.createRoot(...).render(<App/>)
    ├── App.tsx                   # the only page: data-testid="test-app-root" + state machine
    ├── lib/
    │   ├── browser-acp-client.ts # in-page ACP client (MessagePort-based, mirrors AcpHttpClient shape)
    │   ├── seed-parser.ts        # parses <files>...</files> XML → Record<path, content>
    │   └── slash-router.ts       # intercepts /file, /exists on acp-input before forwarding to agent
    └── worker.ts                 # worker entry: imports bootstrapAgentWorker from @e2e/helpers/browser-adapters
```

Main thread responsibilities (App.tsx):
- Render setup form when `needs-init`: `user-id`, `user-email`, `seed-files` textarea, `setup-submit`.
- On submit:
  - Validate non-empty `id` + `email`.
  - Parse seed XML into `{path: content}[]`.
  - Mount `InMemory` ZenFS at `/mnt/test-workspace`, write seed files, set `cwd = /mnt/test-workspace`.
  - Construct `MessageChannel`; spawn worker (`new Worker(new URL("./worker.ts", import.meta.url), {type:"module"})`); post init message with `channel.port2`, `cwd`, Dexie dbName suffix `${userId}`.
  - Wrap `channel.port1` with `createMessagePortStream` + `ndJsonStream` from `@agentclientprotocol/sdk`; tap frames in/out into the frame-log state slice.
  - Wire `worker.onmessage` for `{type:"bodhi-pi-event"}` → append to event-log slice.
  - Transition root state → `ready`.
- After ready:
  - Render `acp-input` textarea + `acp-submit` + `acp-cancel`. The cancel button: `() => conn.cancel({sessionId: activeSessionId})`.
  - On `acp-submit`, parse JSON-RPC body. Intercept `/file <path>` and `/exists <path>` slash commands (NOT forwarded to agent); read ZenFS directly, append a synthetic frame with `data-frame-kind="response"` `data-frame-method="_test/file/read"` / `"_test/file/exists"` carrying `{ok, content}` or `{ok, exists}`.
  - For real ACP methods, route through `BrowserAcpClient` instance bound to `channel.port1`.
  - Track active sessionId from the most recent `newSession`/`loadSession`/`resumeSession` response.
  - For `prompt` / `loadSession` / `resumeSession`, flip root to `streaming` until the response frame resolves, then `ready`.

DOM contract elements (exact `data-testid`s — these are the harness's wire, MUST be stable):
- `[data-testid="test-app-root"][data-test-state="..."]` — top-level state machine.
- `[data-testid="user-id"]`, `[data-testid="user-email"]`, `[data-testid="seed-files"]`, `[data-testid="setup-submit"]` — setup form (visible only when `needs-init`).
- `[data-testid="acp-input"]`, `[data-testid="acp-submit"]`, `[data-testid="acp-cancel"]` — runtime I/O (visible only when `ready`/`streaming`).
- `[data-testid="frame-log"]` containing `[data-testid="frame"][data-frame-direction="out"|"in"][data-frame-kind="request"|"response"|"notification"][data-frame-method="..."][data-frame-rpc-id="..."][data-frame-seq="N"]` — payload in `<pre>` textContent.
- `[data-testid="event-log"]` containing `[data-testid="event"][data-event-type="..."][data-event-seq="N"]` — payload in `<pre>` textContent.

### New: `packages/bodhi-pi/e2e/helpers/browser-adapters/`

Direct ports from `packages/bodhi-pi-browser/src/`, byte-faithful, with a `// ported from packages/bodhi-pi-browser/src/<path>` reference comment at the top of each file. Imports adjusted only as needed.

| File (new path) | Source (in `bodhi-pi-browser/src/`) | LOC | Role |
|---|---|---|---|
| `filesystem/zenfs-filesystem.ts` | `filesystem/zenfs-filesystem.ts` | 71 | `createZenfsFilesystem` |
| `filesystem/zenfs-mount.ts` | `filesystem/zenfs-mount.ts` | 39 (only InMemory path needed) | mounting helper |
| `kv/dexie-kv-store.ts` | `kv/dexie-kv-store.ts` | 40 | `createDexieKvStore` |
| `sessions/dexie-session-store.ts` | `sessions/dexie-session-store.ts` | 197 | `createDexieSessionStore` |
| `script-executor/browser-script-executor.ts` | `script-executor/browser-script-executor.ts` | 95 | `createBrowserScriptExecutor` |
| `extensions/browser-extension-loader.ts` | `extensions/browser-extension-loader.ts` | 86 | `createBrowserExtensionLoader` |
| `transport/message-port-stream.ts` | `transport/message-port-stream.ts` | 72 | `createMessagePortStream` |
| `runtime/bootstrap-worker.ts` | `runtime/bootstrap-worker.ts` | ~135 | `bootstrapAgentWorker` — adapted to use port-message init signal carrying `cwd` + Dexie suffix (no FSA, no `__bodhiPiWebSeed`) |
| `runtime/wire-tap.ts` | `runtime/wire-tap.ts` | ~50 | optional; only if test-app uses worker-side wire tapping |

**Not ported** (omit; trim worker imports to avoid dragging them in):
- `workspace/provider.ts` + `workspace/bootstrap.ts` — replaced by the in-page seed-textarea path; mount is done on main thread before worker spawn.
- `script-executor/sandboxed-browser-script-executor.ts` — strict-CSP variant, not needed in test page.
- `extensions/sandboxed-browser-extension-loader.ts` — same.

Total port surface: ~700 LOC. Each port keeps its `// ported from` header to flag drift if `bodhi-pi-browser` upstream changes.

### New: Node-side helpers in `packages/bodhi-pi/e2e/helpers/`

- **`browser-launch.ts`** — wraps `chromium.launch({headless:true})` once (called from `global-setup.ts`), exposes a `launchHarnessContext({userId, email, baseUrl})` that does `browser.newContext()` + `newPage()` + `page.goto(baseUrl)` + fills the setup form + clicks `setup-submit` + waits for `[data-test-state="ready"]`. Returns `{context, page, cleanup}`.

- **`browser-connection.ts`** — implements `BodhiPiAcpConnection` (from `packages/bodhi-pi/src/client/types.ts`). One Playwright `page` per instance. Each method:
  - Writes JSON-RPC body to `[data-testid="acp-input"]` (via `page.fill`).
  - Clicks `[data-testid="acp-submit"]`.
  - **Plain methods** (`initialize`, `newSession`, `listSessions`, `closeSession`, `setSessionConfigOption`, `extMethod`): polls frame log for the matching response frame by `data-frame-rpc-id`, returns parsed `result`.
  - **Streaming methods** (`prompt`, `loadSession`, `resumeSession`): poll cursor reads frames in `data-frame-seq` order; dispatch `session/update` notifications into the harness's `updates[]`; resolves on the response frame.
  - **`cancel`**: clicks `[data-testid="acp-cancel"]`; the page-side button itself emits a normal outbound `session/cancel` request frame, which this method then awaits to confirm dispatch.
  - **Frame poll cursor:** internal `lastSeq` int per page; each poll asks `page.$$eval('[data-testid="frame"]', els => els.filter(e => +e.dataset.frameSeq > lastSeq))`; bounded by `page.waitForFunction` with a tight tick.

- **`browser-filesystem.ts`** — implements the `Filesystem` proxy shape needed by the harness. Mutating methods (`mkdir`, `writeTextFile`) **throw with a clear message: "Use h.setupFiles before initialize; in-session writes are not supported under the browser runtime."** Read methods:
  - `readTextFile(path)` — writes `/file <path>` to `acp-input` + submit; awaits synthetic `_test/file/read` response frame; returns content or throws ENOENT-shaped error.
  - `exists(path)` — writes `/exists <path>`; treats `{exists:false}` as `false`.
  - `stat` — not implemented (audit confirmed zero usages); throws if ever called.

### Existing files modified

| File | Change |
|---|---|
| `packages/bodhi-pi/e2e/helpers/harness.ts` | Add `createBrowserHarness(opts)` branch; extend `E2EHarness` with `setupFiles(files: Record<string,string>): Promise<void>`. For non-browser runtimes (`in-memory`/`cli`/`http`/`ws`), `setupFiles` simply iterates and calls underlying `mkdir`+`writeTextFile` eagerly (same effect as today). For `browser`, it stages into a `Map<string,string>` consumed at harness launch (page setup-submit). Mark `filesystem.{mkdir,writeTextFile,stat}` as deprecated-and-throws across **all** runtimes uniformly (Option B is fleet-wide, not browser-only — otherwise tests behave differently per project). |
| `packages/bodhi-pi/e2e/helpers/runtime.ts` | Extend `E2ERuntime` union with `"browser"`; update `getRuntime`/`isRuntime` guards. |
| `packages/bodhi-pi/e2e/setup/browser.ts` (new) | One-liner: `setRuntime("browser")`. |
| `packages/bodhi-pi/e2e/vitest.e2e.config.ts` | Append fifth project block `{name:"browser", setupFiles:["./e2e/setup/browser.ts"], include:["e2e/shared/**/*.e2e.ts"]}`. |
| `packages/bodhi-pi/e2e/global-setup.ts` | Add Vite dev server spawn (background process; wait for `ready in NNNms` regex from stdout), `chromium.launch({headless:true})`, export `BODHI_PI_E2E_BROWSER_BASE_URL=http://localhost:35273`, store `chromium` instance on module-scope variable for `browser-launch.ts` to import. Teardown closes both. Vitest's globalSetup runs once per Vitest invocation, so this is shared across all projects' tests but only the `browser` project consumes the env var. |
| `packages/bodhi-pi/e2e/shared/{fs,system-prompt,events,extensions,commands,scripted-skill}.e2e.ts` | Rewrite the 15 pre-init writes to use `await h.setupFiles({...})` calls. Mechanical change — no logic alteration. `events.e2e.ts:89-90` (writes between two newSessions) gets a second `setupFiles` call: confirm during implementation whether that's legal under the new shape (it is, because the *second* call still happens before the next prompt; the harness can accept multiple `setupFiles` calls and apply them by writing into the live ZenFS mount via a synthetic `/seed` slash. Decide during Phase 1 whether to allow multi-call setupFiles or to relocate `events.e2e.ts:89-90` to happen pre-initialize). |
| `packages/bodhi-pi/package.json` | If the workspace globs need updating to include `e2e/test-app-browser`. Check current `workspaces` field. |
| Root `package.json` | If workspaces needs adding `packages/bodhi-pi/e2e/test-app-browser`. Check existing convention (test-app-http is already listed). |

## Phasing (8 commits, green gate at each)

**Phase 0 — Baseline (no code change, evidence-capture).** Run `just test` + `cd packages/bodhi-pi && npm run test:e2e`; quote per-project totals in commit-body description. Verify against expected `101 passed / 0 skipped`.

**Phase 1 — `h.setupFiles` migration across all four existing runtimes.** Introduce `setupFiles` in the harness; make `h.filesystem.{mkdir,writeTextFile,stat}` throw with the "use h.setupFiles" message. Rewrite the 6 affected shared tests. **Gate: 4 projects still green at 101 passed / 0 skipped.** This phase is browser-independent and lands the API change first so it never interleaves with browser plumbing debugging.

**Phase 2 — Page skeleton (no worker, no real ACP).** New `test-app-browser/` workspace: Vite + React, full DOM contract, setup form, parse + mount InMemory ZenFS, slash router for `/file`/`/exists` against the ZenFS mount. ACP I/O routes to an **echo handler** (returns `{result: {echo: params}}`) so the page is fully shape-testable. Verify by hand: `npm --workspace=packages/bodhi-pi/e2e/test-app-browser run dev`, open browser, fill form, submit init, observe echo response in frame log. **Gate: page renders and one round-trip works manually.**

**Phase 3 — Port browser adapters.** Copy the 8 files listed above into `e2e/helpers/browser-adapters/` (verbatim except imports + the `// ported from` header). Replace echo handler with real worker spawn + `bootstrapAgentWorker`. Verify by hand: same dev page, submit `{method:"initialize"}` actually drives the agent, response carries real `protocolVersion` / `availableCommands`. **Gate: real `initialize` round-trip works in browser.**

**Phase 4 — Node-side helpers.** `browser-launch.ts`, `browser-connection.ts`, `browser-filesystem.ts`. Compile clean; unit-test the seed XML parser, frame poll cursor, slash-result parser in isolation (Vitest unit specs alongside each helper). **Gate: helpers compile and unit tests pass; no e2e plumbing yet.**

**Phase 5 — vitest project wiring + global-setup.** Add Vite + chromium boot to `global-setup.ts`; add `setup/browser.ts`; add fifth `vitest.e2e.config.ts` project; add `createBrowserHarness` branch in `harness.ts`. Smoke: `npx vitest --config e2e/vitest.e2e.config.ts --project browser e2e/shared/kv.e2e.ts`. **Gate: kv test passes end-to-end under `browser`.**

**Phase 6 — Drive full shared suite under `--project browser`.** Run `npx vitest --config e2e/vitest.e2e.config.ts --project browser`. Debug each failure on its merits — expected hotspots: cancel timing (`cancel.e2e.ts` aimock variant streams chunks; verify `streaming` state transitions before the cancel click), streaming chunk order assertions in `events.e2e.ts`, compaction's 4-chained-prompt budget in `compaction.e2e.ts` (may need documented `60_000` testTimeout override — but no new skips, refactor the test instead if needed). **Gate: shared suite fully green under `browser` project, zero skips.**

**Phase 7 — Full matrix + regression gate.** `cd packages/bodhi-pi && npm run test:e2e` reports five project labels, zero skipped. `just test` exits 0. Quote totals in commit body. **Gate: 5 projects × 101 = 505 passing tests (or whatever the exact per-project count resolves to with the shared suite at parity), zero skips, `just test` green.**

One commit per phase. Each commit body cites the gate it claims to have passed.

## Critical files to read while implementing

- `packages/bodhi-pi-web/src/agent/runtime.ts:4-110` — production worker spawn + MessageChannel wiring; reference for `worker.ts` + `App.tsx`.
- `packages/bodhi-pi-browser/src/runtime/bootstrap-worker.ts:90-136` — worker entry to port + adapt.
- `packages/bodhi-pi-browser/src/transport/message-port-stream.ts:16-72` — port stream helper, ported verbatim.
- `packages/bodhi-pi-browser/src/workspace/provider.ts:63-95` (seedWorkspaceProvider portion) — InMemory ZenFS mount pattern; we replicate in `App.tsx`, do NOT port the file.
- `packages/bodhi-pi/e2e/test-app-http/src/frontend/lib/acp-http-client.ts` — full surface to mirror for `BrowserAcpClient` (different wire, same shape including handler registration + frame tapping).
- `packages/bodhi-pi/e2e/test-app-http/vite.config.ts` — Vite config template (port + strictPort + root pattern).
- `packages/bodhi-pi/e2e/helpers/harness.ts:93-99,252-292` — dispatcher + `createHttpHarness` shape to mirror for `createBrowserHarness`.
- `packages/bodhi-pi/e2e/helpers/http-connection.ts` — sibling `BodhiPiAcpConnection` impl; mirror the per-method shape (especially the streaming methods' notification dispatch loop).
- `packages/bodhi-pi/e2e/helpers/runtime.ts:1-26` — union to extend.
- `packages/bodhi-pi/e2e/global-setup.ts:36-94` — `spawnTestAppHttp` pattern (stdout poll for `listening`); reuse pattern for Vite's `ready in NNNms`.
- `packages/bodhi-pi/e2e/vitest.e2e.config.ts` — five-line project block append.
- `packages/bodhi-pi/src/client/types.ts` (`BodhiPiAcpConnection`) — exact interface `browser-connection.ts` must satisfy.
- `packages/bodhi-pi/e2e/shared/cancel.e2e.ts` — the trickiest test to validate against (aimock cancel mid-stream).
- `packages/bodhi-pi/e2e/shared/events.e2e.ts:89-90` — the only `h.filesystem` write that happens between two `newSession` calls; double-check the Option B rewrite path.
- `packages/bodhi-pi/e2e/CLAUDE.md` — convention surface; do not violate.

## Verification (end-to-end)

```
# Phase 0 baseline
cd packages/bodhi-pi && npm run test:e2e   # expect 101 passed / 0 skipped across 4 projects

# Phase 1 gate
cd packages/bodhi-pi && npm run test:e2e   # still 101 / 0, now via h.setupFiles in 6 tests

# Phase 5 mid-gate
npx vitest --config e2e/vitest.e2e.config.ts --project browser e2e/shared/kv.e2e.ts   # kv passes under browser

# Phase 6 gate
npx vitest --config e2e/vitest.e2e.config.ts --project browser   # full shared suite, browser only

# Phase 7 final
cd packages/bodhi-pi && npm run test:e2e   # FIVE projects, zero skips
just test                                    # regression gate green
```

The single end-state metric: `npm run test:e2e` shows five project labels and zero skipped tests.

## Non-negotiables (carried from `e2e/CLAUDE.md` + prompt)

- `bodhi-pi/e2e/**` (helpers AND `test-app-browser/`) imports allowed: `@bodhiapp/bodhi-pi` (core, SUT), `@earendil-works/pi-*` (upstream). **Forbidden**: any `@bodhiapp/bodhi-pi-*` sibling (`-node`, `-browser`, `-cli`, `-http`, `-chrome-ext`, `-ws-server`, `-ws-frontend`, `-web`). Adapters live in `e2e/helpers/browser-adapters/` (or `node-adapters/` for the existing ports), not as deps.
- 30s default `testTimeout`. Documented `60_000` override only when truly necessary. No new overrides silently.
- No skips. If a shared test can't run under `browser`, refactor it; do not add `runIf` / `test.skip`.
- No `page.evaluate` reads or `window.*` peeks in harness or specs. DOM `data-testid` only.
- No emojis in code/comments/DOM strings.
- Comments minimal — essential WHY only.
- One commit per phase. Each commit body ends with the gate it claims to have passed.
