# Plan — implement the 2026-05-09 reviews

## Context

Three review reports (`ai-docs/reviews/2026-05-09-{bodhi-pi-core,bodhi-pi-cli-node,bodhi-pi-browser-web}.md`) and an index (`2026-05-09-index.md`) catalogue ~44 verified, file:line-cited findings across the five-package matrix after the `b523427a..50d41369` window (M5.1 + M5.2 + the cli-parity wave). The user has approved the reviews and asked for an implementation plan covering **all 17 suggested commits**, landed **phase-wise with gate-check tests** between phases.

The plan honours four architectural decisions captured during this planning round:

1. **Interface ownership** — `bodhi-pi` defines the host-injected interfaces (`Filesystem`, `SessionStore`, `ScriptExecutor`). `bodhi-pi-{browser,node}` provide the **production** adapter implementations only. `bodhi-pi-{web,cli}` own anything required by e2e. Test fixtures belong with the host that consumes them, never in the publishable adapter packages.
2. **No test concerns in production interfaces** — the `WorkspaceProvider` interface in `bodhi-pi-web` does not carry an `isTest` flag. `recordEvents` is an independent observability toggle; tests opt in explicitly via `InitMessage`.
3. **`mountInMemorySeed` is deleted** from `@bodhiapp/bodhi-pi-browser`. Its in-memory ZenFS mount logic moves into `bodhi-pi-web`'s new `seedWorkspaceProvider` (which takes a direct dep on `@zenfs/core`).
4. **CLI fixtures are real files**, one scenario per spec, under `packages/bodhi-pi-cli/test/fixtures/<scenario>/`. Same fixture tree feeds both reference hosts.

CLAUDE.md rules for these patterns are already in place (added during the review pass) — the code below moves the implementation toward those rules.

---

## Phase 1 — Core correctness + adapter contract bugs

Goal: stop the bleeding. Land every finding that's a real bug or breaks a stated contract.

### 1.1 — bodhi-pi core / Batch A
- `packages/bodhi-pi/src/extensions/runner.ts:147-156` — make `resolveProviderKey` async; `await cfg.getApiKey(provider)` then check the resolved value. Fixes the silent drop of every provider after the first async one.
- `packages/bodhi-pi/src/tools/walk.ts:38-46` — guard the `try/catch` with `if (dir !== rootAbsolute) continue;` so a missing root throws instead of returning empty.

### 1.2 — bodhi-pi core / Batches B + D
- `packages/bodhi-pi/src/_internal/sort.ts` (new) — extract `byName` comparator; reuse in `commands/discovery.ts:72` and `skills/discovery.ts:73`.
- `packages/bodhi-pi/src/acp/agent.ts:388-573` — extract the `session.piAgent.subscribe` callback into a private `subscribeToAgent(...)` method returning the unsubscribe handle.
- `packages/bodhi-pi/src/extensions/runner.ts:50-55` — capture per-extension factory failures into a `runner.errors[]` field; expose via `getExtensionErrors()` accessor.
- `packages/bodhi-pi/src/extensions/runner.ts:21-27` — fix the misleading "builtins always win" JSDoc to describe both rules (tools: builtins win; commands: project wins).
- `packages/bodhi-pi/src/_internal/frontmatter.ts:5-15` — document the YAML-null/array coercion in the JSDoc.
- `packages/bodhi-pi/src/acp/agent.ts:188-191` — add `extensions: { tools: true, commands: true, providers: true, events: true }` under `_meta["bodhi-pi"]`.

### 1.3 — bodhi-pi-node / Batches A + B + C
- `packages/bodhi-pi-node/src/extensions/node-extension-loader.ts:18, 42` — drop `.ts`/`.tsx` from `SUPPORTED`; replace `jiti` with `await import(pathToFileURL(filePath).href)`. Remove `jiti` from `package.json` deps.
- `packages/bodhi-pi-node/src/sessions/sqlite-session-store.ts:54, 161` — introduce `parseSessionEntry`/`parseExtensionEntry` guards; replace both `as` casts.
- `packages/bodhi-pi-node/src/sessions/sqlite-session-store.ts:94-101` — validate cursor shape (`typeof updatedAt === "number" && typeof id === "string"`); fall back to `undefined` on mismatch.
- `packages/bodhi-pi-node/src/sessions/schema.ts:11` — widen index to `(cwd, updatedAt, id)`; regenerate the drizzle migration via `npm run db:generate`. Commit the new SQL.
- `packages/bodhi-pi-node/src/script-executor/node-script-executor.ts:18, 38-48` — add `child.on("error", ...)` and `child.stdin.on("error", () => {})`; convert spawn/EPIPE failures into `{stdout, stderr, exitCode: 1}` results.

### 1.4 — bodhi-pi-browser / Batches A + B + C
- `packages/bodhi-pi-browser/src/script-executor/browser-script-executor.ts:64` — fix cwd derivation: `const slash = scriptPath.lastIndexOf("/"); const cwd = slash >= 0 ? scriptPath.slice(0, slash) : "/";`.
- `packages/bodhi-pi-browser/src/sessions/dexie-session-store.ts:51-59` — use `entries.where({sessionId}).reverse().limit(1).first()` (or persist `lastSeq` on the row) inside the `db.transaction("rw")` to avoid concurrent-append seq corruption.
- `packages/bodhi-pi-browser/src/sessions/dexie-session-store.ts:61-80` — implement cursor-aware pagination (mirror Node base64url `{updatedAt, id}` shape); compute `messageCount` via Dexie `where("[sessionId+entry.type]").equals([id, "message"]).count()` (or maintain `messageCount` on the `sessions` row).
- `packages/bodhi-pi-browser/src/filesystem/zenfs-mount.ts:36-56` — reject seed paths that escape `rootPath` (`if (!resolvedAbs.startsWith(rootPath + "/")) throw …`). Note: this file goes away in Phase 4 (Batch G); land the guard now anyway because Phase 4 lands later and unsafe paths could land via web tests in the meantime.
- `packages/bodhi-pi-browser/src/extensions/browser-extension-loader.ts:66-70` — replace the loop with `Array.from(bytes, b => String.fromCharCode(b)).join("")` and rewrite the misleading comment.

### 1.5 — bodhi-pi-web / Batch A
- `packages/bodhi-pi-web/src/agent/worker.ts:39-57` — add `message_update: [post]` and `tool_execution_update: [post]` to `recordingHandlers()`; extend `WorkerEventMessage["record"]` with the delta payloads.
- `packages/bodhi-pi-web/src/agent/worker.ts:80` — collapse the dead ternary to `const cwd = \`/mnt/${workspace.mountName}\`;` (Phase 3 collapses it further to `workspace.rootPath`).
- `packages/bodhi-pi-web/src/ui/RuntimeProvider.tsx:139-140` — replace the `eslint-disable` with the explanatory one-line comment.

### Gate-check tests for Phase 1

```bash
# All four adapter/core packages have working unit + integration suites.
npm run -w @bodhiapp/bodhi-pi test
npm run -w @bodhiapp/bodhi-pi-node test
npm run -w @bodhiapp/bodhi-pi-browser test
npm run -w bodhi-pi-cli test           # integration tests; no real LLM
# E2E (real LLM) — gates production-correctness fixes.
npm run -w bodhi-pi-cli e2e
npm run -w bodhi-pi-web test            # Playwright; gates the worker event-handler additions.
```

Add a vitest assertion in `bodhi-pi/test/extensions.test.ts` that calls `resolveProviderKey` against two providers where the first returns `Promise.resolve(undefined)` — proves Batch A.1 didn't regress. Add a `bodhi-pi-node/test/sqlite-session-store.test.ts` case that round-trips a malformed cursor (`Buffer.from('{"foo":1}').toString("base64url")`) and asserts the list resets to first page.

---

## Phase 2 — Adapter factory-shape parity (Node ↔ Browser)

Goal: make `bodhi-pi-node` and `bodhi-pi-browser` adapters swappable by changing one import line, as both CLAUDE.mds promise.

### 2.1 — Normalise factory signatures to options objects on both sides
- `packages/bodhi-pi-node/src/index.ts` and the underlying impl files:
  - `createNodeFilesystem(rootCwd: string)` → `createNodeFilesystem({ rootCwd: string })`
  - `createSqliteSessionStore(dbPath: string)` → `createSqliteSessionStore({ dbPath: string })`
  - `createNodeScriptExecutor()` stays zero-arg (no parity counterpart needs args here)
- `packages/bodhi-pi-browser/src/index.ts`:
  - `createZenfsFilesystem()` accepts an optional empty options object: `createZenfsFilesystem(opts?: {})` (no behaviour change, just shape parity)
  - `createDexieSessionStore({dbName?})` already options-shaped — keep as-is.
  - `createBrowserScriptExecutor({filesystem})` already options-shaped — keep as-is.
- Update every consumer:
  - `packages/bodhi-pi-cli/src/agent.ts:32-40` — change call sites to options-object form.
  - `packages/bodhi-pi-cli/test/helpers/cli-harness.ts:31-39` — mirror.
  - `packages/bodhi-pi-web/src/agent/worker.ts:74-76` — already options-shaped where browser side is; verify.

### 2.2 — Document the one genuine asymmetry
- `packages/bodhi-pi-node/CLAUDE.md` and `packages/bodhi-pi-browser/CLAUDE.md` — add a one-line note under "Source code rules": the Node script executor reads scripts from disk via `node:fs/promises`; the browser one needs an injected `Filesystem` because there is no in-process disk.

### Gate-check tests for Phase 2

```bash
npm run -w @bodhiapp/bodhi-pi-node test
npm run -w @bodhiapp/bodhi-pi-browser test
npm run -w bodhi-pi-cli test
npm run -w bodhi-pi-cli e2e
npm run -w bodhi-pi-web test
```

Add one vitest case in `bodhi-pi-node/test/node-filesystem.test.ts` that confirms the new options-object signature is the only public form (the positional form should be removed, not aliased — a deprecated alias keeps the parity violation alive).

---

## Phase 3 — bodhi-pi-web `WorkspaceProvider` encapsulation

Goal: collapse the `WorkspaceConfig` discriminated union and the global `Window` augmentation into a single seam at `bootstrap.ts`. Production interfaces carry no test concerns.

### 3.1 — Define the interface in bodhi-pi-web

New file `packages/bodhi-pi-web/src/workspace/provider.ts`:

```ts
export interface WorkspaceProvider {
  readonly mountName: string;
  readonly rootPath: string;
  /** Mount the underlying filesystem into ZenFS. Called once by the worker. */
  mount(): Promise<void>;
}

export function fsaWorkspaceProvider(opts: {
  handle: FileSystemDirectoryHandle;
  name: string;
}): WorkspaceProvider { /* internally calls mountFsaHandle */ }

export function seedWorkspaceProvider(opts: {
  name: string;
  files: Record<string, string>;
}): WorkspaceProvider { /* internally mounts InMemory ZenFS + writes files */ }
```

Key constraints:
- No `isTest` flag on the interface. Tests that need event recording set `recordEvents` on `InitMessage` directly.
- `seedWorkspaceProvider` does NOT depend on `@bodhiapp/bodhi-pi-browser`'s `mountInMemorySeed` (which gets deleted in Phase 4). It calls `@zenfs/core`'s `mount(...)` and `fs.promises.writeFile(...)` directly.
- `bodhi-pi-web` adds `@zenfs/core` to its `dependencies` (currently it's transitively present via `@bodhiapp/bodhi-pi-browser`).

### 3.2 — Move `Window` augmentation off `types.ts`
- Move the `declare global { interface Window { __bodhiPiWebSeed?...; showDirectoryPicker?... } }` from `packages/bodhi-pi-web/src/workspace/types.ts:30-39` into `packages/bodhi-pi-web/src/workspace/bootstrap.ts` as a file-local ambient declaration.
- After the move, `types.ts` can be deleted (its only remaining content is `WorkspaceConfig`, which goes away below).

### 3.3 — Rewire callers
- `packages/bodhi-pi-web/src/workspace/bootstrap.ts:18, 58, 81` — return `WorkspaceProvider` from all three functions (`bootstrapWorkspace`, `pickAndPersistDirectory`, `reGrantPermission`).
- `packages/bodhi-pi-web/src/agent/types.ts:12` — change `InitMessage.workspace: WorkspaceConfig` to a `WorkspaceData` discriminated record (`{kind:"fsa", handle, name} | {kind:"seed", name, files}`) since closures don't survive `postMessage`. Worker reconstructs a `WorkspaceProvider` from the data.
- `packages/bodhi-pi-web/src/agent/worker.ts:60-103` — at message receipt, build the `WorkspaceProvider` from the `WorkspaceData`, call `await workspace.mount()` once, derive `cwd = workspace.rootPath`, drop the `mode === "fsa"` branch.
- `packages/bodhi-pi-web/src/agent/runtime.ts:32` — accept a `WorkspaceProvider` from the host; serialise to `WorkspaceData` for the `postMessage` boundary; remove the `recordEvents` derivation chain (see 3.4).
- `packages/bodhi-pi-web/src/ui/RuntimeProvider.tsx:32, 70-76` — accept `WorkspaceProvider`; delete the `recordEvents = workspace.mode === "seed"` derivation and the spread.
- `packages/bodhi-pi-web/src/ui/DirectoryGate.tsx:9` — `onGranted: (workspace: WorkspaceProvider) => void`.
- `packages/bodhi-pi-web/src/App.tsx:9, 29` — `handleGranted(workspace: WorkspaceProvider)`.

### 3.4 — Detangle `recordEvents` from workspace mode
Keep `recordEvents?: boolean` on `InitMessage` (it's a worker observability toggle, not a test marker), but stop deriving it from the workspace shape. Two clean options:
- (a) Playwright fixtures explicitly set `recordEvents: true` on their `RuntimeOptions` via the test harness (`e2e/fixtures.ts` + `e2e/helpers/seed.ts` adds the flag when seeding).
- (b) Worker reads a separate `__bodhiPiWebRecordEvents` global set by Playwright `addInitScript`.

Pick (a) — the seed-injection helper that Playwright already uses (`seedWorkspace(page, seed)`) sets both `__bodhiPiWebSeed` AND a `recordEvents: true` field on a tiny `__bodhiPiWebInit` payload, and `bootstrap.ts` reads it. Keeps the Playwright surface contiguous.

Concretely: `bootstrap.ts` returns `{ workspace, recordEvents }` instead of just `{ workspace }`; `recordEvents` flows through `RuntimeOptions` → `InitMessage` → worker without ever crossing the `WorkspaceProvider` interface.

### Gate-check tests for Phase 3

```bash
npm run -w bodhi-pi-web test    # all Playwright specs must pass; events.spec validates recording still works
npm run -w bodhi-pi-web build   # confirms type cleanups didn't break
```

Manual smoke: load `http://localhost:35173/`, mount `e2e/examples/`, send a chat. Verify console has no errors and the chat round-trips.

---

## Phase 4 — Drop `mountInMemorySeed` from the publishable surface

Goal: `@bodhiapp/bodhi-pi-browser` exposes only production adapters. Test fixtures live in the consuming host.

### 4.1 — Delete from bodhi-pi-browser
- `packages/bodhi-pi-browser/src/filesystem/zenfs-mount.ts` — delete `mountInMemorySeed`, `SeedFiles` type. Keep `mountFsaHandle`, `unmountAt`, `ensureZenfs`. The `MountResult` type also stays (used by `mountFsaHandle`).
- `packages/bodhi-pi-browser/src/index.ts:14-20` — drop the `mountInMemorySeed` and `SeedFiles` re-exports. Re-export only `mountFsaHandle`, `unmountAt`, `MountResult`.
- `packages/bodhi-pi-browser/CLAUDE.md` — strike the existing `mountInMemorySeed` reference from the key-files table; the "test fixtures stay out of the publishable surface" rule already lands the principle.
- Search the workspace: only `bodhi-pi-web` and `bodhi-pi-browser`'s own tests should reference `mountInMemorySeed` after this point. Any third-party consumer is impossible (none exist; package is private workspace-only at v0.0.x).

### 4.2 — Inline the in-memory seed into bodhi-pi-web's `seedWorkspaceProvider`
- `packages/bodhi-pi-web/src/workspace/provider.ts` — `seedWorkspaceProvider`'s `mount()` body:
  ```ts
  await ensureZenfs();              // local helper, mirrors what was in bodhi-pi-browser
  const rootPath = `/mnt/${name}`;
  mount(rootPath, InMemory.create({ label: name }));
  for (const rel of Object.keys(files).sort()) {
    const abs = rel.startsWith("/") ? `${rootPath}${rel}` : `${rootPath}/${rel}`;
    if (abs.includes("/../") || !abs.startsWith(rootPath + "/")) {
      throw new Error(`unsafe seed path: ${rel}`);
    }
    const slash = abs.lastIndexOf("/");
    if (slash > rootPath.length) {
      try { await fs.promises.mkdir(abs.slice(0, slash), { recursive: true }); }
      catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
    }
    await fs.promises.writeFile(abs, files[rel] ?? "", { encoding: "utf-8" });
  }
  ```
- `bodhi-pi-web/package.json` — add `@zenfs/core` to `dependencies` (currently transitive). `ensureZenfs()` is a small local helper module that calls `configure({mounts:{}})` once per worker realm.
- `bodhi-pi-browser`'s tests for `mountInMemorySeed` move under `bodhi-pi-web/src/workspace/provider.test.ts` (vitest in the web package — one new test file). Browser-side tests for `mountFsaHandle` stay where they are.

### 4.3 — Update `bodhi-pi-browser/src/filesystem/zenfs-filesystem.test.ts`
The test currently uses `mountInMemorySeed` to set up a ZenFS volume. Replace with a minimal inline mount via `@zenfs/core`'s `mount(path, InMemory.create(...))` — same primitives, just inlined inside the test file (not the public surface).

### Gate-check tests for Phase 4

```bash
npm run -w @bodhiapp/bodhi-pi-browser build    # confirms public surface compiles without mountInMemorySeed
npm run -w @bodhiapp/bodhi-pi-browser test
npm run -w bodhi-pi-web test                   # Playwright; seed path must still work via the new provider
```

Verification: `grep -r "mountInMemorySeed\|SeedFiles" packages/` returns hits ONLY in `bodhi-pi-web` and (transitionally during the commit) the `bodhi-pi-browser/src/filesystem/zenfs-mount.ts` deletion diff.

---

## Phase 5 — Test architecture cleanups + fixture-tree migration

Goal: tests stop drifting from the source of truth. Same fixture bytes feed both reference hosts.

### 5.1 — Test architecture (Batch D items across all three reports)
- `packages/bodhi-pi-cli/test/agent.test.ts:41-57` — delete the local `wireHarness`; call `createCliTestHarness({ ..., getApiKey: () => "test-key" })`.
- `packages/bodhi-pi-cli/e2e/events.e2e.ts:13-28` — replace the inline 11-handler map with `const { log, handlers } = recorder();` from the existing `test/helpers/event-recorder.ts:33`. Add narrowed assertions for the previously-omitted event types.
- `packages/bodhi-pi-cli/e2e/sessions.e2e.ts:31-33` — drop the line-33 echo assertion.
- `packages/bodhi-pi-node/test/sqlite-session-store.test.ts:68` — replace the 2 ms `setTimeout` with a poll on `store.load(id).updatedAt`.
- `packages/bodhi-pi/test/chat.test.ts:409, 473` — replace the timer fudges with event-driven cancellation and an `updatedAt` poll.
- `packages/bodhi-pi/test/events.test.ts:70-95` and `packages/bodhi-pi/e2e/events.e2e.ts:18-41` — extract the `recorder()` to `packages/bodhi-pi/test/helpers/event-recorder.ts`; reuse from both. Add the missing `message_update` and `tool_execution_update` assertions.
- `packages/bodhi-pi/src/tools/run-script.test.ts:45, 56, 65, 75` — add `expectTextContent(result)` helper in `test/helpers/`; replace the four `as { text: string }` casts.
- `packages/bodhi-pi-browser/src/sessions/_test-helpers/reset-db.ts` (new) — extract the duplicated `reset(dbName)` from `dexie-session-store.test.ts:7-14` and `dexie-extension-entry.test.ts`.
- `packages/bodhi-pi-browser/src/script-executor/browser-script-executor.test.ts` — add a `console.warn`/`console.error` routing test.
- `packages/bodhi-pi-browser/src/transport/message-port-stream.test.ts` — add a `port.close()` mid-stream test.
- `packages/bodhi-pi-browser/src/sessions/dexie-session-store.test.ts` — add a paginate-50-of-120 test now that Phase 1.4 added cursor support.

### 5.2 — Web-side e2e Batch E follow-ons
- `packages/bodhi-pi-web/e2e/events.spec.ts` — extend assertions to cover all 19 events post-A.1.
- `packages/bodhi-pi-web/e2e/chat.spec.ts` — add a "streams text in chunks before idle" assertion (counts `message_update` events or observes DOM updates while `status === "streaming"`).

### 5.3 — Fixture-tree migration (cli-node Batch E + browser-web D.1 collapse)

Land the fixture tree under `packages/bodhi-pi-cli/test/fixtures/`, granular layout (one scenario per spec):

```
packages/bodhi-pi-cli/test/fixtures/
├── commands-echo/.bodhi-pi/commands/echo.md
├── commands-say-tuesday/.bodhi-pi/commands/say-tuesday.md
├── commands-multi/.bodhi-pi/commands/{echo.md, say-tuesday.md}
├── commands-write-file/.bodhi-pi/commands/write-file.md
├── skills-say-hello/.bodhi-pi/skills/say-hello/SKILL.md
├── skills-days-since-birthday/.bodhi-pi/skills/days-since-birthday/{SKILL.md, script.js}
├── extensions-redact-secrets/.bodhi-pi/extensions/redact-secrets.js
├── extensions-dynamic-tools/.bodhi-pi/extensions/dynamic-tools.js
└── extensions-pirate/.bodhi-pi/extensions/pirate.js
```

Harness change in `packages/bodhi-pi-cli/test/helpers/cli-harness.ts`:
- Add `fixtureDir?: string` to `CliTestHarnessOptions`.
- When `fixtureDir` is provided, use it as `cwd` and ensure `dbPath` always lives under `os.tmpdir()` (never inside the fixture tree). When absent, behave as today (tmpdir for both).
- Document in JSDoc: fixtures are read-only — never mutate them.

Per-spec migration:
- `packages/bodhi-pi-cli/e2e/commands.e2e.ts` — drop `seedWorkspace(... templates.commands.*)`; pass `fixtureDir: path.resolve(__dirname, "../test/fixtures/commands-<scenario>")`.
- `packages/bodhi-pi-cli/e2e/skills.e2e.ts` — same for skills scenarios.
- `packages/bodhi-pi-cli/e2e/scripted-skill.e2e.ts` — fixture body uses a `{SCRIPT_PATH}` placeholder; spec reads the SKILL.md, substitutes the resolved absolute path, and writes the interpolated copy into the harness tmpdir (the one dynamic case).
- `packages/bodhi-pi-cli/e2e/extensions.e2e.ts` — same for extension scenarios.
- `packages/bodhi-pi-cli/e2e/tool-failure.e2e.ts`, `tool-replay.e2e.ts` — audit; migrate any `templates.*` references.

Collapse `seed-workspace.ts`:
- Delete the `templates` constant (real files now own the source of truth).
- Keep `seedWorkspace(cwd, files)` as a thin `mkdir -p + writeFile` loop — used only by `scripted-skill.e2e.ts` to write the interpolated SKILL.md into the tmpdir.
- Add a `loadFixture(name)` reader for the static cases that need to read fixture bytes for assertion purposes.

Web-side convergence (resolves browser-web D.1):
- `packages/bodhi-pi-web/e2e/commands.spec.ts`, `skills.spec.ts`, `extensions.spec.ts` — replace inlined template constants with `fs.readFileSync(path.resolve(__dirname, "../../bodhi-pi-cli/test/fixtures/<scenario>/.bodhi-pi/.../FILE"), "utf8")`. Pass the bytes to `__bodhiPiWebSeed` (or `seedWorkspaceProvider`'s `files` arg post-Phase 3).

### Gate-check tests for Phase 5

```bash
npm run -w @bodhiapp/bodhi-pi test
npm run -w @bodhiapp/bodhi-pi-node test
npm run -w @bodhiapp/bodhi-pi-browser test
npm run -w bodhi-pi-cli test
npm run -w bodhi-pi-cli e2e
npm run -w bodhi-pi-web test
```

After Phase 5: `grep -r "templates\." packages/bodhi-pi-cli/e2e packages/bodhi-pi-web/e2e` should return only the `seed-workspace.ts` definition (if it survives) and zero usage hits — every spec reads from fixtures.

---

## Critical files (consolidated)

**Edited every phase:**
- `packages/bodhi-pi/src/{acp/agent,extensions/runner,_internal/frontmatter,tools/walk}.ts`
- `packages/bodhi-pi/src/{commands/discovery,skills/discovery}.ts` (Phase 1.2 sort dedup)
- `packages/bodhi-pi-node/src/extensions/node-extension-loader.ts`
- `packages/bodhi-pi-node/src/sessions/{sqlite-session-store,schema}.ts`
- `packages/bodhi-pi-node/src/script-executor/node-script-executor.ts`
- `packages/bodhi-pi-browser/src/{filesystem/zenfs-{mount,filesystem},extensions/browser-extension-loader,script-executor/browser-script-executor,sessions/{dexie-session-store,db}}.ts`
- `packages/bodhi-pi-browser/src/index.ts` (Phase 4 surface drop)
- `packages/bodhi-pi-web/src/agent/{worker,runtime,types}.ts`
- `packages/bodhi-pi-web/src/ui/{RuntimeProvider,DirectoryGate}.tsx`
- `packages/bodhi-pi-web/src/App.tsx`
- `packages/bodhi-pi-web/src/workspace/{bootstrap,types}.ts` and new `provider.ts`
- `packages/bodhi-pi-cli/src/agent.ts` (Phase 2 factory shape)
- `packages/bodhi-pi-cli/test/helpers/cli-harness.ts` (Phase 5 fixtureDir)
- `packages/bodhi-pi-cli/test/agent.test.ts` (Phase 5 wireHarness drop)
- `packages/bodhi-pi-cli/test/helpers/seed-workspace.ts` (Phase 5 collapse)
- All `packages/bodhi-pi-cli/e2e/*.e2e.ts` (Phase 5 fixture migration)
- All `packages/bodhi-pi-web/e2e/{commands,skills,extensions}.spec.ts` (Phase 5 convergence)

**Existing helpers to reuse:**
- `packages/bodhi-pi-cli/test/helpers/event-recorder.ts` — already exports `recorder()` over the full 19-event list. Phase 5.1 just migrates `events.e2e.ts` onto it.
- `packages/bodhi-pi/test/helpers/harness.ts` — `createTestHarness(...)`. No change.
- `packages/bodhi-pi-cli/test/helpers/in-process-connection.ts` — `createInProcessAcpPair`. No change.
- `packages/bodhi-pi-node/src/sessions/migrate.ts` — `runMigrations(db)`. Phase 1.3 regenerates the migration SQL; the runner code is untouched.

**New files:**
- `packages/bodhi-pi/src/_internal/sort.ts`
- `packages/bodhi-pi/test/helpers/event-recorder.ts`
- `packages/bodhi-pi-web/src/workspace/provider.ts` and a tiny `ensureZenfs.ts` (or fold into `provider.ts`)
- `packages/bodhi-pi-browser/src/sessions/_test-helpers/reset-db.ts`
- `packages/bodhi-pi-cli/test/fixtures/<scenario>/.bodhi-pi/...` (≈9 scenario directories)
- `packages/bodhi-pi-node/drizzle/0001_widen_sessions_index.sql` (or similar — drizzle generates the name)

---

## Verification

End-of-plan acceptance — all of these must pass on the final commit:

```bash
# Per-package unit + integration suites
npm run -w @bodhiapp/bodhi-pi test
npm run -w @bodhiapp/bodhi-pi-node test
npm run -w @bodhiapp/bodhi-pi-browser test
npm run -w bodhi-pi-cli test

# Real-LLM e2e — both reference hosts
npm run -w bodhi-pi-cli e2e
npm run -w bodhi-pi-web test

# Builds + types
npm run -w @bodhiapp/bodhi-pi build
npm run -w @bodhiapp/bodhi-pi-node build
npm run -w @bodhiapp/bodhi-pi-browser build
npm run -w bodhi-pi-cli build
npm run -w bodhi-pi-web build
```

Spot checks (one per phase):

- **Phase 1**: feed two providers to `ExtensionRunner` where the first returns `Promise.resolve(undefined)`; assert the second's key wins. (vitest in `bodhi-pi/test/extensions.test.ts`)
- **Phase 2**: in `bodhi-pi-node/test/`, confirm `createNodeFilesystem("/some/path")` no longer compiles (positional form removed); `createNodeFilesystem({ rootCwd: "/some/path" })` does.
- **Phase 3**: `grep -rn "WorkspaceConfig\|workspace.mode\|__bodhiPiWebSeed" packages/bodhi-pi-web/src` returns hits ONLY in `workspace/bootstrap.ts`.
- **Phase 4**: `grep -rn "mountInMemorySeed\|SeedFiles" packages/bodhi-pi-browser/src` returns zero hits (deleted). The string survives only in `bodhi-pi-web/src/workspace/provider.ts`'s seed implementation.
- **Phase 5**: every cli e2e spec that previously called `seedWorkspace(... templates.*)` now passes `fixtureDir`. The web specs that previously inlined template constants now `fs.readFileSync` from the cli fixture tree. `grep` confirms one source of truth per fixture body.

Manual smoke (after the whole plan lands):

```bash
# CLI: run against a real workspace with extensions
npm run -w bodhi-pi-cli build
node packages/bodhi-pi-cli/dist/cli.js \
  --cwd packages/bodhi-pi-web/e2e/examples \
  --debug-events
# Expect: extensions auto-load, /help shows /close + /delete, debug events stream on stderr.

# Web: dev server, mount the examples workspace, send a chat
npm run -w bodhi-pi-web dev
# Open http://localhost:35173, pick e2e/examples, run a slash command and a skill.
```
