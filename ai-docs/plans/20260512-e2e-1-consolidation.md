# Consolidate e2e tests in bodhi-pi across in-memory, CLI, and HTTP runtimes

## Context

`bodhi-pi` exposes a transport-agnostic agent (`createBodhiPiAgent` + `BodhiPiClient` over `BodhiPiAcpConnection`). Today the same agent behavior is asserted three different ways across parallel e2e suites — `bodhi-pi/e2e` (in-process, in-memory), `bodhi-pi-cli/e2e` (in-process, real Node FS + SQLite), `bodhi-pi-http/test/integration` (HTTP+SSE on `/acp`). Drift is silent, cost is duplicated, coverage is unclear.

**Goal.** A single consolidated e2e suite in `packages/bodhi-pi/e2e/shared/` parameterized via [Vitest projects](https://vitest.dev/guide/projects) over three runtimes — **in-memory**, **CLI (stdio)**, **HTTP** — proving uniform agent behavior across every runtime we ship. Each runtime keeps a small **surface-specific** bucket (CLI's tagged-REPL headless mode; HTTP's React UI via Playwright). The CLI and HTTP packages move under `e2e/` as self-contained Node sub-projects, runnable for humans and spawnable as test-apps.

## Working principles

- **Depth-first.** Land one runtime end-to-end before starting the next. No half-finished migrations.
- **Green gate every phase.** Each phase ends with: vitest green for the in-scope project(s), `just test` green at monorepo level, then commit.
- **Retrospective between phases.** Before starting the next runtime, do the refactoring/extraction work the previous phase revealed — generalize the harness, make the client more transport-adaptable, extract reusable helpers. Don't carry untidy code into the next phase.
- **Old packages stay.** `packages/bodhi-pi-cli/` and `packages/bodhi-pi-http/` are NOT deleted. They keep their `src/` (still buildable / runnable) but their e2e tests get migrated/removed as part of consolidation. The new locations under `e2e/test-app-{cli,http}/` are a duplicate copy used as test-apps.
- **One test at a time for runtime-specific buckets.** For `e2e/cli-headless/` and `e2e/http-playwright/`, write one test, get it green, then write the next. No batch-writing.

## Target architecture (end state)

### Three Vitest projects

| Project | Transport | Adapters | What it spawns |
|---|---|---|---|
| `in-memory` | `createInProcessAcpPair` | in-memory FS/sessions/kv | nothing — in-process |
| `cli` | ACP JSON-RPC over real stdio | `bodhi-pi-node` (real FS, SQLite) | `test-app-cli --rpc` (child process) |
| `http` | HTTP POST + SSE on `/acp` | `bodhi-pi-node` (real FS, SQLite) | `test-app-http` server (child on ephemeral port) |

All three glob the same `e2e/shared/**/*.e2e.ts`. The harness factory returns an identical shape regardless of project; tests are project-blind.

### Two runtime-specific buckets

| Bucket | Runs under | Purpose |
|---|---|---|
| `e2e/cli-headless/` | `cli` only | Drives `test-app-cli --headless` (tagged user prompts on stdin, framed `<response>…</response>` on stdout). Proves slash-command UX, rendering. |
| `e2e/http-playwright/` | `http` only | Narrow Playwright over the React UI: provider setup, model selection, basic chat, tool call, slash command, extension. |

### CLI test-app has two non-REPL modes

`test-app-cli/src/cli.ts` keeps default readline REPL and adds:
- `--rpc`: ACP JSON-RPC over real stdio (driven by Vitest `cli` project)
- `--headless`: tagged user-prompt mode (stdin = user lines like `/model gpt-4o-mini`; stdout = `<response>…</response>` blocks)

Recommended frame format is `<response>…</response>` for readability; length-prefixed (`43 …\n`) is an option if multi-line content gets awkward.

### HTTP transport lives in e2e/helpers only

`packages/bodhi-pi/e2e/helpers/http-connection.ts` — Node-runnable `BodhiPiAcpConnection` that POSTs to `/acp` and parses SSE. Logic ports from `packages/bodhi-pi-http/src/frontend/lib/{acp-http-client,sse-parser}.ts`. Not promoted to bodhi-pi core, not a separate package.

### Uniform `WorkspaceSeed` across runtimes

Generalize `packages/bodhi-pi-cli/test/helpers/seed-workspace.ts`:

```ts
interface WorkspaceSeed {
  files?: Record<string, string>;
  commands?: Record<string, string>;
  skills?: Record<string, string>;
  extensions?: Record<string, string>;
}
```

- in-memory: harness pre-seeds via `filesystem.writeTextFile(...)`
- cli: harness writes to tmpdir before spawning
- http: harness writes to server's `--workspace <tmpdir>` override

## Phases

---

### Phase 1 — Migrate `bodhi-pi/e2e` to `e2e/shared/` (in-memory only)

**Scope.** Establish the new directory layout, the Vitest projects scaffolding, and the project-blind harness factory — but configured for `in-memory` only. Move existing bodhi-pi e2e tests into `e2e/shared/` with no behavioral changes. Other runtimes do not exist yet.

**Steps.**
1. Create `packages/bodhi-pi/e2e/shared/`, `e2e/setup/in-memory.ts`, `e2e/helpers/harness.ts`.
2. Rewrite the harness as `createE2EHarness(opts)`. Internally it reads `globalThis.__bodhiPiRuntime` set by `setup/in-memory.ts` and returns today's `createTestHarness` shape.
3. Move each file from `packages/bodhi-pi/e2e/*.e2e.ts` → `packages/bodhi-pi/e2e/shared/*.e2e.ts`. Update imports to the new harness factory.
4. Update `packages/bodhi-pi/vitest.e2e.config.ts` to define a single project: `in-memory`, globbing `e2e/shared/**/*.e2e.ts`.
5. Update `packages/bodhi-pi/package.json` script: `test:e2e` invokes vitest with the projects config.

**Gate.**
- `cd packages/bodhi-pi && npm run test:e2e` green
- `just test` green at repo root
- Commit: `bodhi-pi: migrate e2e to e2e/shared with in-memory project`

**Retrospective.** Did the harness shape generalize cleanly? Are there test files that pulled in setup logic the harness should own? Refactor before Phase 2.

---

### Phase 2 — CLI runtime

**Scope.** Move bodhi-pi-cli into `e2e/test-app-cli/`, migrate its unique tests into `e2e/shared/`, add `--rpc` mode, add `cli` Vitest project, extract a narrow headless bucket.

**Steps.**
1. Copy `packages/bodhi-pi-cli/src/` → `packages/bodhi-pi/e2e/test-app-cli/src/`. Copy its `package.json` (mark `private: true`, keep `bin`, keep scripts). Confirm `cd e2e/test-app-cli && npm run start` opens the REPL.
2. Audit `packages/bodhi-pi-cli/e2e/` against `e2e/shared/`. For each test:
   - Already covered → delete from `bodhi-pi-cli/e2e/`.
   - Adds coverage (e.g. `commands.e2e.ts`'s `available_commands_update` assertion) → port up to `e2e/shared/` and delete the CLI copy.
3. Run `e2e/shared/` under `--project in-memory` to confirm migrated tests still pass.
4. Add `--rpc` mode to `e2e/test-app-cli/src/cli.ts`: branch before readline; wire `createBodhiPiAgent` directly to real stdin/stdout as ACP transport.
5. Add `cli` to `vitest.e2e.config.ts`. Create `e2e/setup/cli.ts` (sets runtime sentinel, points harness at spawned `test-app-cli --rpc`). Extend `createE2EHarness` with the spawn branch (port logic from `packages/bodhi-pi-cli/test/helpers/cli-harness.ts` — tmpdir + SQLite lifecycle + `bodhi-pi-node` adapters).
6. Run `e2e/shared/` under `--project cli`. Fix divergences (likely: workspace seeding paths, env vars, real-FS vs in-memory edge cases).
7. Add `--headless` mode to `cli.ts`: reuse REPL but emit `<response>…</response>` framing instead of decorated prompts.
8. Create `e2e/cli-headless/` with 4-6 small tests driving `--headless`:
   - `/model <id>` switches model and confirms in stdout
   - Basic multi-turn chat round-trip
   - Tool-call rendering reaches stdout
   - Slash-command expansion (e.g. `/skill:<name>`)
9. Update `vitest.e2e.config.ts`: `cli` project includes both `e2e/shared/**` and `e2e/cli-headless/**`.
10. Update `justfile` so `just test` runs the new project. Re-run any flaky tests; fix root causes (don't retry-mask).

**Gate.**
- `--project in-memory` green
- `--project cli` green (shared + cli-headless)
- `just test` green
- Commit: `bodhi-pi: migrate cli to e2e/test-app-cli with cli project + headless bucket`

**Retrospective.** What did the spawn path force into the harness? Extract those into named helpers. Is `BodhiPiClient` doing transport-aware things it shouldn't? Push transport concerns down. Generalize `WorkspaceSeed` further if needed. **Old `packages/bodhi-pi-cli/` still exists** — its tests are gone (or moved), its `src/` is duplicated under `e2e/test-app-cli/`. We leave the old package directory in place until Phase 4.

---

### Phase 3 — HTTP runtime

**Scope.** Same pattern as Phase 2, against bodhi-pi-http.

**Steps.**
1. Copy `packages/bodhi-pi-http/src/` (server + frontend) → `packages/bodhi-pi/e2e/test-app-http/src/`. Copy `package.json` (private, retain `npm run dev` / `npm start`). Confirm `cd e2e/test-app-http && npm run dev` boots both server and frontend.
2. Create `e2e/helpers/http-connection.ts` — Node `BodhiPiAcpConnection` over HTTP+SSE. Port from `bodhi-pi-http/src/frontend/lib/{acp-http-client,sse-parser}.ts`.
3. Create `e2e/helpers/auth.ts` — `mintTestToken({id, email})` mirroring `bodhi-pi-http/src/server/auth/token.ts` (base64url JSON, no signature).
4. Audit `packages/bodhi-pi-http/test/integration/`. Tests that prove agent behavior already covered by `e2e/shared/` → delete. Tests that prove HTTP-specific contracts (auth required, cancel-on-disconnect, multi-prompt history persistence) → consider porting up to shared OR keeping as `e2e/http-playwright/` if they need the React surface. Per user direction, the kept HTTP-only surface is the Playwright tests (provider setup, set model, chat, tool call, slash command, extension). Most integration tests get deleted.
5. Add `http` to `vitest.e2e.config.ts`. Create `e2e/setup/http.ts` (sets sentinel, points harness at spawned `test-app-http` server on ephemeral port). Extend `createE2EHarness` with the HTTP-spawn branch (port `startTestServer` logic).
6. Run `e2e/shared/` under `--project http`. Fix divergences (likely: auth header injection, SSE framing edge cases, server boot timing).
7. Port narrowed Playwright tests from `packages/bodhi-pi-http/e2e/playwright/` → `packages/bodhi-pi/e2e/http-playwright/`. Keep only: add provider, set model, basic chat, tool call, slash command, extension.
8. Update `vitest.e2e.config.ts`: `http` project includes `e2e/shared/**` and `e2e/http-playwright/**`. Note Playwright config lives in `e2e/test-app-http/` (not in bodhi-pi core devDeps).
9. Update `justfile` to include the new project. Re-run flaky tests; fix root causes.

**Gate.**
- `--project in-memory` green
- `--project cli` green
- `--project http` green (shared + http-playwright)
- `just test` green
- Commit: `bodhi-pi: migrate http to e2e/test-app-http with http project + playwright bucket`

**Retrospective.** What surprised us about HTTP that the harness now hides cleanly? Are there three near-identical spawn helpers that should collapse to one? Is `createE2EHarness` getting too branchy — should each runtime have a thin runtime-specific factory called by the shared factory? Refactor before deletion.

---

### Phase 4 — DELETED (do not delete old packages)

Per user direction, `packages/bodhi-pi-cli/` and `packages/bodhi-pi-http/` are kept. They retain their `src/` (still publishable/runnable) but their e2e suites are consolidated into bodhi-pi. The new `e2e/test-app-{cli,http}/` are duplicate copies used as test-apps for the consolidated e2e.

---

## Critical files

**Created (cumulative across phases):**
- `packages/bodhi-pi/vitest.e2e.config.ts` (rewritten to projects shape)
- `packages/bodhi-pi/e2e/setup/{in-memory,cli,http}.ts`
- `packages/bodhi-pi/e2e/helpers/harness.ts` (project-blind factory)
- `packages/bodhi-pi/e2e/helpers/http-connection.ts`
- `packages/bodhi-pi/e2e/helpers/auth.ts`
- `packages/bodhi-pi/e2e/helpers/seed-workspace.ts`
- `packages/bodhi-pi/e2e/shared/**/*.e2e.ts`
- `packages/bodhi-pi/e2e/cli-headless/**/*.e2e.ts`
- `packages/bodhi-pi/e2e/http-playwright/**/*.e2e.ts`
- `packages/bodhi-pi/e2e/test-app-cli/**` (relocated, own package.json with bin)
- `packages/bodhi-pi/e2e/test-app-http/**` (relocated, own package.json)

**Modified:**
- `packages/bodhi-pi/e2e/test-app-cli/src/cli.ts` — `--rpc` and `--headless` modes
- `packages/bodhi-pi/package.json` — devDep `bodhi-pi-node`; `test:e2e` script
- Root `package.json` workspaces
- `justfile` — recipes for new project(s) and removed package paths

**Not deleted (kept as parallel packages):**
- `packages/bodhi-pi-cli/` — kept as-is; its e2e suite gets consolidated into bodhi-pi during Phase 2 but `src/` and `package.json` remain
- `packages/bodhi-pi-http/` — same treatment in Phase 3

## Reused functions/utilities

- `createTestHarness` — `packages/bodhi-pi/test/helpers/harness.ts` (in-memory wiring)
- `createCliTestHarness` — `packages/bodhi-pi-cli/test/helpers/cli-harness.ts` (tmpdir + SQLite; adapt for spawn)
- `seedWorkspace` + `WorkspaceSeed` — `packages/bodhi-pi-cli/test/helpers/seed-workspace.ts`
- `startTestServer` — `packages/bodhi-pi-http/test/helpers/test-server.ts`
- `AcpHttpClient` + `sse-parser` — `packages/bodhi-pi-http/src/frontend/lib/`
- `encodeToken` — `packages/bodhi-pi-http/src/server/auth/token.ts`
- `bodhi-pi-node` factories — `createNodeFilesystem`, `createSqliteSessionStore`, `createNodeScriptExecutor`, `createNodeKvStore`, `createNodeExtensionLoader` (stays as a published package; not moved into e2e)

## Verification (end-state, after Phase 4)

1. `cd packages/bodhi-pi && npm run test:e2e` — all three projects green; each `e2e/shared/*.e2e.ts` ran three times.
2. `npm run test:e2e -- --project <in-memory|cli|http>` — each project runs in isolation.
3. `cd e2e/test-app-cli && npm run start` — interactive REPL still works.
4. `node e2e/test-app-cli/dist/cli.js --rpc` — accepts an ACP `initialize` frame, returns valid response.
5. `node e2e/test-app-cli/dist/cli.js --headless` — piped user prompts produce `<response>…</response>` blocks.
6. `cd e2e/test-app-http && npm run dev` — server + frontend boot; manual chat works.
7. `--project http` Playwright suite green against freshly-spawned server.
8. `just test` green at monorepo root.
9. `grep -r "bodhi-pi-cli\|bodhi-pi-http" packages/ ai-docs/` shows only intentional historical mentions.
10. OpenAI cost spot-check: full suite ≈ 3× single-runtime cost on gpt-4o-mini, within expectation.

## Open items deferred to implementation

- **Headless framing format**: tags vs length-prefixed — decide during Phase 2 Step 7.
- **Harness adapter injection**: `globalThis.__bodhiPiRuntime` sentinel works; reconsider `provide`/`inject` if typing improves.
- **HTTP project port allocation**: per-test port-0 vs per-suite shared — default per-test for isolation.
- **Playwright dependency placement**: scoped to `e2e/test-app-http/package.json` (preferred) vs bodhi-pi devDeps.
- **`just test` content**: inspect at Phase 1 Step 5 to know exactly what the monorepo gate runs.
