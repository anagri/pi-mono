# Kickoff: port the chrome-ext runtime into `bodhi-pi/e2e/`

This is a new chat session. Read this prompt end-to-end, explore the codebase, ask clarifying questions, then propose a plan via `ExitPlanMode`. **Do NOT start implementing until the plan is approved.**

## Goal

Add a sixth Vitest project — **`chrome-ext`** — to `packages/bodhi-pi/e2e/vitest.e2e.config.ts` so the same `e2e/shared/**/*.e2e.ts` files run a sixth time, this time inside an unpacked Chrome MV3 extension. After this work the consolidated `npm run test:e2e` report shows six project labels (`|in-memory|`, `|cli|`, `|http|`, `|ws|`, `|browser|`, `|chrome-ext|`) covering the same shared suite uniformly with **zero skips across the board**. This is the final runtime in the bodhi-pi PoC matrix; after it lands, every reference deployment shape has full e2e/shared coverage.

**Prerequisite:** the `browser` project from `20260513-e2e-9-test-app-browser.md` must be landed first. This prompt builds on the constructs it produced (`test-app-browser/`, the ported `e2e/helpers/browser-adapters/`, `e2e/helpers/browser-connection.ts`, `e2e/helpers/browser-filesystem.ts`, `e2e/helpers/browser-launch.ts`, the DOM contract). Most of the heavy lifting is already done; this prompt is mostly the chrome-ext-specific delta.

**Hard rule that carries from `e2e-9` (stated up-front so it shapes every later decision):** `bodhi-pi/e2e/**` (both `helpers/` and any test-app, including `test-app-chrome-ext`) imports **only** `@bodhiapp/bodhi-pi` (the core, which IS the system under test) and upstream `@earendil-works/*`. It **MUST NOT** import any `@bodhiapp/bodhi-pi-*` sibling package (`-node`, `-browser`, `-cli`, `-http`, `-chrome-ext`, `-ws-server`, `-ws-frontend`, `-web`). Whatever this work needs from those siblings is **ported** into `bodhi-pi/e2e/helpers/` (most should already be there from `e2e-9`'s browser-adapters port). Re-port is forbidden if already present; verify before adding.

## End-state success criterion

```
cd packages/bodhi-pi && npm run test:e2e
```

shows six `Test Files` labels, zero skipped tests under any project. `just test` exits 0 with no new red.

The existing bodhi-pi-chrome-ext Playwright suite (`packages/bodhi-pi-chrome-ext/e2e/`) is **out of scope** and stays untouched. test-app-chrome-ext is a parallel, ACP-only artifact whose only job is to make `e2e/shared/*` runnable inside an MV3 extension.

## Where the work happens (strong recommendation)

**A new e2e test-app: `packages/bodhi-pi/e2e/test-app-chrome-ext/`** — an MV3 extension that bundles the **same Vite + React page** test-app-browser uses, served as a static `/acp.html` from the extension's `dist/`. The agent boots in a worker bundled into the extension; ZenFS + Dexie + sandbox iframe (for AsyncFunction CSP) wire up exactly as in `bodhi-pi-chrome-ext`.

The existing `packages/bodhi-pi-chrome-ext/` workspace stays on disk (same precedent as the other ports).

Why a new test-app rather than reusing `bodhi-pi-chrome-ext`:

- `bodhi-pi-chrome-ext` ships the full UI (chat surface, status bar, message list, settings modal). For e2e-as-transport you want the same minimal DOM shell `test-app-browser` exposes — not the full chat UX.
- Reusing the shell from test-app-browser is the whole point: this project is "the same page, packaged as an extension". If test-app-browser's page is well-factored, the chrome-ext test-app is mostly `manifest.json` + a thin worker bootstrap + a Vite build target.
- The no-sibling-deps rule means `bodhi-pi-chrome-ext` itself is **off-limits as a workspace dep** anyway; we'd have to port any UI we want, which defeats reusing the prod UI. Reusing the test-app-browser shell stays inside the e2e/ tree.

Alternative (only if blockers surface): add a sibling `/acp.html` route to the existing `bodhi-pi-chrome-ext`. Justify with concrete reasons during exploration — and note that under the no-sibling-deps rule this alternative would still require some way to load that page from `bodhi-pi/e2e/` without an npm dep on the chrome-ext workspace, which is itself tricky.

## Reuse from `test-app-browser`

These come along by design — try to consume them, not re-implement. Note: `test-app-browser` and `test-app-chrome-ext` are both **e2e workspaces under `bodhi-pi/e2e/`**, not sibling reference runtimes. The no-`bodhi-pi-*` rule is about prohibited *runtime* packages (`-node`, `-browser`, `-cli`, etc.); test-apps under `e2e/` can share code via the existing `@e2e/*` tsconfig path alias pattern (see `test-app-http/tsconfig.json` for the precedent: it points `@e2e/helpers/*` at `../helpers/*`). Lean on that.

- **The page itself.** test-app-browser's `index.html` + `src/TestAppPage.tsx` + worker entry. The recommended way for test-app-chrome-ext to consume them is via a tsconfig path alias (e.g., `@test-app-browser/*` resolving to `../test-app-browser/src/*`), so the source is referenced once and not duplicated. Verify during exploration that Vite + the chrome-ext build target handles cross-workspace TS path aliases correctly when emitting the MV3 dist; if it chokes, fall back to a **copy-on-build script** (a small node script in `test-app-chrome-ext/scripts/sync-page.mjs` invoked from `package.json#scripts.prebuild`). **Do not add a workspace dep** (`"@bodhiapp/bodhi-pi-test-app-browser": "*"`) — that path imports the npm-package surface, which is overkill and adds dist-coupling for two siblings under the same parent directory.
- **`e2e/helpers/browser-adapters/`** (ZenFS, Dexie, browser script executor, extension loader, message-port-stream, `bootstrapAgentWorker`, `InitMessage` types) — ported in by `e2e-9`. Reuse verbatim; the chrome-ext test-app's worker entry imports from `@e2e/helpers/browser-adapters/...`, NOT from `@bodhiapp/bodhi-pi-browser`.
- **`e2e/helpers/browser-connection.ts`** — works against any Playwright `Page`. Reuse verbatim; chrome-ext just hands it a `Page` opened on a `chrome-extension://...` URL instead of `http://localhost:.../`.
- **`e2e/helpers/browser-filesystem.ts`** — same. The `/file` slash works the same in either origin.
- **`e2e/helpers/browser-launch.ts`** — needs an extension-specific sibling. Chrome MV3 extensions require `chromium.launchPersistentContext(userDataDir, { args: ['--load-extension=<distPath>', '--disable-extensions-except=<distPath>'], headless: true })` — different from `chromium.launch()` + `newContext()`. Suggest a peer helper `e2e/helpers/chrome-ext-launch.ts` rather than overloading the browser one.
- **The single-form DOM contract** (`needs-init → ready → streaming/closed/error`, one form with `[data-testid="user-id"]` + `[data-testid="user-email"]` + `[data-testid="seed-files"]` + `[data-testid="setup-submit"]`, then ACP I/O + frame log + event log) — unchanged. The page is bytes-identical; the harness scrapes the same locators.
- **The harness shape** (`E2EHarness`) — same return type. The `createChromeExtHarness(opts)` branch differs from `createBrowserHarness` only in launch logic and the navigation URL.

## What's different from `browser` (the actual chrome-ext delta)

These are the chrome-ext-specific concerns:

- **Extension build artifact.** The agent doesn't run from a Vite dev server; Playwright loads an unpacked MV3 extension from `dist/`. That `dist/` has to be built. **User preference: incremental rebuild in `global-setup.ts`** (slow but always fresh), invoked via `npm --workspace @bodhiapp/bodhi-pi-test-app-chrome-ext run build:incremental` or similar. Stale-`dist` bugs are nasty; pay the rebuild cost. Vite watch is an alternative if the planner finds it cleaner.
- **Static URL pattern.** Inside the extension origin, the page is `chrome-extension://<extension-id>/acp.html`. The extension ID is derived from a manifest `key` (stable across runs if committed; see `bodhi-pi-chrome-ext/manifest.json` + `bodhi-pi-chrome-ext/scripts/`). Adopt the same stable-key scheme so the URL is deterministic.
- **Persistent context.** Playwright extension support requires `chromium.launchPersistentContext`. This means **one context shared across all chrome-ext tests** (unlike `browser` which gets a fresh context per test). Each test needs to clear IndexedDB / sessionStorage in `afterEach` so per-test isolation holds. The `(userId, email)` Dexie dbName suffix from test-app-browser already buys you per-test storage isolation at the dbName level; verify it's enough.
- **CSP / sandbox iframe for AsyncFunction.** MV3's extension_pages CSP forbids `'unsafe-eval'`. `bodhi-pi-chrome-ext` solves this with a sandbox iframe (`sandbox.html`) that has its own CSP allowing unsafe-eval; the worker proxies AsyncFunction execution through a `sandboxPort`. test-app-chrome-ext must wire the same. The `InitMessage` shape (ported into `e2e/helpers/browser-adapters/runtime/types.ts` during the browser-runtime work — confirm location) already includes `sandboxPort?: MessagePort`. If `scripted-skill.e2e.ts` (which exercises `run_script` / AsyncFunction) is to pass under chrome-ext, sandbox wiring is mandatory.
- **Service worker + manifest.** MV3 requires a background service worker. The existing `bodhi-pi-chrome-ext/src/background.ts` is minimal (opens a chat tab on click); test-app-chrome-ext can copy a similarly minimal version or omit the UI affordance entirely (Playwright opens the URL directly, no user click).
- **Vite extension build.** `bodhi-pi-chrome-ext/vite.config.ts` already produces an MV3-compatible dist with stable background.js + hashed assets. Mirror that.
- **`--load-extension` headless behavior.** Chromium supports `--load-extension` in headless via `--headless=new` (not the legacy headless). The existing `bodhi-pi-chrome-ext/playwright.config.ts` uses this; replicate.

## DOM contract: unchanged

Identical to test-app-browser's contract, inherited by reusing the page source (see "Reuse from test-app-browser" above):

- Root: `[data-testid="test-app-root"][data-test-state="needs-init|ready|streaming|closed|error"]`.
- Single setup form (state = `needs-init`): one form with `[data-testid="user-id"]`, `[data-testid="user-email"]`, `[data-testid="seed-files"]` textarea (may be empty — empty cwd is valid), and `[data-testid="setup-submit"]`. One round-trip from `needs-init` → `ready`.
- ACP I/O (state = `ready|streaming|closed`): `[data-testid="acp-input"]`, `[data-testid="acp-submit"]`, `[data-testid="acp-cancel"]`.
- Per-frame log: `[data-testid="frame-log"]` containing `[data-testid="frame"]` elements with `data-frame-direction`, `data-frame-kind`, `data-frame-method`, `data-frame-id`, `data-frame-seq`.
- Event log: `[data-testid="event-log"]` with `[data-testid="event"]` elements.

The only difference vs. `browser` runtime: the page is served from `chrome-extension://<id>/acp.html` instead of `http://localhost:.../`. Per-test isolation comes from the `(userId, email)` Dexie scoping plus an explicit IndexedDB clear in `afterEach` (because chrome-ext uses one persistent context, not per-test contexts).

## What to port (and what's already ported)

**Hard rule (same as `e2e-9`):** `bodhi-pi/e2e/**` (both `helpers/` and `test-app-chrome-ext/`) imports `@bodhiapp/bodhi-pi` (the core, system under test) and upstream `@earendil-works/*`. It does NOT import any `@bodhiapp/bodhi-pi-*` sibling package. Whatever the chrome-ext test-app needs from `bodhi-pi-chrome-ext` or `bodhi-pi-browser` is ported in.

**Already ported by the time you start this work** (assuming `e2e-9` landed):

- All node-adapters under `e2e/helpers/node-adapters/` — Node FS, KV, sessions, script-executor, extension-loader.
- All browser-adapters under `e2e/helpers/browser-adapters/` — ZenFS filesystem, Dexie sessions/kv, browser script executor, browser extension loader, message-port-stream, `bootstrapAgentWorker`, `InitMessage` types, worker entry helpers. Confirm exact list during exploration; `e2e-9`'s "What to port" section is the source of truth for what's there.
- ACP connection helpers — `http-connection.ts`, `ws-connection.ts`, `browser-connection.ts`, `browser-filesystem.ts`, `browser-launch.ts`.
- Test-app shells — `e2e/test-app-cli/`, `e2e/test-app-http/`, `e2e/test-app-browser/`.

**What this prompt adds:**

- A new test-app workspace `e2e/test-app-chrome-ext/` that reuses `test-app-browser`'s page (see "Reuse from test-app-browser" above for the suggested mechanism — tsconfig path alias preferred, copy-on-build fallback; no workspace dep) plus an MV3 `manifest.json`, sandbox.html, optional service-worker stub.
- A new Node-side helper `e2e/helpers/chrome-ext-launch.ts` — `chromium.launchPersistentContext` wrapper, reads the extension's dist path + computed extension ID, returns a Playwright `BrowserContext` ready to open new pages on `chrome-extension://<id>/acp.html`.
- Possibly: chrome-ext-specific bits of the sandbox-port bridge if `e2e-9` deferred them. Audit during planning. Bytes ported from `bodhi-pi-chrome-ext/src/sandbox/` (if such a directory exists — confirm) live under `e2e/helpers/browser-adapters/sandbox/` or similar, NOT in the test-app frontend.

**Likely NOT needed (already covered by browser-adapters port):** ZenFS, Dexie, browser script executor, extension loader, bootstrap-worker — these are runtime-shared between bodhi-pi-web and bodhi-pi-chrome-ext and should already be ported under `e2e/helpers/browser-adapters/` from `e2e-9`. Verify before re-porting.

Existing Node-side helpers (`browser-connection.ts`, `browser-filesystem.ts`) should not need changes; if they do, that's a signal they were too coupled to `http://localhost:...` and need to be made origin-agnostic.

## Plumbing checklist

- `packages/bodhi-pi/e2e/test-app-chrome-ext/` — new workspace member, `private: true`, Vite + React + worker + MV3 manifest + sandbox.html. `package.json#scripts.build:incremental` (or equivalent) is the entry point global-setup invokes.
- `packages/bodhi-pi/e2e/helpers/chrome-ext-launch.ts`.
- `packages/bodhi-pi/e2e/helpers/harness.ts` — `createChromeExtHarness(opts)` branch.
- `packages/bodhi-pi/e2e/helpers/runtime.ts` — extend the runtime union with `"chrome-ext"`.
- `packages/bodhi-pi/e2e/setup/chrome-ext.ts` — sets the runtime sentinel.
- `packages/bodhi-pi/e2e/vitest.e2e.config.ts` — sixth project block.
- `packages/bodhi-pi/e2e/global-setup.ts` — build test-app-chrome-ext's `dist/`, then `chromium.launchPersistentContext(...)`. Tear down on exit.

## Things to explore + decide before writing code

- **Page reuse mechanism**: tsconfig path alias (preferred, matches the `@e2e/*` pattern test-app-http uses) vs. copy-on-build script. **Workspace dep is off the table** — it adds dist-coupling between two e2e siblings that already share the `e2e/` parent directory; use the alias path. Verify Vite + the chrome-ext build target handles cross-workspace TS path aliases when emitting the MV3 dist; if it chokes, fall back to copy-on-build.
- **Stable extension ID**: extract from existing `bodhi-pi-chrome-ext/manifest.json` key generation. If the user wants a different ID for the test extension to avoid colliding with their local dev install of bodhi-pi-chrome-ext, mint a fresh key under `e2e/test-app-chrome-ext/`.
- **Build cadence**: user's stated preference is incremental rebuild in `global-setup.ts`. Concretely: does `vite build --watch` started in `global-setup` (and torn down on teardown) suffice? Or run `vite build` once per setup? Measure the cost of each on first iteration; pick the one that doesn't dominate the test budget.
- **Per-test IndexedDB cleanup**: persistent context means storage persists between tests by default. Verify the `(userId, email)` Dexie suffix gives enough isolation, OR add an explicit `await page.context().clearCookies()` + IndexedDB clear in `afterEach`. The simpler path is per-test dbName suffix (each test gets a unique `userId`), which the harness can derive from `testInfo.titlePath` or a counter.
- **Sandbox wiring for `scripted-skill.e2e.ts`**: confirm the production sandbox-port plumbing works under test-app-chrome-ext. If it requires an iframe MessageChannel handshake on page load, the page initialization sequence in test-app-browser may need extension to spin up the sandbox before sending `InitMessage` to the worker.
- **Headless mode for extensions**: validate `--headless=new` + `--load-extension` works in CI (the existing bodhi-pi-chrome-ext Playwright suite already proves this; just confirm during exploration).
- **Worker module URL resolution under `chrome-extension://`**: `new Worker(new URL("./worker.ts", import.meta.url), {type:"module"})` resolves against the document's base URL. In the extension, `import.meta.url` is `chrome-extension://<id>/...`; the bundled worker must be emitted to a discoverable path. The existing `bodhi-pi-chrome-ext/vite.config.ts` handles this; mirror the rollup input config.
- **Service worker lifecycle**: MV3 service workers are short-lived. test-app-chrome-ext's background.ts can be a noop or omitted entirely — Playwright opens the URL directly, no user gesture needed. Confirm the manifest still validates without a background entry, or include a minimal stub.

## Suggested phasing (inspiration, not mandate)

1. **Phase 0** — Baseline. Browser project must already be green (the prerequisite from `e2e-9`).
2. **Phase 1** — Scaffold `test-app-chrome-ext/`: workspace member, manifest.json, Vite config, page reuse strategy validated. Manual smoke: build dist, `chrome --load-extension=<dist>` opens to `chrome-extension://<id>/acp.html` and the page renders.
3. **Phase 2** — Worker + sandbox + Dexie wiring inside the extension origin. Same page from test-app-browser drives end-to-end against aimock.
4. **Phase 3** — Node-side: `chrome-ext-launch.ts` + harness branch + setup file + global-setup build step.
5. **Phase 4** — Vitest project `chrome-ext` added; run the kv shared test through the chrome-ext harness end-to-end.
6. **Phase 5** — Full shared suite under chrome-ext project; debug each failure on its merits (sandbox wiring for skills, persistence quirks, etc.). **No skips**.
7. **Phase 6** — Full `npm run test:e2e` (all six projects) green, zero skips.
8. **Phase 7** — `just test` regression gate.

One commit per phase. Each commit ends with the gate it claims to have passed.

## Conventions (non-negotiable)

Same as `e2e-9` (the browser prompt). Repeat: no skips; **no `@bodhiapp/bodhi-pi-*` sibling imports anywhere under `bodhi-pi/e2e/`** (including the test-app-chrome-ext frontend — port what you need into `e2e/helpers/browser-adapters/` or `e2e/helpers/`); only `@bodhiapp/bodhi-pi` (core) is allowed from `@bodhiapp/*`; 30s testTimeout default; one commit per phase; no emojis; minimal comments.

## Workflow

1. Read this prompt + the references in `e2e-9` + `packages/bodhi-pi-chrome-ext/CLAUDE.md` + `packages/bodhi-pi-chrome-ext/vite.config.ts` + `packages/bodhi-pi-chrome-ext/manifest.json` + the existing chrome-ext Playwright config.
2. Capture baseline (`just test` + `npm run test:e2e`); quote per-project totals.
3. Explore: page-reuse mechanism (tsconfig path alias vs. copy-on-build), Vite-in-MV3 quirks, sandbox-port plumbing, persistent context vs new-context isolation.
4. Validate sandbox port is required for `scripted-skill.e2e.ts` under chrome-ext (likely yes).
5. Ask clarifying questions if anything is ambiguous (page-reuse choice, extension-id determinism, persistent context teardown).
6. Write the plan to `ai-docs/plans/<slug>.md` and call `ExitPlanMode`.
7. Implement phase-by-phase with green gates between phases.

The eventual outcome is one number: `npm run test:e2e` shows six projects, zero skips. Every other decision serves that.
