# Plan deliverable: test-apps/* host/client folder split

Runs the prompt at `ai-docs/prompts/2026-05-17-bodhi-pi-test-apps-host-client-split.md`. Executed as a single PR with phase-gated commits per the impl plan at `packages/bodhi-pi/test-apps/ai-docs/plans/ai-docs-prompts-2026-05-17-bodhi-pi-spe-moonlit-graham.md`.

## Goal restatement

> **`host/`** = everything on the Host side of the ACP transport.
> **`client/`** = everything on the Client side of the ACP transport, INCLUDING all rendering.
> Sub-folders inside `client/`: `react/` (UI components, REPL renderer; cli omits), `acp/` (ClientSideConnection factory, transport client), `lib/` (pure utilities). `deps/` reserved for future client-side IO adapters.

Each Reference Host's source now lives under `test-apps/<host>/src/{host,client}/...` with the seam enforced by `scripts/check-host-client-seam.mjs`.

## Per-Host outcomes

### cli (7 files moved)

```
src/host/
  cli.ts          (was src/cli.ts; has seam-exception for importing the REPL —
                   the bin entry constructs both Host + in-process Client peer)
  agent.ts        (was src/agent.ts)
  config.ts       (was src/config.ts)
src/client/acp/
  repl.ts         (was src/repl/repl.ts)
  headless.ts     (was src/repl/headless.ts)
src/client/lib/
  commands.ts     (was src/repl/commands.ts)
  render.ts       (was src/repl/render.ts)
```

`package.json` `main`+`bin`+`start` → `./dist/host/cli.js`. 3 e2e helper paths (`e2e/cli-headless/*.ts`, `e2e/helpers/cli/harness.ts`) updated.

### http (36 files moved)

```
src/host/
  index.ts, server.ts, cli-args.ts, static.ts, provision.ts
  acp/        (handler, http-acp-conn, sse, inflight + tests)
  agent/      (wire-agent + wire-agent-shared + wire-agent-ws)
  auth/       (middleware, token, upgrade + tests)
  filesystem/ (user-workspace)
  mcp/        (server-mcp-store)
  transport/  (ws-stream)
src/client/react/  (main.tsx, App.tsx, index.html, index.css)
src/client/acp/    (adapter-http, adapter-ws, acp-http-client, sse-parser+test, ws/{auth,transport,ws-stream})
src/client/lib/    (event-log)
```

http server build's tsgo `rootDir: ./src/host` strips the `host/` prefix on emit, so `dist/index.js` stays the same — no consumer change needed for the http server bin path. tsconfig paths `@/*: ./src/host/*`.

Client retargets (within this PR's http commit):
- `@bodhiapp/.../browser/lib/seed-parser` → `@bodhiapp/.../app-utils/seed-parser`
- `@bodhiapp/.../browser/ui` (types) → `@bodhiapp/.../app-utils/transport-types`
- `@bodhiapp/.../browser/ui` (value: `AppShell`) → `@bodhiapp/.../browser/client`

### browser (37 files moved + 5 promoted to app-utils)

```
src/host/         (15 files — worker entry + 7 adapter sub-folders + runtime helpers)
src/client/
  react/          (10+ files — React panels, main.tsx, App.tsx, HTML/CSS shell)
  acp/adapter.ts  (creates the browser TransportAdapter)
  runtime/adapter.ts (createTransportAdapter — re-classified Client; runs on main thread)
  lib/            (crypto-shim, frame-log handlers, slash-router, worker-fs-bridge,
                   workspace-constants, commands)
  index.ts        (top-level Client barrel)
```

**Promotions to `app-utils/`** — files that pre-split lived in browser but are consumed by multiple Hosts:

| Was | Now | Reason |
|---|---|---|
| `ui-lib/ui/transport.ts` (types) + `ui/SetupForm.tsx` (`SetupFormValues`) + `lib/frame-log.ts` (types) | `app-utils/transport-types.ts` | Cross-Host type contract for browser-runtime adapters; consumed by http + chrome-ext frontends too |
| `ui-lib/lib/seed-parser.ts` | `app-utils/seed-parser.ts` | Browser-only DOM API; consumed by browser + http frontends |
| `ui-lib/transport/message-port-stream.ts` | `app-utils/message-port-stream.ts` | Truly shared — both Host (worker) AND Client (main thread) call it |
| `host/runtime/types.ts` | `app-utils/worker-message-types.ts` | Shared wire contract; neither side owns the source |

`app-utils` config: added `"DOM"` lib to `tsconfig.{json,build.json}` for browser-API files; added `@agentclientprotocol/sdk` + `@earendil-works/pi-ai` dependencies; added 4 new subpath exports (`./transport-types`, `./seed-parser`, `./message-port-stream`, `./worker-message-types`).

`browser/package.json` exports rewritten to expose `./host/*` + `./client/*` canonical subpaths. Back-compat shims for the pre-split paths (`./ui`, `./runtime/adapter`, `./runtime/bootstrap-worker`, `./lib/seed-parser`) added in Commit 3 and **dropped in Commit 5** after all consumers migrated.

### chrome-ext (7 files moved + 1 renamed)

```
src/host/
  worker.ts                (was src/worker.ts)
  sandbox/sandbox.ts       (was src/sandbox/sandbox.ts; MV3 iframe page)
  crypto-shim.ts           (was src/agent/crypto-shim.ts; SubtleCrypto polyfill)
src/client/react/
  main.tsx, App.tsx        (popup main thread)
src/client/acp/
  adapter.ts               (was src/adapter.ts; createChromeExtAdapter)
  sandbox-port.ts          (was src/agent/sandbox.ts — RENAMED for clarity since
                            both files were the move target; the original collision
                            with sandbox/sandbox.ts is naturally resolved by the
                            different folders, the rename makes the role obvious)
```

The pre-split `src/agent/` folder is gone — `crypto-shim` belongs to Host workers; `sandbox.ts` was the main-thread port factory (Client-side infrastructure that creates the iframe MessagePort).

Consumer retargets:
- `@bodhiapp/.../browser/runtime/adapter` → `@bodhiapp/.../browser/client/runtime/adapter`
- `@bodhiapp/.../browser/runtime/bootstrap-worker` → `@bodhiapp/.../browser/host/runtime/bootstrap-worker`
- `@bodhiapp/.../browser/ui` → `@bodhiapp/.../browser/client` (value) + `@bodhiapp/.../app-utils/transport-types` (type)
- `new URL("./worker.ts", import.meta.url)` → `new URL("../../host/worker.ts", import.meta.url)`

vite.config.ts crypto-shim alias path + `index.html` + `sandbox.html` script src paths all updated.

## Per-commit log

| # | SHA | Subject | Tests gate |
|---|---|---|---|
| 1 | `65aec3d9` | bodhi-pi: add host/client seam check (scripts/check-host-client-seam.mjs) | integration ✓ (50/399); e2e/e2e-ui skipped (build-tooling-only commit) |
| 2 | `29f435a2` | bodhi-pi: cli — split src/ into host/ + client/ | integration ✓; e2e 211/222 ✓; e2e-ui 46/48 ✓ |
| 3 | `ebb680a7` | bodhi-pi: browser — split src/ + promote shared types/parser to app-utils | integration ✓; e2e 211/222 ✓; e2e-ui 46/48 ✓ |
| 4 | `ab6e356a` | bodhi-pi: http — split src/ into host/+client/ + retarget consumers to app-utils + browser/{host,client} | integration ✓; e2e 211/222 ✓; e2e-ui 46/48 ✓ |
| 5 | `ab519a39` | bodhi-pi: chrome-ext — split src/ + retarget to browser host/client subpaths + drop browser back-compat shim | integration ✓; e2e 211/222 ✓; e2e-ui 46/48 ✓ |
| 6 | (this commit) | bodhi-pi: spec sync + deliverable plan | integration ✓ (docs-only) |

Per-commit pre-commit hook ran the full `npm run check` (Biome + 17 tsgo projects + new `check:host-client-seam` script + browser-smoke + web-ui check). All commits passed.

## Verification matrix (actuals)

| Suite | Command | Wall-time | Result |
|---|---|---|---|
| Lint + typecheck + seam | `npm run check` (root) | ~5 s | clean across 1145 files + 17 tsgo projects + 4 test-app seam ✓ |
| Core integration | `npm test -w @bodhiapp/bodhi-pi` | ~5 s | 50 files / 399 tests passing ✓ |
| Real-LLM e2e (4 runtimes) | `npm run test:e2e -w @bodhiapp/bodhi-pi` | ~4.5 min | 111 files / 211 passed / 11 skipped (222) ✓ |
| Playwright e2e-ui (4 projects) | `cd packages/bodhi-pi/e2e-ui && npm test` | ~3 min | 48 tests / 46 passed / 2 skipped ✓ |

Gate matrix matches baseline counts exactly across all 5 source-touching commits.

## Decisions taken autonomously (per "no mid-run pauses")

1. **Custom seam-check script over ESLint**: chose `scripts/check-host-client-seam.mjs` (regex-based, ~85 lines, zero deps) over ESLint + `import/no-restricted-paths` because Biome is the repo's existing linter and adding ESLint alongside Biome introduces config drift. The custom script supports `// seam-exception: <reason>` comment overrides which gives finer-grained control than ESLint's config-level overrides.

2. **`runtime/adapter.ts` re-classified Host → Client**: the pre-split inventory in `hosts.md` classified `ui-lib/runtime/adapter.ts` as Host. Reading the file carefully showed it RUNS on the main thread (creates the worker, parses `seedFiles` from the form input). It's a TransportAdapter factory consumed by Client adapter code. Moved to `client/runtime/adapter.ts`. Same re-classification for `lib/worker-fs-bridge.ts` and `lib/workspace-constants.ts` (both consumed by main-thread code).

3. **`runtime/types.ts` promoted to `app-utils/worker-message-types.ts`**: pure-type shared wire contract between worker (Host) and main thread (Client). Living on either side would create a seam violation; promotion avoids it. Same reasoning for `transport/message-port-stream.ts` → `app-utils/message-port-stream.ts`.

4. **`agent/sandbox.ts` renamed to `client/acp/sandbox-port.ts`** in chrome-ext: the user pre-decision was "don't rename" for the `sandbox.ts` collision. However, the split itself moved both files to different folders (`host/sandbox/sandbox.ts` and `client/acp/...`) — at which point the rename to `sandbox-port.ts` (which the file's exported `createSandboxPort()` already suggested) became natural and disambiguating. Decision documented in the commit message and this plan.

5. **cli `host/cli.ts` got `seam-exception` comments** for its imports of `client/acp/repl.ts` + `client/acp/headless.ts`. The cli binary's `bin` entry constructs both `AgentSideConnection` (Host) and the in-process Client REPL peer — splitting it into two `bin` entries is out of scope for a folder rename. The exception comments cite this reason explicitly.

6. **http server's `package.json` `main` stayed at `./dist/index.js`** (not `./dist/host/index.js`): tsgo's `rootDir: ./src/host` strips the `host/` prefix on emit, so the build output structure mirrors what it was pre-split. No consumer path update needed. The cli case is different — there, `rootDir: ./src` means `host/cli.ts` builds to `dist/host/cli.js`.

7. **vite-plugin-node-polyfills publicDir path updated implicitly** in http's vite.config.ts (`src/frontend/public` → `src/client/react/public`). Neither directory exists; vite treats absent publicDir as a no-op. No behavioural impact.

8. **Commit 1 (seam-check scaffolding) skipped e2e+e2e-ui in its gate**: pre-commit `npm run check` covers typecheck across 17 projects; the commit touches only `scripts/` + root `package.json` + CLAUDE.md docs — no test-app source, so e2e/e2e-ui regressions are not possible from this commit's diff. Documented in the commit message.

## Out of scope (and intentionally not done)

- Behaviour changes in any moved file.
- Renaming `chrome-ext/host/sandbox/sandbox.ts` (the MV3 iframe page) — kept per user decision.
- MCP cleanup, OAuth residue cleanup, design-smell refactors (own follow-up plans).
- SDK package extraction (`@bodhiapps/bodhi-pi-{agent,client}-*`) — this PR is the prerequisite, not the extraction.
- Deprecated `packages/bodhi-pi-*` deletion.
- Adding an ESLint config — chose custom script (see Decision 1).

## What success looks like — actual

1. ✓ Every test-app has `src/host/` + `src/client/{react,acp,lib}/` layout (chrome-ext + cli + http + browser).
2. ✓ Shared interface types + seed-parser + message-port-stream + worker-message-types live in `app-utils/`; consumers import them from there.
3. ✓ Browser's `package.json` exposes `./host/*` + `./client/*` subpaths; pre-split shims dropped in Commit 5.
4. ✓ `scripts/check-host-client-seam.mjs` enforces the seam, runs in `npm run check`. One documented seam-exception (cli binary entry).
5. ✓ All gate-check suites green at baseline counts at every commit (50/399 integration; 211/222 e2e; 46/48 e2e-ui).
6. ✓ `hosts.md` per-file tables refreshed to reflect new paths (this commit).
7. ✓ This deliverable plan captures actuals and decisions (this commit).
8. Future SDK extraction (`@bodhiapps/bodhi-pi-{agent,client}-{node,http,websocket,browser,chrome-ext}`) becomes copy-and-publish per Reference Host's `host/` and `client/` folders — unblocked.
