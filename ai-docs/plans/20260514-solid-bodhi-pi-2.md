# bodhi-pi src cleanup — round 2 implementation plan

## Context

Round-1 (`ef1a74f6..91c7103f`) decomposed `acp/agent.ts` into `*Service`
classes + `ModelRegistry` + `CompactionOrchestrator` + free-function
`session-bootstrap`. Round-2 review
(`ai-docs/reviews/2026-05-14-bodhi-pi-src-cleanup-round-2.md`) found 18
reverse edges (domain → `acp/`) and 5 folder cycles surviving the
extraction. Symptoms: every domain service imports `AgentHelpers`,
`SessionState`, and ACP method-name constants from `acp/`; `client/types`
hosts `ProviderAuth` (a kv shape); `core/` is two files with one consumer
each; `acp/agent.ts` is 812 lines.

Cause: round-1 kept ACP-protocol artefacts inside `acp/` alongside the
composer. Round-2 introduces `wire/` as a leaf protocol module that
everything depends on (including `acp/`), reverses the session-bridge so
services declare structural views instead of importing `AgentHelpers`,
promotes models to its own domain folder, and splits `agent.ts` into three
flat peer files.

Outcome after this plan: zero folder cycles; zero domain → `acp/` edges;
`acp/` becomes four files of pure composition + ACP method dispatch; every
domain folder owns its data and its service.

Out of scope (enforced from review): tests/e2e/adapter changes are
file-move-only (mechanical import updates); `ExtMethodSpec` typed-dispatch
overload; package export-surface revisit; any behaviour change.

## Approach

Single PR, 4 commits, each independently gate-checkable. Tests are
reorganised in the same commit as the file moves they depend on. `git mv`
for whole-file moves to preserve `git log --follow` history.

### Commit 1 — Introduce `wire/`, dissolve `acp/notifications.ts`

Create `src/wire/` as a leaf protocol folder. Drain ACP-protocol-shaped
code out of `acp/`. After this commit `acp/` no longer hosts protocol
constants or pi-ai→ACP converters; only composition + lifecycle.

**File operations:**

- `git mv packages/bodhi-pi/src/acp/constants.ts packages/bodhi-pi/src/wire/constants.ts` — verbatim move.
- Create `packages/bodhi-pi/src/wire/validators.ts` with the three wire-only
  helpers extracted from `acp/_helpers.ts:16` (`validateSessionId`), `:25`
  (`optionalSessionId`), `:51` (`requireStringParam`). Export as free
  functions (drop the `AgentHelpers` class wrapper — it added zero value
  over a module).
- Create `packages/bodhi-pi/src/wire/converters.ts` with `agentToolContentForAcp`
  (`acp/notifications.ts:65`), `toolResultContentForAcp` (`acp/notifications.ts:60`),
  `mapStopReason` (`acp/notifications.ts:88`).
- Move `extractText` (`acp/notifications.ts:22`) into the existing
  `sessions/_shared.ts`. Delete `isToolResultMessage`, `isAssistantMessage`,
  `extractToolCalls`, `formatLocationHint` (unused outside `acp/`,
  confirmed by grep in round-2 review).
- Delete `packages/bodhi-pi/src/acp/notifications.ts`.
- In `acp/_helpers.ts`: trim to only `requireSession` and
  `requireSessionRecord` (the session-store-bridge methods that Commit 2
  deletes). The wire validators are now in `wire/validators.ts`.

**Test reorganisation (same commit):**

- `src/acp/notifications.test.ts` (235 lines, all 8 exports tested) splits:
  - Tests for `mapStopReason`, `agentToolContentForAcp`,
    `toolResultContentForAcp` → new `src/wire/converters.test.ts`.
  - Tests for `extractText` → append to `src/sessions/_shared.test.ts`.
  - Tests for the four deleted helpers → delete.
- `git rm packages/bodhi-pi/src/acp/notifications.test.ts`.

**Import-path updates (same commit):**

Public surface — `src/index.ts:3-25` re-exports 21 constants from
`./acp/constants.js`. Update the source path to `./wire/constants.js`.

Internal call-sites (all switch from `@/acp/constants.js` to
`@/wire/constants.js`):

- `acp/agent.ts` (constants block)
- `acp/model-registry.ts:24`
- `client/client.ts:13-33`
- `client/config-options.ts:2`
- `kv/kv-service.ts:3`
- `sessions/compaction-orchestrator.ts:7` (also update notifications import
  on `:8` from `@/acp/notifications.js` to `@/wire/converters.js`)
- `sessions/session-graph-service.ts:9` (and `:10` from
  `@/acp/notifications.js` to `@/sessions/_shared.js`)
- `sessions/session-info-service.ts:4`
- `settings/settings-service.ts:8`

Validators (switch from `acp/_helpers.ts` methods to `wire/validators.ts`
free functions; `AgentHelpers.validateSessionId(...)` calls become
`validateSessionId(...)`):

- `kv/kv-service.ts:49, 68, 88`
- `settings/settings-service.ts:100, 127, 170`
- `sessions/session-info-service.ts:60, 82`

Test imports (15 files under `packages/bodhi-pi/test/`) — switch every
`from "@/acp/constants.js"` to `from "@/wire/constants.js"`. Files
identified in exploration:

`test/kv-slash.test.ts`, `test/settings-slash.test.ts`,
`test/tree-navigate.test.ts`, `test/new-events.test.ts`,
`test/thinking.test.ts`, `test/name-stats-export.test.ts`,
`test/compaction.test.ts`, `test/branch-summary.test.ts`,
`test/overflow-recovery.test.ts`, `test/settings.test.ts`,
`test/session-config-ext.test.ts`, `test/auto-compact.test.ts`,
`test/provider-options.test.ts`, `test/prepare-next-turn-wiring.test.ts`,
`test/fork-clone.test.ts`.

**Verification at end of commit 1:**

- `npx madge --extensions ts --circular packages/bodhi-pi/src/` — confirm
  cycles #1–#3 still present (they survive until commit 2) but no *new*
  cycle through `wire/`. `wire/` must have zero src-folder imports.
- `npm --workspace @earendil-works/bodhi-pi run build`
- `npm --workspace @earendil-works/bodhi-pi run test`

### Commit 2 — Invert session bridge, slim service views

Delete the live-Map + sessionStore bridge that forces every domain service
to import `AgentHelpers`. Agent resolves session state once per ext-dispatch
and passes structural views to handlers. Move `SessionState` family to
`sessions/`. Cycles #1, #2, #3 dissolve.

**File operations:**

- `git mv packages/bodhi-pi/src/acp/session-state.ts packages/bodhi-pi/src/sessions/session-state.ts`
  (verbatim move — 4 types: `SessionState`, `SessionRuntime`,
  `SettingsState`, `ResolvedRetryOptions`).
- Delete `packages/bodhi-pi/src/acp/_helpers.ts` entirely
  (`requireSession`, `requireSessionRecord` deleted; validators already in
  `wire/`).

**Service signature changes (ISP via structural typing — no per-domain
slice files):**

- `kv/kv-service.ts`: drop the `AgentHelpers` constructor injection
  entirely. KvService needs neither SessionState nor SessionStore — its
  handlers only use `kvStore` + `sessionId`. Method signatures:
  `handleKvSet(sessionId: string, params): Promise<...>` etc. Sites:
  `kv-service.ts:47, 66, 74, 86`.
- `settings/settings-service.ts`: define local
  `type SettingsView = { settings: SettingsState; cwd: string; runtime: SessionRuntime }`
  in this file. Handler signature: `handleSettingsGet(view: SettingsView, params)`.
  Sites: `:98, 125, 168, 205`.
- `sessions/session-info-service.ts`: local
  `type SessionInfoView = { runtime: SessionRuntime; cwd: string }`. Sites:
  `:60, 82, 104, 132`.
- `sessions/session-graph-service.ts`: same view as above (collapse to
  shared `type RuntimeView` exported from `sessions/session-state.ts` if
  duplicated). Sites: `:58, 86, 148, 163, 198`.
- `sessions/compaction-orchestrator.ts`: keeps full `SessionState`. It
  coordinates across runtime + compaction + retryOptions + tools +
  settings; one cohesive surface. Sites: `:153, 154`.

**Agent dispatch resolves the session once:**

- `acp/agent.ts` ext-dispatch table (search `extHandlers.set(EXT_`):
  inline `validateSessionId(method, req.params)` + `this.sessions.get(...)`
  + slice into the view at the call site. Example:
  ```
  extHandlers.set(EXT_KV_GET, (req) => {
    const sessionId = validateSessionId("kv/get", req.params);
    return kvService.handleKvGet(sessionId, req.params);
  });
  extHandlers.set(EXT_SETTINGS_GET, (req) => {
    const session = requireLiveSession(this.sessions, "settings/get", req.params);
    return settingsService.handleSettingsGet(
      { settings: session.settings, cwd: session.cwd, runtime: session.runtime },
      req.params,
    );
  });
  ```
- `requireLiveSession` and `requireSessionRecord` become two free functions
  in `acp/agent.ts` (or a private file `acp/session-resolution.ts` if they
  exceed ~30 lines combined). They are agent-internals, not exported.

**Import-path updates:**

- All `from "@/acp/_helpers.js"` imports across domain services → delete.
- All `from "@/acp/session-state.js"` → `from "@/sessions/session-state.js"`:
  `acp/agent.ts`, `acp/model-registry.ts:25`, `acp/session-bootstrap.ts`,
  `settings/settings-service.ts:9`, `sessions/compaction-orchestrator.ts:9`,
  `sessions/session-graph-service.ts:11`,
  `sessions/session-info-service.ts:5`.

**Verification at end of commit 2:**

- `npx madge --extensions ts --circular packages/bodhi-pi/src/` — cycles
  #1, #2, #3 must be gone. Cycle #5 (client↔kv) and the
  acp→extensions→sessions→acp transitive may remain (commit 3).
- Build + test (same as commit 1).

### Commit 3 — `models/` peer domain, client↔kv break, leaf cleanup

**File operations:**

- `git mv packages/bodhi-pi/src/acp/model-registry.ts packages/bodhi-pi/src/models/registry.ts`.
  Update sole importer `acp/agent.ts`.
- `git mv packages/bodhi-pi/src/acp/session-bootstrap.ts packages/bodhi-pi/src/sessions/session-bootstrap.ts`.
  Update sole importer `acp/agent.ts`.
- `git mv packages/bodhi-pi/src/core/resource-loader.ts packages/bodhi-pi/src/sessions/resource-loader.ts`.
  Update importers: `sessions/session-state.ts` (line 4 in old file —
  `ContextFile` co-locates with the loader, both in sessions/ now) and
  `sessions/session-bootstrap.ts:20`.
- `git mv packages/bodhi-pi/src/core/system-prompt.ts packages/bodhi-pi/src/acp/system-prompt.ts`.
  Update sole importer `sessions/session-bootstrap.ts:21`.
- Delete `packages/bodhi-pi/src/core/` directory.
- Move `ProviderAuth` definition from `client/types.ts:19` to
  `kv/auth-format.ts`. Drop the back-import at `kv/auth-format.ts:1`. Drop
  the back-import at `commands/slash-args.ts:1`. Re-export
  `ProviderAuth` from `client/types.ts` (re-export-only) so
  `src/index.ts:51` keeps working without an index.ts change.
- Delete `packages/bodhi-pi/src/_internal/awaitable.ts`. Inline
  `type Awaitable<T> = T | Promise<T>;` at the top of `events/types.ts` (was
  imported at `:305`) and `extensions/types.ts` (was imported at `:56`).
- Apply `pickDefined` from `_internal/object.ts:10` to the 29
  ternary-spread sites: `acp/agent.ts:130, 206-209, 217, 223-224, 490, 589, 591`
  and `client/client.ts:156-157, 169-170, 182-183, 198, 255, 263, 292, 300,
  346, 356, 363, 370, 378, 387, 395`. Pattern:
  `...(x ? { key: val } : {})` → `...pickDefined({ key: val })`.

**Test reorganisation (same commit):**

- `git mv packages/bodhi-pi/test/resource-loader.test.ts packages/bodhi-pi/test/sessions/resource-loader.test.ts`
  (or keep path; the test is integration-style, just update the import on
  `:2` from `@/core/resource-loader.js` to
  `@/sessions/resource-loader.js`). Pick the no-rename path — simpler,
  fewer diff lines.

**Comment deletions (themed patterns, applied across files touched in
`ef1a74f6`, `cdc4804a`, `91c7103f`):**

Pattern 1 — multi-paragraph JSDoc on private methods: delete entirely.
Exemplars: `acp/agent.ts:275-279` (`emitConfigOptionUpdate`),
`acp/agent.ts:626-632` (`subscribeToAgent` — will be in
`acp/prompt-loop.ts` after commit 4, delete there if not already gone),
`acp/agent.ts:789-799` (`refreshSlashable` — keep one line on
implicit-global-refresh; that's the genuine WHY).

Pattern 2 — JSDoc that restates the symbol name: delete. Exemplars:
`acp/agent.ts:170` (`extHandlers` field), `kv/kv-store.ts:29-32`
(`maskSecrets`).

Pattern 3 — orphaned/dangling JSDoc above an unrelated symbol: delete.
Exemplars: `acp/agent.ts:518`, `acp/agent.ts:767-771`.

Pattern 4 — narrative inline comments describing immediately-following
code: delete. Exemplars: `acp/agent.ts:180-182`, `acp/agent.ts:185-188`.

Pattern 5 — interface JSDoc that restates the contract without WHY:
compress to one or two lines, keep only surprise-preventing claims.
`kv/kv-store.ts:3-18` → keep AUTH_PREFIX reservation line.
`sessions/session-store.ts:55-72` → keep append-only + cursor-required
lines. `filesystem/filesystem.ts:1-21` → keep `:19-21` (the
`fs/read_text_file` contrast).

Apply each pattern across every match in the touched files, not only the
exemplars.

**Verification at end of commit 3:**

- `npx madge --extensions ts --circular packages/bodhi-pi/src/` — zero
  cycles.
- Build + test.

### Commit 4 — Split `acp/agent.ts` (flat, no subfolders)

After commits 1–3, `acp/agent.ts` is ~500–600 lines spanning composition,
ACP method dispatch, prompt loop, event wiring, bootstrap helpers. Extract
two peer files.

**Extractions (read the file after commit 3 to confirm exact line ranges
— numbers below are current-tree references that drift as earlier commits
land):**

- `acp/prompt-loop.ts`: pi-agent subscription + prompt execution.
  Currently `acp/agent.ts:580-end-of-method` (search `async prompt(`) and
  `acp/agent.ts:626-end-of-method` (`subscribeToAgent`). Export
  `runPromptLoop(deps, session, params)` where `deps` is
  `{ conn, events, sessionStore, appendEntry, logger }`.
  `BodhiPiAcpAgent.prompt` becomes a delegation:
  ```
  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) throw new RequestError(...);
    return runPromptLoop(this.promptDeps(), session, params);
  }
  ```
- `acp/event-wiring.ts`: internal event handlers that fire
  `config_option_update`. Currently `acp/agent.ts:180-188`
  (`appendHandlers` calls for `auth_change`, `settings_change`,
  `model_select`), `:266` (`affectsPickerKey`), `:280`
  (`emitConfigOptionUpdate`). Export
  `wireInternalEventHandlers(events, deps)`. Constructor calls it once.

**What stays in `acp/agent.ts`:**

- Class shell + constructor (composition root)
- ACP method handlers: `initialize`, `authenticate`, `newSession`,
  `loadSession`, `resumeSession`, `listSessions`, `deleteSession`,
  `setSessionConfigOption`, `cancel`
- Ext-dispatch table assembly
- Bootstrap helpers: `ensureExtensionRunner`, `bootstrapDeps`,
  `appendEntry`, `advertiseSlashable`, `refreshSlashable`

Expected post-commit size: ~500 lines.

**Verification:**

- Build + test.
- `wc -l packages/bodhi-pi/src/acp/*.ts` — `agent.ts` < 550 lines,
  `prompt-loop.ts` ~150, `event-wiring.ts` ~80.

## Critical files

- `packages/bodhi-pi/src/index.ts` — public surface; verify constants re-export path updates in commit 1; `ProviderAuth` re-export at `:51` stays (via re-export shim in `client/types.ts`).
- `packages/bodhi-pi/src/acp/agent.ts` — every commit touches this file.
- `packages/bodhi-pi/src/acp/_helpers.ts` — deleted in commit 2.
- `packages/bodhi-pi/src/acp/notifications.ts` — deleted in commit 1.
- `packages/bodhi-pi/src/acp/constants.ts` — moved in commit 1.
- `packages/bodhi-pi/src/acp/session-state.ts` — moved in commit 2.
- `packages/bodhi-pi/src/acp/model-registry.ts` — moved in commit 3.
- `packages/bodhi-pi/src/acp/session-bootstrap.ts` — moved in commit 3.
- `packages/bodhi-pi/src/core/` — deleted in commit 3.
- `packages/bodhi-pi/src/client/types.ts` — `ProviderAuth` definition moves out, re-export stays.
- `packages/bodhi-pi/src/kv/auth-format.ts` — `ProviderAuth` lands here.
- `packages/bodhi-pi/src/_internal/awaitable.ts` — deleted in commit 3.

## Reuse notes

- `_internal/object.ts:10` exports `pickDefined<T>(obj: T): Partial<T>` —
  already present, currently unused. Commit 3 applies it to 29 sites.
- `sessions/_shared.ts` already hosts cross-service helpers
  (`buildEntryIndex`, `computeFileLists`, `extractFileOps`,
  `runSummarizationLLM`). Commit 1 appends `extractText` here.
- `acp/agent.ts:158` (`private sessions = new Map<string, SessionState>()`)
  is the live-session Map that commit 2's dispatch wrapper resolves via
  the new free function `requireLiveSession`.

## Verification (end-to-end)

After each commit:

```
cd packages/bodhi-pi
npx madge --extensions ts --circular src/   # expected: empty after commit 2
npm run build                                # tsgo + tsc-alias
npm run test                                 # vitest --run
```

After commit 4 (final state):

```
# from repo root
npm run check                                # biome + tsgo --noEmit (monorepo)
npm --workspace @earendil-works/bodhi-pi run build
npm --workspace @earendil-works/bodhi-pi run test
npm --workspace @earendil-works/bodhi-pi run test:e2e
# optional: dependency-graph confirmation
cd packages/bodhi-pi && npx madge --extensions ts --image deps.png src/index.ts
```

Acceptance criteria:

1. `npx madge --circular` reports zero cycles in `packages/bodhi-pi/src/`.
2. Build + unit + e2e all green at every commit; final commit also
   passes monorepo `npm run check`.
3. `packages/bodhi-pi/src/acp/` contains exactly: `agent.ts` (≤ 550
   lines), `prompt-loop.ts`, `event-wiring.ts`, `system-prompt.ts`.
4. `packages/bodhi-pi/src/wire/` contains exactly: `constants.ts`,
   `validators.ts`, `converters.ts`, `converters.test.ts`.
5. `packages/bodhi-pi/src/models/` contains `registry.ts`.
6. `packages/bodhi-pi/src/core/` does not exist.
7. `packages/bodhi-pi/src/_internal/awaitable.ts` does not exist.
8. Public surface unchanged: `src/index.ts` exports same symbol set as
   pre-refactor (verify with `tsgo -p tsconfig.build.json --listFiles`
   diff or hand-comparison).
9. `git log --follow` works for every moved file (validates `git mv`
   usage in commits 1–3).
