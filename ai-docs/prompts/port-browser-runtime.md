# Kickoff: port the browser runtime (and chrome-ext) into bodhi-pi/e2e/

This is a new chat session. Read this prompt end-to-end, explore the codebase, ask clarifying questions, then propose a plan. Do NOT start implementing until the plan is approved.

## Goal

Browser is one of bodhi-pi's primary runtimes — the agent runs inside a Web Worker on the user's machine, with browser-side adapters (ZenFS, Dexie, AsyncFunction script executor). We want the same `e2e/shared/**/*.e2e.ts` files that run under `in-memory`, `cli`, and `http` to also run under a **browser** Vitest project, plus a `chrome-ext` project for the Chrome MV3 host. End state: five project labels on the consolidated suite.

This is meaningfully harder than the cli/http/ws ports because the harness runs in Node but the agent runs in a browser. The transport you build is the bridge.

## Where the work happens

- Browser test-app: `packages/bodhi-pi/e2e/test-app-browser/` — ported from `packages/bodhi-pi-web/src/`. **Only rename the test-app, do NOT rename the workspace package** (`packages/bodhi-pi-web` stays, mirroring how `packages/bodhi-pi-cli` survived the cli port).
- Chrome-ext test-app: `packages/bodhi-pi/e2e/test-app-chrome-ext/` — ported from `packages/bodhi-pi-chrome-ext/src/`.
- New runtime-specific buckets: `e2e/browser-playwright/` and `e2e/chrome-ext-playwright/` for surface that only exists in those frontends (narrow core-flow Playwright — provider setup, model selection, chat, tool call, slash command, extension).

The published adapter package `@bodhiapp/bodhi-pi-browser` (factories like `createZenfsFilesystem`, `createDexieSessionStore`, `createBrowserScriptExecutor`, `createMessagePortStream`) needs to be **inlined into `e2e/helpers/`** — same rule as `bodhi-pi-node` was inlined as `e2e/helpers/node-filesystem.ts` in Phase 3. `bodhi-pi/e2e` cannot depend on any `@bodhiapp/bodhi-pi-*` workspace package.

## What's been built before you

Read these to understand the shape we're following:

- `ai-docs/plans/we-have-decided-to-fuzzy-valley.md` — Phases 1–5. End state: three Vitest projects (`in-memory`, `cli`, `http`) running `e2e/shared/*.e2e.ts`, plus narrow runtime-specific buckets.
- `packages/bodhi-pi/e2e/CLAUDE.md` — the conventions you must follow.
- `packages/bodhi-pi/e2e/helpers/harness.ts` — `createE2EHarness(opts)` dispatches on a runtime sentinel. You'll add `browser` and `chrome-ext` branches.
- `packages/bodhi-pi/e2e/helpers/http-connection.ts` — Node fetch+SSE client implementing `BodhiPiAcpConnection`. The browser/chrome-ext transports follow the same pattern shape (`BodhiPiAcpConnection` implementation) but the actual bytes flow through a browser tab driven by Playwright.
- `packages/bodhi-pi-browser/CLAUDE.md` — what `bodhi-pi-browser` ships (FSA-rooted filesystem, Dexie sessions, AsyncFunction CSP needs).
- `packages/bodhi-pi-web/CLAUDE.md` — the existing reference browser host (Vite/React + Web Worker).
- `packages/bodhi-pi-chrome-ext/CLAUDE.md` — the existing reference MV3 host.

## Direction (not a prescription — explore + propose)

The user provided these high-level techniques. Treat them as hints; question each one and produce a concrete proposal:

1. **A bare ACP-frame UI route**. For the shared suite, expose a route like `/acp` on the test-app that's a "plain cli" — an input field that takes raw ACP JSON-RPC frames, a submit button, and a streaming output area that captures every inbound ACP event for assertion. The Node-side harness drives this route. This route is the runtime's "headless" surface, analogous to `test-app-cli --rpc`. Decide the exact wire format (single textarea? one box per method? WebSocket bridge from the Node harness back to the browser tab?) during plan time.
2. **Inline `bodhi-pi-browser` factories into `e2e/helpers/`**. Same rule as the node-adapters inline (Phase A of the dependency-removal plan): `bodhi-pi/e2e/` must not depend on `@bodhiapp/bodhi-pi-browser`. Copy the factories into `e2e/helpers/browser-adapters/` and consume via the `@e2e/*` tsconfig path alias.
3. **chrome-ext is the awkward one**: MV3 extensions are `manifest.json` + `index.html` — no dev server to route `/acp` against. Options to explore: (a) link from the main popup to an `acp.html` page; (b) react-router with hash routes inside one HTML file; (c) post-message protocol where the popup *is* the ACP frame submission UI in a "headless mode" view triggered by a URL hash. Pick what's simplest after reading the chrome-ext source.
4. **Playwright is out of scope for this port.** vitest and Playwright are two separate runners; we don't co-mingle them. `e2e/browser-playwright/` and `e2e/chrome-ext-playwright/` are reserved as placeholders for future work — not part of the runtime port. Whoever picks up Playwright next will decide how it runs (separate `npm run` script, its own workspace, etc.). The scope of THIS prompt is shared/e2e parity only — driving the `/acp` headless route from Node.
5. **justfile**: update so `just test` runs the new project. Drop or repoint the standalone `bodhi-pi-web` / `bodhi-pi-chrome-ext` test:e2e steps as the suites are consolidated into bodhi-pi e2e.

## Things to explore + decide before writing code

These are open questions for plan time:

- **How does the harness drive a browser tab?** The test-app needs to be running (vite dev server or a built static bundle) and reachable by Playwright. Does Playwright's `webServer` config in vitest fit, or do we spawn vite in a per-test fixture? Compare cost vs. test-app-http's in-process boot.
- **One Playwright instance shared across all shared tests, or one per test?** Browser context creation is expensive — probably one shared context with per-test pages.
- **The ACP-frame transport**: serializing JSON-RPC frames through a textarea is one option. A WebSocket between the Node harness and the browser tab is another (the tab opens WS back to a small Node service spawned by the harness). MessagePort across iframes is another. Investigate, propose.
- **CSP / AsyncFunction quirks**: `bodhi-pi-browser`'s script executor uses AsyncFunction which requires `unsafe-eval`. Confirm the test-app builds with the right CSP and document any constraints. Chrome-ext is stricter than web — investigate.
- **Workspace seeding**: the harness's `WorkspaceSeed` model writes files into the host's filesystem. In browser the filesystem is ZenFS / FSA-rooted. The harness needs a way to seed the browser-side FS before each test — likely a setup step exposed in the test-app's `/acp` page or a global like `window.__bodhiPiTestSeed`.
- **API keys**: tests use `process.env.OPENAI_API_KEY` etc. The browser tab doesn't have process.env. Pass keys via URL query, postMessage, or a `<script>` injection at test setup. Don't bake keys into the bundle.
- **Single workspace package or two for the test-apps?** test-app-browser and test-app-chrome-ext share a lot of UI code (both use the bodhi-pi-browser adapters and similar slash-command surface). Consider whether a shared `e2e/test-app-shared-ui/` makes sense or each test-app is fully independent like test-app-cli was.

## Conventions to follow (non-negotiable, codified in `e2e/CLAUDE.md`)

- Global env in `e2e/global-setup.ts`; tests use `process.env.NAME!`.
- 30s default `testTimeout`; documented `60_000` override only when necessary.
- Flow-consolidate tests when setup is identical and steps don't conflict; `expect.soft()` for cumulative assertions.
- `bodhi-pi/e2e` must not depend on `@bodhiapp/bodhi-pi-*` workspace packages. Inline what you need under `e2e/helpers/`.
- One commit per phase, green gates between phases.

## Workflow

1. Read the references above in order. Especially `bodhi-pi-browser/CLAUDE.md` and `bodhi-pi-web/CLAUDE.md` to internalize the browser-host constraints (worker realm, ZenFS, FSA, AsyncFunction CSP).
2. Explore `packages/bodhi-pi-web/src/` and `packages/bodhi-pi-chrome-ext/src/` — understand the current UI, the worker boundary, the bridge between main thread and worker.
3. Compare against the existing http port to understand the harness-spawns-server pattern, then map it to "harness-spawns-Playwright-against-a-test-app" for browser.
4. Decide the ACP-frame UI route format and the browser↔Node bridge (textarea? WS? postMessage?).
5. Decide the chrome-ext routing trick (link from popup? hash routes? separate `acp.html`?).
6. Ask clarifying questions where ambiguous (bundle strategy, playwright sharing, workspace-seed wire format, etc.).
7. Propose a plan via `ExitPlanMode` after writing it to a new `ai-docs/plans/<slug>.md`. Split into phases: first browser (the simpler of the two), then chrome-ext after browser is green.
8. Implement phase-by-phase. Each phase ends green.

End state: `cd packages/bodhi-pi && npm run test:e2e` shows five project labels (`|in-memory|`, `|cli|`, `|http|`, `|browser|`, `|chrome-ext|`) on the shared suite, plus browser-playwright + chrome-ext-playwright buckets. `just test` green.

## Why this is the riskiest port so far

cli is "ACP over stdio in a Node child process" — same language, same APIs.

http is "ACP over fetch+SSE between two Node processes" — different protocol, same language.

browser is "ACP between a Node test harness and a JavaScript runtime in Chromium". The bridge crosses a process boundary AND a runtime boundary. Many things that look obvious in Node don't work: `process.env`, `node:fs`, `child_process`, `SharedArrayBuffer` without CORS headers, AsyncFunction without CSP, IndexedDB without origin isolation.

Expect to discover constraints during plan time that aren't visible from reading. Add them to the plan as "discovered during exploration" rather than retrofitting them later.
