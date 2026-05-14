# bodhi-pi review — e2e-and-test-apps-restructure

**Snapshot:** 2026-05-14, HEAD = `c0d47630`. Scope: `packages/bodhi-pi/e2e/`
and `packages/bodhi-pi/e2e-ui/`, with focus on (a) hoisting the four
`test-app-*` packages out of `e2e/` into a shared `test-apps/` tree
consumed by both runners, (b) replacing tabbed UIs in the test-apps with
vertical panels, (c) extraction/SOLID/duplication cleanup, (d) Playwright
discipline (state-attr waits, no inline timeouts, page-object hygiene),
(e) comment cleanup.

Every finding below has been verified against the current tree, has a
concrete file:line, and is fix-now actionable.

The prior review `2026-05-14-e2e-shared-cleanup.md` is still pending
implementation. Findings already in that doc (browser/chrome-ext harness
fold, wire-agent twins, drizzle scaffold extraction, `useHarness`
fixture, etc.) are NOT restated here unless the relocation changes their
shape. Land that review first, then this one — the moves below assume
the dedup work is already done.

---

## Batch A — Move `test-app-*` and `app-utils/` out of `e2e/` (Commit 1)

The four test-app packages and the cross-runtime `app-utils/` tree are
consumed by both `e2e/` (vitest) and `e2e-ui/` (Playwright); the `e2e-ui/`
runner already reaches sideways into `../e2e/test-app-*`. Promote them to
a peer `test-apps/` tree.

**A.1** Root workspace list points 4 paths into `e2e/test-app-*`.
- `package.json:12-15`
- Replace with `packages/bodhi-pi/test-apps/cli`, `…/http`, `…/browser`,
  `…/chrome-ext`. Add two new workspace entries created in A.5/A.6:
  `packages/bodhi-pi/test-apps/in-memory` and `packages/bodhi-pi/test-apps/browser-lib`
  (see A.6 naming note).

**A.2** `npm run check` enumerates 6 tsconfig project paths under
`e2e/test-app-*`.
- `package.json:23`
- Rewrite each `packages/bodhi-pi/e2e/test-app-*` → `packages/bodhi-pi/test-apps/*`.

**A.3** `bodhi-pi/tsconfig.json` excludes 5 `e2e/test-app-*` and
`e2e/app-utils/browser/**` paths to keep the core typecheck clean.
- `packages/bodhi-pi/tsconfig.json:13-17`
- After A.5/A.6, the excludes are no longer needed because nothing under
  `test-apps/` is matched by the `include: ["src/**/*.ts", "test/**/*.ts",
  "e2e/**/*.ts"]` pattern. Delete the `exclude` block.

**A.4** `e2e-ui/` config points at `../e2e/test-app-*` for both
webServer command paths and chrome-ext build.
- `packages/bodhi-pi/e2e-ui/playwright.config.ts:10-11`
- `packages/bodhi-pi/e2e-ui/global-setup.ts:7`
- `packages/bodhi-pi/e2e-ui/helpers/chrome-ext.ts:7`
- Rewrite each to `path.resolve(here, "..", "test-apps", "http"|"browser"|"chrome-ext")`.
- Keep `.env.test` in `packages/bodhi-pi/e2e/` (it is e2e-suite-scoped,
  not test-app-scoped) — both global-setups already reach into it.

**A.5** Move directories. Treat as one git move (atomic).
- `e2e/test-app-cli/` → `test-apps/cli/`
- `e2e/test-app-http/` → `test-apps/http/`
- `e2e/test-app-browser/` → `test-apps/browser/`
- `e2e/test-app-chrome-ext/` → `test-apps/chrome-ext/`
- `e2e/app-utils/` → `test-apps/app-utils/` (full subtree, see A.6 for
  split of `app-utils/browser/` into a separately-named workspace if a
  publishable lib is intended; otherwise leave under `test-apps/app-utils/browser/`).
- Pre-move, run `npm run clean -ws --if-present` so no `dist/` or
  `node_modules/` carry across. `dist/` is already in `e2e/.gitignore:1`
  so nothing tracked moves.

**A.6** Promote `app-utils/browser/` to its own workspace under
`test-apps/`. Currently it is a non-package directory consumed via the
`@e2e/*` path alias; both `test-app-browser` and `test-app-chrome-ext`
mount it as their UI host (`packages/bodhi-pi/e2e/test-app-browser/src/frontend/adapter.ts:1`,
`packages/bodhi-pi/e2e/test-app-chrome-ext/src/adapter.ts:1`). After the
move, give it its own `package.json` (`@bodhiapp/bodhi-pi-test-app-browser-lib`
to avoid collision with `test-apps/browser/`) so consumers depend by
package name, not by `@e2e/*` aliasing across runner roots. Both Vite
configs lose their cross-tree alias work (`packages/bodhi-pi/e2e/test-app-browser/vite.config.ts:27`,
`packages/bodhi-pi/e2e/test-app-chrome-ext/vite.config.ts:28`).

**A.7** New `test-apps/in-memory/` workspace owns the in-process host
that the vitest in-memory project and `test-app-cli` share today.
- From `e2e/helpers/in-memory/harness.ts` (the in-process pair)
- From `e2e/app-utils/cli/{kv-store,script-executor,key-encoding,default-db-path,bash-terminal}.ts`
- From `e2e/app-utils/cli/sessions/{shared.ts,single-tenant/*,multi-tenant/*}`
- `test-app-cli/src/agent.ts:43-66` currently imports these via `@e2e/app-utils/cli/…`;
  rewrite to `@bodhiapp/bodhi-pi-test-app-in-memory` (or a workspace
  relative import). `helpers/in-memory/harness.ts` becomes a thin
  re-export of the in-memory test-app factory so e2e specs keep their
  `createE2EHarness({ runtime: "in-memory" })` entry point.
- `e2e/helpers/node-adapters/{filesystem,index}.ts` stays under
  `e2e/helpers/` — it is the e2e harness's Node FS proxy, not test-app
  code. (Prior review A.1 already deletes the flat
  `node-adapters/extension-loader.ts`.)

**A.8** `@e2e/*` path-alias retargeting. Today 5 tsconfigs map
`@e2e/* → ../*` (or `../../*`) to reach into `e2e/`.
- `packages/bodhi-pi/tsconfig.json:8` (`@e2e/* → ./e2e/*`)
- `packages/bodhi-pi/e2e/test-app-cli/tsconfig.json` (mapping to `../*`)
- `packages/bodhi-pi/e2e/test-app-http/tsconfig.{frontend,server}.json`
- `packages/bodhi-pi/e2e/test-app-browser/tsconfig.frontend.json`
- `packages/bodhi-pi/e2e/test-app-chrome-ext/tsconfig.frontend.json`
- Plus Vite mirrors: `test-app-{http,browser,chrome-ext}/vite.config.ts`
  (cited in A.6 + `test-app-http/vite.config.ts:12`).
- After the move, `@e2e/*` paths under test-apps no longer resolve to
  a sibling. Two options — pick one:
  (a) Drop `@e2e/*` from test-app tsconfigs entirely; have them depend on
      `test-apps/app-utils/` and `test-apps/browser-lib/` by workspace
      package name. Cleanest, and matches A.6/A.7.
  (b) Keep `@e2e/*` but repoint to `../../e2e/*`. Survives until the next
      restructure; weaker.
- Recommend (a). Every test-app import of `@e2e/app-utils/...` becomes
  `@bodhiapp/bodhi-pi-test-app-browser-lib/...` or
  `@bodhiapp/bodhi-pi-test-app-in-memory/...`.

**A.9** `packages/bodhi-pi/CLAUDE.md` references the matrix and the
"Examples folder" path. After the move, update the relevant lines (no
broken paths today, but the doc currently talks about
`packages/bodhi-pi-web/e2e/examples/`; check whether the test-apps move
introduces a stale path in any other CLAUDE.md or the package
inventory table around `packages/bodhi-pi/CLAUDE.md` lines 14-23).

**A.10** Add `test-apps/.gitignore` mirroring `e2e/.gitignore:1-6`
(`dist/`, `node_modules/`, `*.tsbuildinfo`, `.bodhi-pi-http/`,
`.e2e-ui-data/`, `.e2e-ui-data-manual/`). Without it, `npm run build`
under each test-app will leak artifacts into the new tree.

---

## Batch B — Delete the dead tabbed-UI cluster in test-app-http (Commit 2)

`test-app-http/src/frontend/{App,WsApp}.tsx` render `AppShell` from
`@e2e/app-utils/browser/ui/index.ts`. AppShell is the single canonical
UI for all three browser-side test-apps (http, browser, chrome-ext) and
renders vertical panels (`ChatPanel`, `DevAcpIo`, `WirePanel`,
`EventsPanel`) at `packages/bodhi-pi/e2e/app-utils/browser/ui/AppShell.tsx:371-401`
— no tabs.

The `components/`, `hooks/`, and parts of `lib/` under `test-app-http/src/frontend/`
form a self-contained cluster that no live entry point imports. They are
remnants of an earlier UI, including the tabbed `lifecycle`/`wire`
EventsPanel the user wants gone. Verified by grepping consumers — every
file in the cluster imports only siblings inside the same cluster.

**B.1** Delete the dead component cluster.
- `test-app-http/src/frontend/components/Chat.tsx:1-166`
- `test-app-http/src/frontend/components/EventsPanel.tsx:1-211`
  (the tabbed `lifecycle | wire` UI at lines 7, 131-181)
- `test-app-http/src/frontend/components/Settings.tsx:1-54`
- `test-app-http/src/frontend/components/StatusBar.tsx:1-43`
- `test-app-http/src/frontend/hooks/useChat.ts`
- `test-app-http/src/frontend/hooks/useEventLog.ts`
- `test-app-http/src/frontend/hooks/useLifecycleLog.ts`
- `test-app-http/src/frontend/hooks/useSettings.ts`
- `test-app-http/src/frontend/ui/commands.ts`
- `test-app-http/src/frontend/lib/auth.ts`
- `test-app-http/src/frontend/lib/last-session.ts`
- `test-app-http/src/frontend/lib/lifecycle-log.ts`
- Verified retained because the live adapters reference them:
  `lib/acp-http-client.ts`, `lib/event-log.ts`, `lib/sse-parser.ts` (+
  `sse-parser.test.ts`), `lib/ws/transport.ts`, `lib/ws/ws-stream.ts`,
  `lib/ws/auth.ts`. Keep these.

**B.2** After B.1, fold the `pages/` directory away. `WsApp.tsx` is a
3-line twin of `App.tsx` differing only by which adapter factory it
calls.
- `test-app-http/src/frontend/App.tsx:1-8`
- `test-app-http/src/frontend/pages/WsApp.tsx:1-8`
- `test-app-http/src/frontend/main.tsx:1-20` (router with 2 routes)
- Replace the router + two twin components with a single `App.tsx` that
  reads `location.pathname` (`/http` vs `/ws`) once at module load and
  picks the adapter:
  `const adapter = location.pathname.startsWith("/ws") ? createWsAdapter() : createHttpAdapter();`
  `<AppShell title={…} adapter={adapter} />`. Delete `pages/WsApp.tsx`
  and `react-router-dom` from `test-app-http/package.json:28` — no
  routes remain after the collapse.

**B.3** Per-test-app `vite.config.ts` redefines the `@e2e` alias and the
node-polyfill include array.
- `test-app-http/vite.config.ts:12`
- `test-app-browser/vite.config.ts:18-20, 27`
- `test-app-chrome-ext/vite.config.ts:18-20, 28`
- After Batch A's `@e2e/*` retirement (A.8), drop the alias block from
  all three configs. Extract a shared `test-apps/app-utils/vite-shared.ts`
  exporting the polyfill plugin + base `resolve` and have each test-app
  spread it.

---

## Batch C — Use deterministic state attrs in e2e-ui specs, drop inline timeouts (Commit 3)

Global config is `testTimeout: 120_000`, `expect: { timeout: 30_000 }`
(`e2e-ui/playwright.config.ts:18-19`). Specs and pages override these
inline with literals that bypass the global window, and one page method
hides an LLM-justified 60s default that the docstring doesn't explain.

**C.1** `ChatPanelPage.waitForIdle` defaults to `timeout = 60_000`;
`waitForStreaming` defaults to `30_000`. The first is genuine LLM-wait
budget (one assistant turn under gpt-4o-mini can exceed the global
30s expect window); the second is redundant with the global window.
- `e2e-ui/pages/ChatPanel.ts:21-22` — keep the 60_000 but add a one-line
  comment justifying it ("real-LLM turn exceeds the global 30s expect
  budget"). Match the e2e convention from
  `packages/bodhi-pi/e2e/CLAUDE.md:36-47`.
- `e2e-ui/pages/ChatPanel.ts:25-26` — drop the explicit `timeout`
  parameter; rely on the project-level expect timeout. State flips back
  to "streaming" the moment the wire frame arrives — no LLM lag.

**C.2** `SetupFormPage.submit` uses `page.waitForSelector` rather than
`expect(…).toBeVisible()`, which sidesteps the configured expect timeout
and silently uses Playwright's default 30s.
- `e2e-ui/pages/SetupForm.ts:23-26`
- Replace with
  `await expect(this.page.locator('[data-testid="test-app-root"][data-test-state="ready"]')).toBeVisible();`.
  Same wait, plays nicely with `expect.timeout` overrides.

**C.3** Inline `{ timeout: 10_000 }` literals on poll/expect calls. Both
the model-attribute flip and the `/sessions` family complete within ~2s
of the corresponding wire event; the global 30s expect window is more
than enough.
- `e2e-ui/shared/model-switch.spec.ts:28`
- `e2e-ui/shared/session-tree.spec.ts:42`
- `e2e-ui/shared/session-tree.spec.ts:54`
- Delete the `{ timeout: 10_000 }` argument from each `expect.poll(...)`.

**C.4** `session-tree.spec.ts` parses a UUID out of the system message
text instead of reading an attribute.
- `e2e-ui/shared/session-tree.spec.ts:33-37`
- Add `data-clone-source-id`/`data-clone-target-id` (or a more general
  `data-session-event="cloned|resumed|closed"` + `data-session-id`) to
  the system-message element emitted by `AppShell` for `/clone`,
  `/resume`, `/close`. The spec reads the attribute; no regex.
- AppShell emits these system messages today in the `tryHandleSlash`
  outcome (`packages/bodhi-pi/e2e/app-utils/browser/ui/AppShell.tsx:332-345`);
  carry the structured fields onto the message object.

**C.5** `commands-extensions-skills.spec.ts:46-47` asserts the assistant
echoes a literal secret-redacted text (`expect(...).not.toContain("sk-PLAINTEXTSECRETXYZ123")`).
This couples the test to whether the model verbatim-quotes file contents
— a model-behavior detail, not a redaction-extension contract.
- `e2e-ui/shared/commands-extensions-skills.spec.ts:40-47`
- Replace with an assertion on the wire frame for the `read_text_file`
  tool-result: `wire.rows({ method: "session/update" })` containing
  `[REDACTED]` and not the raw secret. The extension's job is to mutate
  the tool result the model sees; that's what should be asserted.

**C.6** Seven specs repeat a 6-line gotoStart + fillAndSubmit boilerplate
verbatim.
- `e2e-ui/shared/commands-extensions-skills.spec.ts:12-25`
- `e2e-ui/shared/model-switch.spec.ts:11-16`
- `e2e-ui/shared/session-tree.spec.ts:11-16`
- `e2e-ui/shared/simple-chat.spec.ts:12-17`
- `e2e-ui/shared/terminal.spec.ts:4-9`
- `e2e-ui/shared/tool-call.spec.ts:12-18`
- `e2e-ui/shared/workspace-fs.spec.ts:4-11`
- Add a `startApp` fixture in `e2e-ui/fixtures.ts` that takes optional
  `{ seedXml? }`, runs `gotoStart()` + `setup.fillAndSubmit({ userId,
  email, seedXml?, configJson })`. Each spec collapses to
  `await startApp({ seedXml: ... });`. Matches the spirit of prior
  review D.1 (`useHarness()` for the vitest side).

**C.7** `configJson` fixture branches on `inProcessAgent` metadata to
decide whether to emit anything.
- `e2e-ui/fixtures.ts:57-71`
- The test-apps accept either an empty string or no `configJson` field
  in the setup form (`SetupForm.fill` only fills when defined,
  `e2e-ui/pages/SetupForm.ts:20`). Build the config unconditionally and
  let split-host test-apps ignore it. Drops a project-aware branch from
  the fixture layer.

---

## Batch D — Page-object data-test-state coverage (Commit 4)

The AppShell exposes `data-test-state` on `<main>` only
(`packages/bodhi-pi/e2e/app-utils/browser/ui/AppShell.tsx:372`) plus
`data-test-state` on `[data-testid="chat-panel"]` (idle | streaming).
Specs that need finer-grained signals fall back to text matching.

**D.1** Add `data-test-state` to individual chat messages so a spec can
deterministically wait for the assistant's final turn instead of
inspecting text. Today `ChatPanel.lastMessage("assistant")` followed by
`toContainText(...)` is the only available pattern.
- `packages/bodhi-pi/e2e/app-utils/browser/ui/ChatPanel.tsx` (the message
  loop within ChatPanel — the file emits chat-message nodes with
  `data-message-role` but no per-message status)
- `e2e-ui/pages/ChatPanel.ts:29-34`
- Emit `data-test-state="streaming|done|cancelled"` on each
  `[data-testid="chat-message"]` element. `lastMessage(role)` gains a
  `lastDoneMessage(role)` sibling that filters by `data-test-state="done"`.

**D.2** `data-test-state` flips on the test-app root through five
states (`needs-init | ready | error | streaming` per AppShell render
tree). The `streaming` state is computed implicitly. Either drop it
from the root (move it onto `chat-panel` exclusively) or document the
two-axis state model (`root state × chat state`) in
`e2e-ui/pages/SetupForm.ts` and a peer doc; today the dual axis is a
silent assumption.
- `packages/bodhi-pi/e2e/app-utils/browser/ui/AppShell.tsx:372`
- `e2e-ui/pages/ChatPanel.ts:9-11`

**D.3** `WirePanelPage.rows` selector contract is mirrored in
`packages/bodhi-pi/e2e/helpers/browser/page-frame-reader.ts` (via the
e2e harness) — keep them in lockstep when adding attributes. Currently
no parity test ensures both readers stay aligned.
- `e2e-ui/pages/WirePanel.ts`
- `packages/bodhi-pi/e2e/helpers/browser/page-frame-reader.ts`
- Promote the row `data-*` schema to a typed constant exported from
  `test-apps/app-utils/wire-schema.ts` (after Batch A) and have both
  readers + the AppShell emitter consume it.

---

## Batch E — Inline timeouts in helpers (Commit 5)

These helpers ship hard-coded duration literals without a justifying
comment. Either parameterise (let the caller bring its own budget) or
document.

**E.1** `helpers/browser/acp-connection.ts:106` hard-codes a 60-second
RPC deadline.
- `packages/bodhi-pi/e2e/helpers/browser/acp-connection.ts:106`
- Move to a constant `BROWSER_ACP_RPC_TIMEOUT_MS = 60_000` with a
  one-line comment ("real-LLM round-trip via in-page agent") and accept
  an optional override via `BrowserAcpConnection` options.

**E.2** `helpers/browser/filesystem.ts:41` hard-codes a 10-second
deadline for slash-dispatch.
- `packages/bodhi-pi/e2e/helpers/browser/filesystem.ts:41`
- This is a local DOM poll; 10s is plausible but unexplained. Either
  drop to 5s or add a one-line comment naming the longest legitimate
  case ("write-file roundtrip during seeded-scenario load").

**E.3** `helpers/chrome-ext/launch.ts:73` overrides the shared
`createPageDrivenHarness`'s `readyTimeoutMs` to 30s while
`helpers/browser/launch.ts:36` keeps it at 15s.
- `packages/bodhi-pi/e2e/helpers/chrome-ext/launch.ts:73`
- `packages/bodhi-pi/e2e/helpers/browser/launch.ts:36`
- Comment on the chrome-ext override explaining why MV3 boot is 2x the
  Vite-served browser path (sandbox iframe + service-worker
  registration). Without it, the 30s literal reads as a "hide a slow
  test" anti-pattern.

**E.4** `helpers/events-assert.ts` polls for event-balance with a 2s
deadline + 50ms tick.
- `packages/bodhi-pi/e2e/helpers/events-assert.ts:44-45`
- These are reasonable but undocumented. Pull both into named consts at
  the top of the file with one-sentence rationale.

---

## Batch F — Cross-tree duplication that the move surfaces (Commit 6)

Prior review B/F already collapses most of these; what remains after
that pass is listed here because the move makes the new home obvious.

**F.1** `test-app-browser/src/frontend/adapter.ts` and
`test-app-chrome-ext/src/adapter.ts` share the `tapLines` + worker
factory + message-port wiring; only the sandbox-port call differs.
- `packages/bodhi-pi/e2e/test-app-browser/src/frontend/adapter.ts:24-139`
- `packages/bodhi-pi/e2e/test-app-chrome-ext/src/adapter.ts:25-145`
- After Batch A, both adapters live next to each other under
  `test-apps/browser/` and `test-apps/chrome-ext/`. Extract a shared
  `createBrowserAdapter({ createSandboxPort? })` factory into
  `test-apps/app-utils/browser-lib/runtime/adapter.ts`; both test-apps
  pass their per-runtime port factory.

**F.2** `test-app-browser/src/frontend/worker.ts` and
`test-app-chrome-ext/src/worker.ts` are 3 effective lines of identical
boilerplate (Buffer polyfill + `bootstrapWorker(self)`).
- `packages/bodhi-pi/e2e/test-app-browser/src/frontend/worker.ts:1-17`
- `packages/bodhi-pi/e2e/test-app-chrome-ext/src/worker.ts:1-18`
- Either delete one and import from the other through the shared
  `browser-lib` package, or generate them from a `createWorkerEntry`
  template. The CSP delta (sandbox iframe in chrome-ext) is in the
  `createSandboxPort` call already in adapter.ts — not in the worker.

**F.3** `http/connection.ts` and `ws/connection.ts` both declare
`LIFECYCLE_EVENT_METHOD = "_bodhi-pi/lifecycle/event"`.
- `packages/bodhi-pi/e2e/helpers/http/connection.ts:21`
- `packages/bodhi-pi/e2e/helpers/ws/connection.ts:7`
- Single source: add to `helpers/constants.ts` (does not exist today;
  create it) or co-locate with `helpers/events-assert.ts`. Same string
  is also referenced from `test-app-http/src/frontend/lib/ws/transport.ts:8`.

**F.4** `helpers/browser/page-driven-harness.ts` re-throws filesystem
mutation errors with bespoke messages while
`helpers/browser/filesystem.ts` already owns the
read-through-only-mutators-throw contract.
- `packages/bodhi-pi/e2e/helpers/browser/page-driven-harness.ts:142-175`
- `packages/bodhi-pi/e2e/helpers/browser/filesystem.ts:31-95`
- Replace the inlined throwers with a single call to
  `createBrowserFilesystem({ page })`; if the page-driven harness
  needs a custom error label, accept it as an option.

---

## Batch G — Vertical-panel layout + visual polish in AppShell (Commit 7)

Live walkthrough on 2026-05-14 against the running servers
(`http://localhost:35173/` for `bodhi-pi-web`, `http://localhost:35273/`
for the test-app-browser served by `e2e-ui/playwright.config.ts:38`).
Observed gaps below; every fix lands in `app-utils/browser/ui/` and
ships immediately to all three browser-side test-apps (http, browser,
chrome-ext) since they all mount the same `AppShell`.

Reference numbers from the in-page DOM inspection:
- bodhi-pi-web: `[data-testid="app-shell"]` is `display: flex; flex-direction: row; height: 100vh`, 3 stylesheets loaded, system-sans font. Events panel is a fixed 420 px right rail.
- test-app-browser AppShell: `<main>` is `display: block`, 0 stylesheets, `body { font-family: Times; margin: 8px }`, panels stack in document order, wire frames overflow horizontally off the viewport.

**G.1** AppShell renders `<ChatPanel> + <DevAcpIo> + <WirePanel> + <EventsPanel>`
as flat children of `<main>` with no layout shell. The result is a
single vertical document stack: chat composer sits in the middle of the
page, DevAcpIo follows, the wire log streams below it (no clipping; each
JSON-RPC frame wraps onto its own row), and EventsPanel renders below
that — most of it lives off-screen at small viewports.
- `packages/bodhi-pi/e2e/app-utils/browser/ui/AppShell.tsx:371-401`
- After the test-apps move (Batch A) this file lives at
  `test-apps/app-utils/browser-lib/ui/AppShell.tsx`. Refactor the
  return body to a two-column flex layout matching bodhi-pi-web's
  `.app-shell` rules in `packages/bodhi-pi-web/src/App.css:1-25`:
  - Outer `<main data-testid="test-app-root" data-test-state={state}>`
    becomes `display: flex; flex-direction: row; height: 100vh`.
  - **Left column** (`flex: 1 1 auto; min-width: 0; display: flex;
    flex-direction: column`) holds the title bar, `ChatPanel` (which
    grows to fill), the `DevAcpIo` toggle/drawer, and the composer.
  - **Right column** (`flex: 0 0 420px; display: flex; flex-direction:
    column; border-left: 1px solid #e5e7eb`) holds `WirePanel` and
    `EventsPanel` stacked vertically (with the existing
    `data-active-tab` switcher kept as-is — that pattern is already
    fine; do not introduce new tabs).
- Keep WirePanel and EventsPanel as their own components; only the
  parent layout changes. The `data-testid` contract (and therefore the
  e2e-ui specs) is untouched.

**G.2** AppShell ships zero CSS today; the `data-testid="app-shell"`
class hook bodhi-pi-web uses doesn't exist.
- `packages/bodhi-pi/e2e/app-utils/browser/ui/AppShell.tsx` (no co-located stylesheet)
- Add `app-utils/browser/ui/app-shell.css` (or `.module.css`) with the
  flex rules from G.1 plus light token defaults — system-ui font stack,
  `--bg`, `--fg`, `--border` colour vars, 0 body margin. Import it from
  `index.ts` so every test-app picks it up without per-app CSS.
  `packages/bodhi-pi-web/src/App.css:1-50` is the working reference; do
  NOT copy 385 lines wholesale, only the layout-critical rules.

**G.3** `ChatPanel` renders the message stream as bare `<pre>` blocks
with no role indicator, no scroll container, and no flex that lets it
fill the column.
- `packages/bodhi-pi/e2e/app-utils/browser/ui/ChatPanel.tsx:38-83`
- Wrap `chat-messages` in a scrollable region (`flex: 1 1 auto;
  overflow-y: auto`) so the composer can dock at the bottom of the
  left column instead of floating mid-page.
- Add a visible role chip to each message — the role is already on
  `data-message-role`, just surface it. Match bodhi-pi-web's
  `<MessageList>` minimalism (role label + content). No avatars, no
  markdown rendering — this is a test-app, not a product UI.
- The `<textarea cols={60}>` hard-codes a width that collapses the
  composer in a narrow column. Drop `cols`; let the parent flex
  control width.

**G.4** No status header. bodhi-pi-web shows `model / mount /
sessionId / state / Unmount` in a dark bar so every spec author sees
the live runtime state at a glance.
- `packages/bodhi-pi-web/src/ui/StatusBar.tsx` (reference shape)
- `packages/bodhi-pi/e2e/app-utils/browser/ui/AppShell.tsx:372-374` (current
  bare `<h1>{title}</h1>` slot)
- Replace the `<h1>` with a `<StatusBar>` component co-located with
  `AppShell.tsx`. Carries `data-current-model`, `data-session-id`,
  `data-test-state` — same attribute names already on `[data-testid=
  "chat-panel"]`, so specs don't need new locators. Promoting the
  state attributes from the chat-panel root to a header gives Batch D's
  per-message state attribute room without overloading the panel.

**G.5** `WirePanel` rows render as long single-line JSON with no
horizontal-scroll container; on the test-app-browser walkthrough each
`session/update` frame ran off the viewport edge.
- `packages/bodhi-pi/e2e/app-utils/browser/ui/WirePanel.tsx` (the row
  emitter — verify file path; if the component lives in `EventsPanel.tsx`
  the row block is what to clip)
- Wrap rows in `pre` with `white-space: pre-wrap; word-break:
  break-all` OR put the panel container in `overflow-x: auto`. Match
  bodhi-pi-web's events-panel styling (`packages/bodhi-pi-web/src/App.css:16-25`
  uses `overflow: hidden` at the column + per-row scroll).

**G.6** `DevAcpIo` is permanently mounted between the chat surface and
the wire/events panel. In bodhi-pi-web's design there is no equivalent
— it's purely a debug surface. Hide it behind a `<details>` (or move
it under a tabbed sibling next to WirePanel in the right column) so the
chat surface gets the visual primacy specs need.
- `packages/bodhi-pi/e2e/app-utils/browser/ui/AppShell.tsx:389-395`
- `packages/bodhi-pi/e2e/app-utils/browser/ui/DevAcpIo.tsx`
- Spec impact: the `e2e/helpers/browser/page-driven-harness.ts`
  consumer drives `data-testid="acp-input"` / `data-testid="acp-submit"`
  directly; a `<details>` wrapper is transparent to those selectors as
  long as the inputs stay in the DOM.

**G.7** `SetupForm` mirrors the same unstyled-HTML problem. Inline
`<label>text<input/></label>` siblings wrap awkwardly at narrow
widths; the seed-files and config `<textarea>`s overlap because there
is no block layout.
- `packages/bodhi-pi/e2e/app-utils/browser/ui/SetupForm.tsx`
- Wrap each field in a `<div class="form-row">` with `display: flex;
  flex-direction: column; gap: 4px`; constrain the form to a
  `max-width: 720px` centered container. Same `data-testid`s stay; the
  Playwright `SetupFormPage` (Batch C.2) doesn't need to change.

**G.8** AppShell title is hard-coded by each test-app via the `title`
prop (`packages/bodhi-pi/e2e/test-app-http/src/frontend/App.tsx:7`,
`pages/WsApp.tsx:7`, `test-app-browser/src/frontend/App.tsx:7`,
`test-app-chrome-ext/src/App.tsx:7`). After the StatusBar lands (G.4),
fold the title into the status header so each App.tsx becomes a
one-liner that only passes the adapter. No data-testid changes needed.

---

## Batch H — Comment hygiene under e2e + e2e-ui (Commit 8)

Light pass after the moves settle. The codebase is already comment-lean;
most of the bloat is concentrated in the dead test-app-http cluster that
Batch B deletes outright.

**H.1** `test-app-http/src/frontend/ui/commands.ts:49` carries a
9-line JSDoc describing how the file was ported from
`bodhi-pi-ws-frontend`. Goes away with B.1.
- `packages/bodhi-pi/e2e/test-app-http/src/frontend/ui/commands.ts:49`
- No standalone action; verifies as part of B.1 deletion.

**H.2** `helpers/with-timeout.ts:1-5` JSDoc restates the symbol.
- `packages/bodhi-pi/e2e/helpers/with-timeout.ts:1-5`
- Delete the header docblock; the function signature is self-explanatory.

**H.3** `helpers/pick-defined.ts:1-3` JSDoc is a four-line restatement.
- `packages/bodhi-pi/e2e/helpers/pick-defined.ts:1-3`
- Trim to one line ("strip undefined values so optional fields don't
  override factory defaults") or delete. Caller-site usage at the
  cited 29 sites in the prior review's C.4 is the actual docs.

**H.4** Several `app-utils/browser/lib/*` files document the file's
purpose in a one-line block comment that adds nothing.
- `packages/bodhi-pi/e2e/app-utils/browser/lib/seed-parser.ts:1`
- `packages/bodhi-pi/e2e/app-utils/browser/lib/slash-router.ts:1`
- `packages/bodhi-pi/e2e/app-utils/browser/lib/workspace-constants.ts:1`
- Drop each. Keep the one in `worker-fs-bridge.ts` (the WHY is genuine
  — explains the message-port hop).

---

## Suggested commit grouping

Each batch is independently gate-checkable. Run the full matrix after
Batches A and B individually; F can ride alongside G to save a cycle.

1. **Commit 1 — Batch A** (test-apps relocation). The single biggest
   structural change. Atomic move of 4 test-apps + `app-utils/`,
   creation of `test-apps/in-memory/` + `test-apps/app-utils/browser-lib/`
   workspaces, retargeting of `@e2e/*` aliases (option (a) from A.8),
   workspace/tsconfig/Playwright-config rewrites. Gate-check: `npm install
   && npm run check && npm run -ws --if-present test` and a Playwright
   smoke (`cd packages/bodhi-pi/e2e-ui && npm run test:http`).

2. **Commit 2 — Batch B** (test-app-http dead-code purge + router
   collapse). Deletes the tabbed lifecycle/wire EventsPanel and its
   cluster, replaces the router with a path-keyed adapter pick, removes
   `react-router-dom`. AppShell stays the single canonical vertical
   panel layout across http/browser/chrome-ext. Gate-check: Playwright
   under `e2e-ui` across all 4 projects.

3. **Commit 3 — Batch C** (e2e-ui spec discipline). Inline-timeout
   purge, `SetupForm.submit` matcher swap, `startApp` fixture, structural
   attributes for `/clone`/`/resume`/`/close`, replace assistant-text
   redaction assertion with a wire-frame assertion, drop the
   `configJson` metadata branch. Touches every spec; small.

4. **Commit 4 — Batch D** (data-test-state coverage). Adds
   per-message `data-test-state`, documents/cleans the root-state vs
   chat-state two-axis model, promotes the wire-row schema to a typed
   constant shared by `WirePanel`, `page-frame-reader`, and AppShell's
   emitter.

5. **Commit 5 — Batch E** (helper-side inline timeouts). Names the
   four hard-coded constants, parameterises where reasonable, comments
   where not. No behaviour change.

6. **Commit 6 — Batch F** (cross-tree duplication closure). Shared
   `createBrowserAdapter` factory, single `LIFECYCLE_EVENT_METHOD`
   constant, page-driven-harness consumes `createBrowserFilesystem`.
   Builds directly on the new tree from Batch A.

7. **Commit 7 — Batch G** (vertical-panel layout + AppShell polish).
   Two-column flex shell, co-located CSS, StatusBar replaces the bare
   `<h1>`, scrollable chat surface, role chips on messages, hide
   `DevAcpIo` behind `<details>`, wire-row clipping, SetupForm layout.
   Single source-of-truth update under `app-utils/browser-lib/ui/` —
   ships to all three browser-side test-apps automatically. Verify
   visually against `bodhi-pi-web` at `localhost:35173`.

8. **Commit 8 — Batch H** (comment hygiene). Inline; merge with Batch G
   if the diff stays small.
