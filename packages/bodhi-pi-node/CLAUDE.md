# bodhi-pi-node

Publishable Node adapters for `@bodhiapp/bodhi-pi`. ESM library — no UI, no app code. Node hosts (`bodhi-pi-cli`, future server-side host, future Electron main process) consume `npm i @bodhiapp/bodhi-pi @bodhiapp/bodhi-pi-node` and inject the factories below into `createBodhiPiAgent`.

Mirrors `@bodhiapp/bodhi-pi-browser` shape so any host can swap runtimes by changing one import line.

## Architecture pillars

**Pure factories, runtime-bound.** `createNodeFilesystem(rootCwd)` and `createNodeScriptExecutor()` and `createSqliteSessionStore(dbPath)` are independently constructible. No global singletons — each call returns a fresh adapter.

**better-sqlite3 + drizzle for sessions.** Synchronous SQLite + drizzle-orm migrations under `drizzle/`. Migrations are committed to the package and bundled in `files`. Sessions live at `~/.bodhi-pi/sessions.db` by default; CLI overrides via `defaultDbPath("bodhi-pi-cli")`.

**Path jail in `createNodeFilesystem`.** Constructor takes `rootCwd`; every method rejects paths that resolve outside it. This is the host-side safety net for live testing on real working trees. Hosts wanting unrestricted FS access pass `rootCwd: "/"` deliberately.

**Node-spawn `ScriptExecutor`.** `createNodeScriptExecutor()` shells out via `child_process.spawn("node", ...)` with the script body wrapped in an `args = [...]` preamble piped over stdin. Captures stdout/stderr; respects optional timeout via SIGTERM.

**Native binding caveat.** `better-sqlite3` is a node-gyp prebuilt. Lambda/edge bundlers should be aware. Documented in README.

## Key files

| Path | Role |
|---|---|
| `src/index.ts` | Public exports — `createNodeFilesystem`, `createNodeScriptExecutor`, `createSqliteSessionStore`, `defaultDbPath` |
| `src/filesystem/node-filesystem.ts` | Implements bodhi-pi's `Filesystem` over `node:fs/promises` with rootCwd jail |
| `src/sessions/sqlite-session-store.ts` | Implements `SessionStore` over better-sqlite3 + drizzle. `defaultDbPath(appDirName?)` returns `~/.<appDirName>/sessions.db` |
| `src/sessions/schema.ts` | drizzle table defs: `sessions`, `session_entries` (entry stored as JSON in `payload`) |
| `src/sessions/migrate.ts` | `runMigrations(db)` — applies `./drizzle/*.sql` via drizzle's better-sqlite3 migrator |
| `src/script-executor/node-script-executor.ts` | Implements `ScriptExecutor` via `child_process.spawn("node", ...)` |
| `drizzle/` | Generated migration SQL + `meta/_journal.json`. Ships in the published package. |
| `drizzle.config.ts` | drizzle-kit config — schema → `./src/sessions/schema.ts`, out → `./drizzle` |
| `test/node-filesystem.test.ts` | Real tmpdir round-trips for read/write/list/stat/mkdir/remove + ENOENT/EISDIR/jail rejection |
| `test/sqlite-session-store.test.ts` | tmp `.db` round-trips: create/load/append/list/delete cascade + cursor pagination |

## Source code rules

- **ESM only.** `"type": "module"`. `import`/`export`. No `require()`.
- **`@types/node`** is a runtime dep typing-wise — every src file ultimately reaches `node:fs/promises` or `node:child_process`.
- **No DOM types.** Public types reference Node primitives only. `tsconfig.build.json` has `lib: ["ES2022"]` (no DOM).
- **Match `bodhi-pi-browser` shape.** Same factory-naming convention (`createXxxFilesystem`, `createXxxSessionStore`, `createXxxScriptExecutor`) AND same call shape (options object on every factory). Hosts switch runtimes by changing one import line. The one genuine asymmetry is `createNodeScriptExecutor()` reads scripts from disk via `node:fs/promises` while `createBrowserScriptExecutor({filesystem})` requires an injected `Filesystem` because the browser realm has no in-process disk — document this at the factory site, do not paper over it.
- **No silent fallbacks in `createNodeScriptExecutor`.** Missing `node` binary in PATH → throws on first execute. Same posture as bodhi-pi's "no silent defaults" pillar.
- **`defaultDbPath` is parameterized.** `defaultDbPath("bodhi-pi-cli")` returns `~/.bodhi-pi-cli/sessions.db`. Default arg `"bodhi-pi"` keeps the package generically reusable.
- **Migrations are part of the build artifact.** `drizzle/` lives in `files`; consumers don't need drizzle-kit at runtime, only at dev time when schema evolves.
- **No `as` casts in entry-payload deserialization.** Use type guards or zod-style runtime checks if the payload shape grows complex (current shape is small enough for `JSON.parse` + structural assumptions).
- **Test fixtures stay out of the publishable surface.** Helpers that exist solely to support vitest specs (in-memory mocks, fake-fs seeds, fixture generators) belong under `test/`, NOT `src/`. The default barrel (`src/index.ts`) is production-only. No `vitest`/test-only conditional branches in `src/`. Test-only deps stay in `devDependencies`. If a single helper is genuinely dual-purpose (e.g. `runMigrations` runs at production startup AND inside tests), document the dual role with a one-line comment at the export site.

## Test conventions

- **Vitest with real tmpdirs.** `os.tmpdir()` + `mkdtemp` per test; cleanup in `afterEach`. No mocking of fs or sqlite.
- **In-memory SQLite is acceptable** for fast contract tests (`:memory:`). On-disk SQLite proves migration application.
- **Source aliases via vitest config.** `@bodhiapp/bodhi-pi` resolves to `../bodhi-pi/src/index.ts` so tests run against current core source, not built `dist/`.
- **No e2e in this package.** End-to-end coverage lives in `bodhi-pi-cli/e2e/` (real LLM round-trips through the full Node stack). Unit tests here cover adapter contracts in isolation.

## Feature workflow

When `bodhi-pi` ships a new host-injected interface (or extends an existing one), the corresponding adapter lands here:

1. Add the factory under `src/<area>/`.
2. Vitest unit tests in `test/<area>.test.ts` — real tmpdir / real SQLite, cover happy + error + boundary.
3. Add migration via `npm run db:generate` if schema changed; commit `drizzle/*.sql`.
4. Re-export from `src/index.ts`.
5. Bump `bodhi-pi-cli`'s consumer code; add an `e2e/*.e2e.ts` spec proving the feature reaches the LLM through the Node host.

The browser-side equivalent ships in `@bodhiapp/bodhi-pi-browser` — keep both in lockstep.
