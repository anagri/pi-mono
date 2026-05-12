# Kickoff: port the WebSocket runtime into bodhi-pi/e2e/

This is a new chat session. Read this prompt end-to-end, explore the codebase, ask clarifying questions, then propose a plan. Do NOT start implementing until the plan is approved.

## Goal

Add a fourth Vitest project — `ws` — to `packages/bodhi-pi/e2e/vitest.e2e.config.ts` so the same `e2e/shared/**/*.e2e.ts` files run a fourth time against a WebSocket-based ACP transport, proving uniform agent behavior across the runtime family (in-memory, cli stdio, http+SSE, ws). Add a small runtime-specific bucket `e2e/ws-playwright/` for surface that only exists in the ws frontend (core flow Playwright), mirroring `e2e/http-playwright/`.

## Where the work happens

Today there are two related packages: `packages/bodhi-pi-ws-server` (Node WS server, multi-tenant SQLite, ACP over WebSocket) and `packages/bodhi-pi-ws-frontend` (React client). The user wants these collapsed into a single self-contained Node project under `packages/bodhi-pi/e2e/test-app-ws/` with two sub-folders:

- `e2e/test-app-ws/src/server/` — ported from `packages/bodhi-pi-ws-server/src/`
- `e2e/test-app-ws/src/frontend/` — ported from `packages/bodhi-pi-ws-frontend/src/`

The frontend is served on a sub-path of the same Node process (mirroring the bodhi-pi-http single-project shape). The two `packages/bodhi-pi-ws-*` directories stay in `packages/` (consistent with how we kept the old `bodhi-pi-cli` / `bodhi-pi-http` after porting them under `e2e/test-app-*`).

## What's been built before you

Read these to understand the shape we're following:

- `ai-docs/plans/we-have-decided-to-fuzzy-valley.md` — the original consolidation plan (Phases 1–5). End state: three Vitest projects (`in-memory`, `cli`, `http`) running the same `e2e/shared/*.e2e.ts`, plus runtime-specific buckets (`cli-headless/`, `http-playwright/`).
- `packages/bodhi-pi/e2e/CLAUDE.md` — the conventions: three-parts-of-a-test rule, flow-consolidation criteria, soft-assert usage, runtime-skipping, the **no-`@bodhiapp/bodhi-pi-*` dependency rule** (e2e helpers inline what they need from sibling packages — see `e2e/helpers/node-filesystem.ts` for the pattern).
- `packages/bodhi-pi/e2e/helpers/harness.ts` — `createE2EHarness(opts)` dispatches on a runtime sentinel set in `e2e/setup/<runtime>.ts`. You'll add an `e2e/setup/ws.ts` and a new branch in the harness.
- `packages/bodhi-pi/e2e/helpers/http-connection.ts` — Node HTTP+SSE client implementing `BodhiPiAcpConnection`. The ws branch needs a similar helper that speaks ACP over a Node WebSocket client.
- `packages/bodhi-pi-http/CLAUDE.md` and `packages/bodhi-pi-http/src/server/` — the model we follow for "single project with server + frontend on one port".
- `packages/bodhi-pi-ws-server/CLAUDE.md` and `packages/bodhi-pi-ws-frontend/CLAUDE.md` — what the existing pair does today.
- Recent commits `e8202612`, `b67ce119` — Phase 3 (http added) and the http-parity fix (always rehydrate when sessionId is in params). Read these to understand how the http branch was structured; the ws branch should follow the same shape where it makes sense.

## Direction (not a prescription — explore + propose)

The general shape we expect:

1. **Single project under `e2e/test-app-ws/`** with its own `package.json` (private), `tsconfig*.json`, build scripts. The server boots on an ephemeral port. The frontend is served on a sub-path; `npm run dev` boots both for human use.
2. **The harness branch** (`createWsHarness` in `e2e/helpers/harness.ts`) spawns the server (or boots it in-process — your call after exploring), mints a test token if the server requires auth, and wires a Node WS client implementing `BodhiPiAcpConnection`. Same return shape as the other branches.
3. **An inlined ws-client helper** (`e2e/helpers/ws-connection.ts`) implementing `BodhiPiAcpConnection` over the `ws` npm package or Node's native `WebSocket`. Ports from the existing ws-frontend client; lives in `e2e/helpers/` so `bodhi-pi/e2e` has zero dependency on `@bodhiapp/bodhi-pi-ws-server` or `@bodhiapp/bodhi-pi-ws-frontend` at the package-level (matches the rule from the http port). If the server has stateless-deployment quirks like bodhi-pi-http's per-turn agent rebuild, surface them; otherwise it should "just work" once the transport is wired.
4. **Playwright is out of scope for this port.** vitest and Playwright are two separate runners; we don't co-mingle them. `e2e/ws-playwright/` is reserved as a placeholder for future work — not part of this runtime port. Whoever picks up Playwright next will need to decide how it runs (separate `npm run` script, its own workspace, etc.). Same deferral applies to `http-playwright/`, `browser-playwright/`, `chrome-ext-playwright/`.
5. **justfile**: drop the standalone `bodhi-pi-ws-server` and `bodhi-pi-ws-frontend` test:e2e entries (their suites are consolidated into bodhi-pi e2e), or update them as appropriate.
6. **Skips**: the http port required two e2e tests to skip until a server bug was fixed. Audit the ws transport for similar quirks; either fix them or document and `runIf` until later.

## Things to explore + decide before writing code

These are open questions you should resolve during the plan phase:

- **In-process vs spawned**: bodhi-pi-http boots via `buildServer({port:0, ...})` in-process. Cli is spawned. Pick what fits ws-server's shape after reading `packages/bodhi-pi-ws-server/src/server/`.
- **Auth**: does the existing ws-server require a bearer token like http? How does the existing ws-frontend mint one? Does the consolidated test-app need the same mechanism, or simpler?
- **Models + API keys**: bodhi-pi-http accepts `models: [...]` + `getApiKey` at `buildServer` time. Does ws-server have the same hook? If not, what's the easiest way to inject test API keys without modifying the existing ws-server source (we kept it intact)?
- **The chat model-switch test** and **/tree + /goto test** required the http handler to rehydrate before every JSON method with a sessionId. Does ws-server have the same "stateful protocol on stateless transport" property, or does it keep agents alive for the lifetime of a WS connection (more like cli)? Your transport-shape analysis decides whether new skips will be needed.
- **bodhi-pi-http port is incomplete** (it currently lives in `packages/bodhi-pi-http/` and is consumed via a deep import + workspace devDep). Properly porting it under `packages/bodhi-pi/e2e/test-app-http/` will be done by the user before you start. Confirm the state of that port at session start — your test-app-ws should follow the resulting pattern.

## Conventions to follow (non-negotiable, codified in `e2e/CLAUDE.md`)

- `e2e/global-setup.ts` lists required env vars; tests use `process.env.NAME!` directly.
- 30s default `testTimeout`; documented `60_000` override only when truly necessary.
- Flow-consolidate tests when setup is identical and steps don't conflict; use `expect.soft()` for cumulative assertions.
- `bodhi-pi/e2e` must not depend on `@bodhiapp/bodhi-pi-*` packages. Inline what you need under `e2e/helpers/`.
- One commit per phase. Each phase ends with `npm run test:e2e` green for the in-scope project, `just test` green at monorepo level.

## Workflow

1. Read the references above in order. Build a mental model of how the cli and http ports were structured.
2. Explore `packages/bodhi-pi-ws-server/` and `packages/bodhi-pi-ws-frontend/` — understand the existing transport, auth, agent boot, and frontend wiring.
3. Compare against the ws CLAUDE.md hosts inventory rule (`packages/bodhi-pi/CLAUDE.md`).
4. Ask clarifying questions where genuinely ambiguous (in-process vs spawn, frontend bundle strategy, ws library choice, etc.).
5. Propose a plan via `ExitPlanMode` after writing it to a new `ai-docs/plans/<slug>.md`.
6. Implement phase-by-phase with green gates and retrospectives between phases (same rhythm as Phases 1–5).

End state: `cd packages/bodhi-pi && npm run test:e2e` shows four project labels (`|in-memory|`, `|cli|`, `|http|`, `|ws|`) on the shared suite, plus `|ws|`-only Playwright in `ws-playwright/`. `just test` green.
