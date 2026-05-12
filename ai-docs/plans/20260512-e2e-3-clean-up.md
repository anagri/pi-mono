# Drop all `@bodhiapp/bodhi-pi-*` sibling deps from `packages/bodhi-pi`

## Context

Phases 1–5 consolidated e2e into `packages/bodhi-pi/e2e/` and got `cli` + `http` projects running alongside `in-memory`. Two workspace-package dependencies on sibling `bodhi-pi-*` packages still remain inside `packages/bodhi-pi/`:

| Remnant | Where |
|---|---|
| `@bodhiapp/bodhi-pi-http` | `packages/bodhi-pi/package.json` devDep + deep-imported in `e2e/helpers/harness.ts` |
| `@bodhiapp/bodhi-pi-node` | `packages/bodhi-pi/e2e/test-app-cli/package.json` deps + 5 import sites under `e2e/test-app-cli/src/` |

Goal: zero `@bodhiapp/bodhi-pi-*` sibling-package imports anywhere inside `packages/bodhi-pi/`. Only the self-reference to core `@bodhiapp/bodhi-pi` is allowed.

Additional cleanup surfaced:
- `e2e/http-playwright/` is planned in CLAUDE.md and listed in vitest's `include` glob but the directory does not exist. The bodhi-pi-http source-package ships 20+ Playwright specs; none ported. **vitest and Playwright stay separate runners — don't merge them.**
- The relative-import cost of "inline adapters" is ugly across the test-app-cli ↔ helpers folder boundary (`../../../helpers/node-adapters/…`). Use a tsconfig path alias `@e2e/*` so imports read as `@e2e/helpers/node-adapters/...`.

## Path-alias scheme

Add a single alias used everywhere inside `packages/bodhi-pi`:

| Alias | Resolves to |
|---|---|
| `@/*` (existing) | `packages/bodhi-pi/src/*` |
| `@test/*` (existing) | `packages/bodhi-pi/test/*` |
| `@e2e/*` (new) | `packages/bodhi-pi/e2e/*` |

Define `@e2e/*` in:
- `packages/bodhi-pi/tsconfig.json` `compilerOptions.paths` — picked up by vitest via the existing `vite-tsconfig-paths` plugin in `vitest.config.ts`.
- `packages/bodhi-pi/e2e/test-app-cli/tsconfig.json` + `tsconfig.build.json` — picked up by tsgo + tsc-alias at build time.
- `packages/bodhi-pi/e2e/test-app-http/tsconfig.server.json` + `tsconfig.server.build.json` + `tsconfig.frontend.json` — same.

After this, all the messy `../../../../helpers/node-adapters/...` paths become `@e2e/helpers/node-adapters/...`.

## Phases

Depth-first. Each phase: implement → run gate → fix → commit. Move to next only after green.

### Phase A — Inline `bodhi-pi-node` adapters under `e2e/helpers/node-adapters/`

#### A1 — Inline adapter sources

1. Create `packages/bodhi-pi/e2e/helpers/node-adapters/`:
   - `filesystem.ts` (move from `e2e/helpers/node-filesystem.ts`)
   - `kv-store.ts` (port from `packages/bodhi-pi-node/src/kv/`)
   - `script-executor.ts` (port from `packages/bodhi-pi-node/src/script-executor/`)
   - `extension-loader.ts` (port from `packages/bodhi-pi-node/src/extensions/`)
   - `default-db-path.ts` (port the `defaultDbPath` helper)
   - `sessions/sqlite-session-store.ts` + `schema.ts` + `migrate.ts` (port from `packages/bodhi-pi-node/src/sessions/`)
   - `sessions/drizzle/*.sql` + `meta/_journal.json` (copy migrations)
   - `index.ts` barrel re-export
2. Add `@e2e/*` path alias to `packages/bodhi-pi/tsconfig.json` `compilerOptions.paths`.
3. Update `e2e/helpers/harness.ts` to import via `@e2e/helpers/node-adapters` (replaces the old `./node-filesystem.js` import).
4. Delete `e2e/helpers/node-filesystem.ts`.

**Gate.**
- `npm run check` clean at monorepo root.
- `cd packages/bodhi-pi && npm run test:e2e -- --project in-memory` green (unchanged).
- `cd packages/bodhi-pi && npm run test:e2e -- --project cli` green (still using the bodhi-pi-node package — sources unchanged; harness uses local copies).

**Commit:** `bodhi-pi: inline bodhi-pi-node adapters under e2e/helpers/node-adapters/ with @e2e/* alias`

#### A2 — Switch test-app-cli to the inlined adapters

1. Add `@e2e/*` path alias to `test-app-cli/tsconfig.json` and `tsconfig.build.json`. Extend `include` to cover the helpers folder so tsgo emits a self-contained `dist/`.
2. Rewrite imports in `test-app-cli/src/agent.ts`, `cli.ts`, `config.ts`: `from "@bodhiapp/bodhi-pi-node"` → `from "@e2e/helpers/node-adapters"`.
3. Drop `@bodhiapp/bodhi-pi-node` from `test-app-cli/package.json` `dependencies`. Add direct deps for native modules previously transited via bodhi-pi-node:
   - `better-sqlite3` (version to match bodhi-pi-node's)
   - `drizzle-orm` (same)
4. `npm install` at repo root to rewire.

**Gate.**
- `npm --workspace @bodhiapp/bodhi-pi-test-app-cli run build` clean.
- `cd packages/bodhi-pi && npm run test:e2e -- --project cli` green (now consuming inlined adapters).
- `grep -rn "@bodhiapp/bodhi-pi-node" packages/bodhi-pi/` returns zero matches (markdown comments OK).
- `npm run check` clean.

**Commit:** `bodhi-pi: drop @bodhiapp/bodhi-pi-node dep from test-app-cli (uses inlined helpers)`

### Phase B — Port `bodhi-pi-http` to `e2e/test-app-http/`

#### B1 — Build test-app-http (server + frontend) standalone

1. Create `packages/bodhi-pi/e2e/test-app-http/`:
   - `package.json` (`@bodhiapp/bodhi-pi-test-app-http`, private). Deps mirror `packages/bodhi-pi-http/package.json` minus `@bodhiapp/bodhi-pi-node`.
   - `tsconfig.server.json`, `tsconfig.server.build.json`, `tsconfig.frontend.json` (with `@e2e/*` path alias).
   - `vite.config.ts` (copy).
   - `src/server/` — copy from `packages/bodhi-pi-http/src/server/`.
   - `src/frontend/` — copy from `packages/bodhi-pi-http/src/frontend/`.
   - Scripts: `build`, `build:server`, `build:frontend`, `dev` (concurrent), `e2e:dev` (alias of dev), `start`.
2. In `src/server/`: replace every `from "@bodhiapp/bodhi-pi-node"` with `from "@e2e/helpers/node-adapters"`.
3. Extend `src/server/cli-args.ts`: accept `--models <provider:modelId,…>` and `--default-model <id>`. Wire into `buildServer({models, defaultModelId, ...})` in `src/server/index.ts`.
4. Add env-based `getApiKey` fallback in `src/server/index.ts` (provider → `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` map, mirroring `test-app-cli/src/cli.ts`).
5. Add `packages/bodhi-pi/e2e/test-app-http` to root `package.json` `workspaces`. `npm install`.
6. Add `tsgo --noEmit -p packages/bodhi-pi/e2e/test-app-http/tsconfig.server.json` + `tsconfig.frontend.json` to root `check` script.

**Gate.**
- `npm --workspace @bodhiapp/bodhi-pi-test-app-http run build` clean.
- `cd packages/bodhi-pi/e2e/test-app-http && npm run dev` — server + frontend boot, manual chat works in browser (developer smoke).
- `npm run check` clean.

**Commit:** `bodhi-pi: port bodhi-pi-http to e2e/test-app-http (server + frontend, env api keys, --models)`

#### B2 — Switch harness to the spawned test-app-http

1. Update `e2e/global-setup.ts`: existing required-env check stays. Add: spawn test-app-http binary with `--port 0 --data-dir <tmp> --models openai:gpt-4o-mini,openai:gpt-5-mini,anthropic:claude-haiku-4-5 --default-model gpt-4o-mini`. Wait for the "listening on http://localhost:N" stdout line; parse the port. Export `BODHI_PI_E2E_HTTP_BASE_URL` and `BODHI_PI_E2E_HTTP_DATA_DIR` to `process.env`. Return a teardown that kills the child and removes the tmpdir. Return signature: `setup(): Promise<() => Promise<void>>` (vitest globalSetup supports the teardown return).
2. Update `e2e/helpers/harness.ts` `createHttpHarness`:
   - Drop the in-process `await import("@bodhiapp/bodhi-pi-http/dist/server/server.js")` and `buildServer(...)` call.
   - Read base URL + dataDir from env.
   - Per-test, mint a unique user token (random integer id) so multi-tenant SQLite gives each test its own workspace dir at `${dataDir}/users/${userId}/workspace/`.
   - `mkdir` the per-user workspace if missing.
   - `harness.cwd` = that path. `harness.filesystem` = `createNodeFilesystem({ rootCwd: cwd })` (from inlined adapter).
   - `cleanup` removes the per-user workspace; the shared server stays up.
3. Update `packages/bodhi-pi/package.json` `test:e2e` script: replace `npm --workspace @bodhiapp/bodhi-pi-http run build:server` with `npm --workspace @bodhiapp/bodhi-pi-test-app-http run build`.

**Gate.**
- `cd packages/bodhi-pi && npm run test:e2e -- --project http` green.
- `grep -rn "@bodhiapp/bodhi-pi-http" packages/bodhi-pi/` returns zero matches.
- `npm run check` clean.

**Commit:** `bodhi-pi-http e2e: drop deep-import; spawn test-app-http in global-setup with per-test user tokens`

### Phase C — Final cleanup + Playwright deferral

1. Drop `@bodhiapp/bodhi-pi-http` from `packages/bodhi-pi/package.json` `devDependencies`.
2. `packages/bodhi-pi/vitest.e2e.config.ts`: remove `e2e/http-playwright/**/*.e2e.ts` from the http project's `include` array.
3. `packages/bodhi-pi/e2e/CLAUDE.md`: add an "Playwright is not run by vitest projects" note. The `http-playwright/`, `ws-playwright/`, `browser-playwright/`, `chrome-ext-playwright/` buckets exist (or will) under their own runner; they kick off via separate `npm run` scripts, not vitest. Strike the table row referencing `http-playwright/`.
4. `ai-docs/prompts/port-ws-runtime.md`: add a "Playwright is out of scope" block under Direction. Defer the `ws-playwright/` bucket.
5. `ai-docs/prompts/port-browser-runtime.md`: same — defer `browser-playwright/` and `chrome-ext-playwright/`.

**Gate (final monorepo green).**
- `grep -rE "@bodhiapp/bodhi-pi-(node|cli|http|browser|web|chrome-ext|ws-server|ws-frontend)" packages/bodhi-pi/` — zero matches outside markdown.
- `cd packages/bodhi-pi && npm run test:e2e` — 41 passed, 14 skipped across `|in-memory|`, `|cli|`, `|http|`.
- `npm run check` clean.
- `just test` green (tolerate unrelated playwright flake in bodhi-pi-web / chrome-ext suites; rerun if needed).

**Commit:** `bodhi-pi: drop bodhi-pi-http devDep + defer Playwright buckets`

## Critical files

**Created:**
- `packages/bodhi-pi/e2e/helpers/node-adapters/` — full tree
- `packages/bodhi-pi/e2e/test-app-http/` — full tree

**Modified:**
- `packages/bodhi-pi/tsconfig.json` — add `@e2e/*` path
- `packages/bodhi-pi/e2e/helpers/harness.ts` — `@e2e/...` imports; http branch reads env vars
- `packages/bodhi-pi/e2e/global-setup.ts` — spawn shared test-app-http; return teardown
- `packages/bodhi-pi/e2e/test-app-cli/{tsconfig*.json,package.json}` — add alias + drop bodhi-pi-node
- `packages/bodhi-pi/e2e/test-app-cli/src/{agent,cli,config}.ts` — `@e2e/...` imports
- `packages/bodhi-pi/vitest.e2e.config.ts` — drop http-playwright from include
- `packages/bodhi-pi/package.json` — drop bodhi-pi-http devDep; update test:e2e script
- `packages/bodhi-pi/e2e/CLAUDE.md` — Playwright separation note
- root `package.json` — add test-app-http workspace; update check chain
- `ai-docs/prompts/port-ws-runtime.md` — defer Playwright
- `ai-docs/prompts/port-browser-runtime.md` — defer Playwright

**Deleted:**
- `packages/bodhi-pi/e2e/helpers/node-filesystem.ts` (moved into `node-adapters/filesystem.ts`)

## Reused functions

- `mintTestToken` — `packages/bodhi-pi/e2e/helpers/auth.ts`
- `HttpAcpConnection` — `packages/bodhi-pi/e2e/helpers/http-connection.ts`
- `createE2EHarness` runtime-sentinel dispatch — `e2e/helpers/harness.ts`

## Verification

End-to-end: zero sibling-package imports; three projects green; check clean; just test green.
