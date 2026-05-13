# Kickoff: port the WebSocket runtime into bodhi-pi/e2e/

This is a new chat session. Read this prompt end-to-end, explore the codebase, ask clarifying questions, then propose a plan via `ExitPlanMode`. Do NOT start implementing until the plan is approved.

## Goal

Add a fourth Vitest project — `ws` — to `packages/bodhi-pi/e2e/vitest.e2e.config.ts` so the same `e2e/shared/**/*.e2e.ts` files run a fourth time against a WebSocket-based ACP transport. Three projects exist today (`in-memory`, `cli`, `http`); after this work the consolidated `npm run test:e2e` report shows four project labels (`|in-memory|`, `|cli|`, `|http|`, `|ws|`) covering the shared suite uniformly.

**Headless ACP only.** Playwright and browser-based test surfaces (`ws-playwright/`, `browser-playwright/`, `chrome-ext-playwright/`) are deferred sitewide and NOT in scope. Manual smoke via claude-in-chrome is the only browser-side check this work owns.

## Where the work happens (strong recommendation)

**Extend the existing `packages/bodhi-pi/e2e/test-app-http/` workspace** with a `/acp-ws` WebSocket endpoint on the server side and a sibling `/ws/`-routed page on the frontend side, rather than creating a parallel `e2e/test-app-ws/` workspace. The two are already analogous Node projects with a server + frontend in one bundle — collapsing into one keeps the e2e harness's test-app surface lean (one project to maintain, one `npm run dev` command for humans).

This is a **strong recommendation, not a strict constraint**. The implementer may propose a separate `e2e/test-app-ws/` after exploration, but must justify it with concrete blockers found in test-app-http's current shape.

Evidence backing the recommendation (from initial exploration):

- test-app-http's HTTP listener is bare Node `createServer()` (`packages/bodhi-pi/e2e/test-app-http/src/server/server.ts`) — the raw `Server` instance is in scope, so `server.on('upgrade', ...)` for WebSocket upgrade slots in cleanly with no wrapper to peel back.
- The existing per-request agent factory (`packages/bodhi-pi/e2e/test-app-http/src/server/agent/wire-agent.ts` — `wireAgentForRequest(opts) → { cwd, factory }`) is already shaped as `(conn: AgentSideConnection) => Agent`. A per-WS-connection ws handler can reuse the same factory shape; only the agent lifetime changes (HTTP rebuilds per request; WS keeps it alive for the connection).
- The frontend is already a Vite React app under `src/frontend/`. Adding a `/ws/` route is one page component + one entry in the router; no new dev-server.
- `tsgo` + `tsc-alias` builds in test-app-http transparently pick up new `src/server/ws/` and `src/frontend/ws/` directories; tsconfig includes already use globs that cover them.
- Production `bodhi-pi-http` has no WebSocket endpoint, so the e2e addition does not require any production-code change.

Alternative (only if blockers emerge): create `packages/bodhi-pi/e2e/test-app-ws/` mirroring test-app-http's shape. Mention this only if the recommendation can't fly.

## What to preserve from `bodhi-pi-ws-server` (semantics, not file layout)

Port these semantics directly when the implementer wires `/acp-ws` into test-app-http:

- **Stateful-per-connection agent lifecycle.** One AcpAgent per WebSocket upgrade, alive for the connection lifetime. WS `close` → agent evicted. In-flight prompts cancellable on disconnect. Reconnect = fresh agent, rehydrated from SQLite. This is the architectural distinction vs the HTTP transport's per-turn-rebuild — preserving it is the whole reason `|ws|` is a fourth project rather than a transport flavor of `|http|`.
- **Auth at upgrade time via `Sec-WebSocket-Protocol`**: `bodhi-pi.v1, bearer.<token>` subprotocol. No per-message re-validation. Reuse test-app-http's existing token-mint helpers (`mintTestToken` / the verifier in `src/server/auth/`) — same token shape across `/acp` and `/acp-ws`, two paths sharing the same auth surface.
- **Multi-tenant SQLite scoped by userId**, exactly as ws-server does today and as test-app-http already does for the HTTP path. Per-user workspace under `<dataDir>/users/<userId>/workspace/`.
- **Frame format**: newline-delimited JSON-RPC over text frames via the ACP SDK's `ndJsonStream` — a thin adapter wraps the WS socket into Web `ReadableStream` / `WritableStream`, then `ndJsonStream` does the rest. Mirror `packages/bodhi-pi-ws-server/src/transport/ws-stream.ts`.
- **Lifecycle events** flow via `extNotification("_bodhi-pi/lifecycle/event", ...)` exactly like the HTTP+SSE path. Fire-and-forget; never blocks agent execution. The harness's `harness.events` array (from the recently-landed events work) populates the same way.
- **Models / API keys** flow through the existing `WireAgentOptions { models, defaultModelId, getApiKey }` — same `buildServer`-time injection.

## What to port from `bodhi-pi-ws-frontend`

The browser side of ws-frontend folds into test-app-http's frontend as a sibling page:

- Move the ACP-over-WS client code (`packages/bodhi-pi-ws-frontend/src/lib/transport.ts`, `lib/ws-stream.ts`, `lib/auth.ts`) into `packages/bodhi-pi/e2e/test-app-http/src/frontend/ws/lib/` (or wherever the existing frontend directory conventions suggest).
- Add a `/ws/` route to test-app-http's React router. The page is a minimal chat shell that connects to `/acp-ws` of the same origin, reusing whatever settings-modal / session-list / chat-stream components the existing test-app-http UI provides.
- Goal: when a developer runs `npm run dev` in test-app-http, ONE Node process boots the server + Vite. Visiting `http://localhost:<port>/` shows the HTTP+SSE chat; visiting `http://localhost:<port>/ws/` shows the WS-backed chat. Same backend, two transports surfaced via different routes.
- **No Playwright in this work.** The frontend exists so a human (or claude-in-chrome at session end) can manually verify the UI. The future Playwright work — when un-deferred — will decide whether to colocate the spec with this frontend or in a separate runner workspace.

## Node WS client for the harness

The Vitest project's branch of `createE2EHarness` needs a Node-side WebSocket client implementing `BodhiPiAcpConnection`:

- `packages/bodhi-pi/e2e/helpers/ws-connection.ts` — port from `packages/bodhi-pi-ws-frontend/src/lib/transport.ts` but stripped of browser-only bits (use the `ws` npm package or Node 22's native `WebSocket`).
- Implements the same `BodhiPiAcpConnection` interface that `e2e/helpers/http-connection.ts` already implements. Same shape; same `onUpdate` / `onLifecycleEvent` hooks for events plumbing.
- Mints/verifies the bearer token the same way the http harness does; passes it via `Sec-WebSocket-Protocol`.

Inline the client under `e2e/helpers/` — `bodhi-pi/e2e` must NOT import from `@bodhiapp/bodhi-pi-ws-*` packages directly (same rule the http port followed).

## Plumbing checklist

- `e2e/setup/ws.ts` — Vitest setup file that sets the runtime sentinel.
- `e2e/vitest.e2e.config.ts` — fourth project block (`ws`).
- `e2e/helpers/harness.ts` — `createWsHarness(opts)` branch. Boots the test-app-http server (in-process via `buildServer({ port: 0, ... })` is the simplest path; spawn is fine too — confirm during exploration), mints a per-test token, constructs the Node WS client, returns the same `E2EHarness` shape every other branch returns.
- `e2e/helpers/ws-connection.ts` — the Node WS client (see above).
- `e2e/global-setup.ts` — add any env vars the ws harness reads (likely just the existing http-server env vars, since it's the same server).
- `justfile` — drop the standalone `bodhi-pi-ws-server` / `bodhi-pi-ws-frontend` test:e2e entries (their suites collapse here). The original `packages/bodhi-pi-ws-server/` and `packages/bodhi-pi-ws-frontend/` workspaces stay on disk for now (mirrors how `bodhi-pi-cli` / `bodhi-pi-http` stayed after their ports). A follow-up may remove them.

## Things to explore + decide before writing code

- **In-process vs spawned test-app-http**: today the http harness expects a single globally-spawned `test-app-http` server (env: `BODHI_PI_E2E_HTTP_BASE_URL`, `BODHI_PI_E2E_HTTP_DATA_DIR`). The ws harness can reuse that same global server (just connect on a different path). Confirm that the global-setup boot path is reusable for both `|http|` and `|ws|` projects without contention. If the simpler thing is one global server, do that.
- **Per-test user isolation**: today the http harness creates a fresh `userId` per test and the SQLite store isolates workspaces. The ws harness must do the same so per-test agents don't leak state across tests (otherwise the stateful-per-connection lifecycle becomes a cross-test source of bleed).
- **Existing shared-suite skips**: the events + extensions work landed without runtime-specific skips. Since the ws transport is stateful-per-connection (friendlier than per-turn-rebuild), expect ws to be a drop-in for the shared suite without new skips. Audit during implementation; flag any test that needs `runIf` with a one-line comment.
- **Routing convention for the frontend**: confirm whether the existing test-app-http frontend uses path-based routing already (look at `src/frontend/`). If yes, `/ws/` is a clean sibling. If no, the implementer either introduces a router or stages the new page at a hard-coded entry.

## Conventions to follow (non-negotiable, codified in `e2e/CLAUDE.md`)

- `e2e/global-setup.ts` lists required env vars; tests use `process.env.NAME!` directly.
- 30s default `testTimeout`; documented `60_000` override only when truly necessary.
- Flow-consolidate tests when setup is identical and steps don't conflict; use `expect.soft()` for cumulative assertions.
- `bodhi-pi/e2e` must NOT depend on `@bodhiapp/bodhi-pi-*` packages. Inline what you need under `e2e/helpers/`.
- Depth-first phasing: one runtime green at a time, one commit per slice. (See the events + extensions work in recent git history for the pattern: in-memory → http → cli; one commit per phase; regression gate between phases.)
- One commit per phase. Each phase ends with `npm run test:e2e -- --project <in-scope>` green, then full `npm run test:e2e` green for finished projects, then `just test` green at monorepo level.

## What's been built before you

Read in this order:

- `ai-docs/prompts/enable-events-shared-e2e.md` + the resulting commits (search `git log --grep "bodhi-pi e2e events"`). The events work introduced `harness.events` + `flushEvents()` + per-runtime lifecycle-event plumbing. The ws transport must keep `harness.events` populated via the same `_bodhi-pi/lifecycle/event` notification shape over the WS frame.
- `ai-docs/prompts/enable-extensions-shared-e2e.md` + the resulting commits (`git log --grep "bodhi-pi e2e extensions"`). The extensions work introduced `bodhiPiFixture` + a rich Node-package extension loader (jiti) in `e2e/helpers/extension-loaders/`. The ws harness must wire fixtures the same way the http harness does (symlink the data folder into the per-user workspace).
- `packages/bodhi-pi/e2e/CLAUDE.md` — the conventions: three-parts-of-a-test rule, flow-consolidation criteria, soft-assert usage, runtime-skipping, the no-`@bodhiapp/bodhi-pi-*` dependency rule.
- `packages/bodhi-pi/e2e/helpers/harness.ts` — `createE2EHarness(opts)` and its existing in-memory / cli / http branches. You'll add a ws branch with the same return shape.
- `packages/bodhi-pi/e2e/helpers/http-connection.ts` — Node HTTP+SSE client implementing `BodhiPiAcpConnection`, including `onLifecycleEvent` dispatch. The ws-connection.ts you write should mirror this shape.
- `packages/bodhi-pi/e2e/test-app-http/CLAUDE.md` (if present) + `src/server/` + `src/frontend/` — the host you're extending. Walk it top-down before deciding where `/acp-ws` slots in.
- `packages/bodhi-pi-ws-server/CLAUDE.md` + `src/` — the semantics you're porting. Pay attention to `auth/upgrade.ts` (subprotocol-bearer auth), `transport/ws-stream.ts` (WS↔Web-Streams adapter), `agent/wire-agent.ts` (per-connection agent factory).
- `packages/bodhi-pi-ws-frontend/CLAUDE.md` + `src/lib/transport.ts` + `src/lib/ws-stream.ts` — the browser-side WS client you're porting into test-app-http's frontend.

## Suggested phases (the implementer may refine)

The events + extensions work landed in 5–6 depth-first phases; this work is one runtime addition so it's smaller. Suggested phasing:

1. **Server side**: add `/acp-ws` to `test-app-http/src/server/` (handler + ws-stream + bearer subprotocol auth + per-connection agent lifecycle). Add the `ws` npm dep. Smoke via a hand-rolled Node WS client script (or `wscat`). Commit.
2. **Node WS client + harness branch**: create `e2e/helpers/ws-connection.ts`, `e2e/setup/ws.ts`, the fourth Vitest project block, and the `createWsHarness` branch. Run the shared suite under `--project ws`. Fix any cross-runtime divergence (likely none, given the events + extensions work already abstracted everything). Commit.
3. **Frontend side**: port `packages/bodhi-pi-ws-frontend/src/lib/{transport,ws-stream,auth}.ts` into `test-app-http/src/frontend/ws/`. Add the `/ws/` route + a minimal chat shell. Manual smoke via `npm run dev` + claude-in-chrome (verify the UI loads, connects to `/acp-ws`, can send a prompt, receives a streamed response). Commit.
4. **justfile cleanup + full gate**: drop the standalone `bodhi-pi-ws-server` / `bodhi-pi-ws-frontend` `test:e2e` entries. Run `just test` end-to-end; fix any genuine failures (and rerun flaky ones once). Commit.

## Workflow

1. Read the references above in order. Build a mental model of how the http port was structured.
2. Explore `packages/bodhi-pi-ws-server/` and `packages/bodhi-pi-ws-frontend/` — understand the existing transport, auth, agent boot, and frontend wiring.
3. Verify the strong recommendation (extend test-app-http) is sound for THIS codebase as it stands today. If not, justify the alternative.
4. Ask clarifying questions where genuinely ambiguous (in-process vs spawned global server, frontend routing convention, `ws` npm package vs Node native `WebSocket`, etc.).
5. Propose a plan via `ExitPlanMode` after writing it to a new `ai-docs/plans/<slug>.md`.
6. Implement phase-by-phase with green gates between phases.

## End state

- `cd packages/bodhi-pi && npm run test:e2e` shows four project labels (`|in-memory|`, `|cli|`, `|http|`, `|ws|`) on the shared suite; the totals add one runtime's worth of tests to the previous baseline.
- `cd packages/bodhi-pi/e2e/test-app-http && npm run dev` boots one Node process + Vite. `/` shows the HTTP+SSE chat; `/ws/` shows the WS-backed chat. Both functional via manual claude-in-chrome smoke.
- `just test` green.
- `packages/bodhi-pi-ws-server/` + `packages/bodhi-pi-ws-frontend/` workspaces remain on disk, untouched (legacy; removal is a separate follow-up).
- No Playwright / browser-test work in this PR. `e2e/ws-playwright/` is NOT created.
