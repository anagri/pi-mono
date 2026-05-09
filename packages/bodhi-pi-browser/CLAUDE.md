# bodhi-pi-browser

Publishable browser adapters for `@bodhiapp/bodhi-pi`. ESM-only library — no React, no UI, no app code. Browser hosts (`bodhi-pi-web`, future Chrome extension, future Electron renderer) consume `npm i @bodhiapp/bodhi-pi @bodhiapp/bodhi-pi-browser` and inject the factories below into `createBodhiPiAgent`.

Mirrors `@bodhiapp/bodhi-pi-node` shape so any host can swap runtimes by changing one import line.

## Architecture pillars

**Pure factories, no singletons across factories.** Each `createX(opts)` returns a fresh adapter scoped to its own state. Dexie/ZenFS internally hit a process-global handle, but that's an implementation detail — callers see N independent factories.

**Bundler module resolution.** `tsconfig.build.json` uses `module: "ESNext", moduleResolution: "Bundler"` so Dexie's conditional `production`/`development`/`default` exports resolve correctly under tsgo. Subclassing `Dexie` trips tsgo's class-extension typing — we use composition (`openBodhiPiBrowserDb` returns `{ db, sessions, entries }`).

**ZenFS state is realm-global.** `configure({ mounts: {} })` runs once per worker/tab; subsequent `mount(path, backend)` calls add per-volume mounts. We use `/mnt/<name>` as the canonical path convention (matches `BodhiSearch/web-acp`'s pattern).

**No DOM-only types in interfaces.** Public types use `FileSystemDirectoryHandle` (DOM lib), `MessagePort` (DOM lib) — fine for browser consumers, irrelevant for tests because vitest's Node environment imports `MessageChannel` from `node:worker_threads` and casts.

**FSA handles structured-clone for free.** Storing in IndexedDB via `idb-keyval` works without serialization. Posting to a worker via `postMessage(init, [port])` works. We do NOT need separate transferable handling.

## Key files

| Path | Role |
|---|---|
| `src/index.ts` | Public exports barrel — every factory + every type |
| `src/transport/message-port-stream.ts` | `createMessagePortStream(port)` — wraps `MessagePort` into `{readable, writable}` `Uint8Array` streams for ACP SDK's `ndJsonStream` |
| `src/sessions/db.ts` | `openBodhiPiBrowserDb(dbName)` — Dexie schema v1: `sessions: '&id, cwd, updatedAt'` + `entries: '++pk, sessionId, [sessionId+seq]'` |
| `src/sessions/dexie-session-store.ts` | `createDexieSessionStore({ dbName? })` — implements bodhi-pi's `SessionStore` over IndexedDB |
| `src/filesystem/zenfs-mount.ts` | `mountFsaHandle({ handle, mountName })` (production) + `mountInMemorySeed({ mountName, files })` (tests). Each mounts at `/mnt/<mountName>`. Returns `{ rootPath }`. |
| `src/filesystem/zenfs-filesystem.ts` | `createZenfsFilesystem()` — implements bodhi-pi's `Filesystem` by delegating to ZenFS's `fs.promises` (Node-fs-shaped) |
| `src/filesystem/fsa-handle-store.ts` | `loadHandle` / `saveHandle` / `clearHandle` (idb-keyval) + `queryPermission` / `requestPermission` wrappers around the FSA handle's non-spec methods |
| `src/script-executor/browser-script-executor.ts` | `createBrowserScriptExecutor({ filesystem })` — wraps script body in `AsyncFunction("args","cwd","console", code)`. console.log/info → stdout; console.error/warn → stderr; thrown error → exitCode=1; `Promise.race` timeout |

## Source code rules

- **ESM only.** `"type": "module"`. No `require()`. No CJS adapters.
- **No `node:*` imports.** Browser-target only. The package is consumed by Vite/Rollup/esbuild — `@types/node` is in devDeps for tsgo's typing of `MessagePort` via `node:worker_threads` in tests, but src never imports from `node:*`.
- **Public API stays thin.** Factories + minimal options. No classes exported beyond Dexie's own `Table` typings (re-exported via the schema).
- **Match `bodhi-pi-node` shape.** Same factory naming convention (`createXxxFilesystem`, `createXxxSessionStore`, `createXxxScriptExecutor`). Hosts switch runtimes by changing one import line.
- **No singletons across factories.** Each factory returns a fresh adapter, holding its own internal state. `mountFsaHandle` is the one exception — ZenFS's mount table is realm-global by design.
- **`requestPermission` requires a user gesture.** Document this on the helper. The browser host (e.g. `bodhi-pi-web/DirectoryGate.tsx`) is responsible for invoking from a click handler. We do NOT call `requestPermission` after `showDirectoryPicker({mode:"readwrite"})` — the picker dialog already grants the requested mode and consumes the activation.
- **AsyncFunction-based executor needs `unsafe-eval` CSP.** Document for prod consumers. No nested-Worker fallback in v1.
- **Compose, don't subclass `Dexie`.** tsgo's class-extension resolution against Dexie's `var Dexie: DexieConstructor` typing breaks. `openBodhiPiBrowserDb` returns `{ db, sessions, entries }` — see `db.ts`.
- **Test fixtures stay out of the publishable surface.** Helpers that exist solely to support vitest/Playwright (in-memory seeds, mocks, fixture generators) live under `src/_test-helpers/` and ship via a dedicated `exports["./test-helpers"]` entry, NOT from `src/index.ts`. The default barrel is production-only. No `vitest`/`fake-indexeddb`/test-only conditional branches in production `src/` paths. Test-only deps stay in `devDependencies`. **`mountInMemorySeed` is test-only** and currently leaks via `src/index.ts`; it should move to `_test-helpers/zenfs-seed.ts`.

## Test conventions

- **vitest + `fake-indexeddb/auto`.** Every `*.test.ts` imports the polyfill at the top so Dexie + idb-keyval work in the Node test environment.
- **Reset DBs between tests.** Use `indexedDB.deleteDatabase(dbName)` in `beforeEach`/`afterEach`. fake-indexeddb persists across tests by default.
- **Cast `node:worker_threads` `MessagePort` to DOM `MessagePort`.** Their declarations live in different libs but the runtime API is compatible for our usage. See `src/transport/message-port-stream.test.ts`.
- **No e2e in this package.** End-to-end coverage lives in `bodhi-pi-web/e2e/`. Unit tests here cover adapter contracts in isolation.
- **Each test seeds its own ZenFS mount with a unique `mountName`.** ZenFS keeps a process-global mount table; reusing names across tests in the same vitest run causes "already mounted" errors.

## Feature workflow

When `bodhi-pi` ships a new host-injected interface (or extends an existing one), the corresponding adapter lands here:

1. Add the factory in `src/<area>/`.
2. Vitest unit tests in `src/<area>/*.test.ts` — happy path + error paths + boundary conditions, against in-memory backends only (no real FSA picker, no real network).
3. Re-export from `src/index.ts`.
4. Bump `bodhi-pi-web`'s consumer code; add a Playwright spec in `bodhi-pi-web/e2e/` proving the feature reaches the LLM.

The Node-side equivalent ships in `@bodhiapp/bodhi-pi-node` — keep both in lockstep.
