# `@bodhiapp/bodhi-pi` src cleanup — pre-publish

## Context

`@bodhiapp/bodhi-pi` is preparing for first publish (currently `0.0.1`). The largest readability/maintainability blocker is `packages/bodhi-pi/src/acp/agent.ts` (2103 lines, one `BodhiPiAcpAgent` class holding six unrelated responsibilities: ACP wire, 20-entry ext-method dispatch, settings layering, KV proxying, compaction orchestration, model registry, ACP subscriber, bootstrap). Around it sit smaller hygiene issues: `isPlainObject` and `Awaitable<T>` each defined twice, `SettingsScope` exported from two modules, the `byId.set(entry.id, entry)` loop repeated in `branch-summary.ts` and `build-context.ts`, four `as never` casts on `state.thinkingLevel`, `console.error` baked into `EventDispatcher` and `ExtensionRunner`, the dead `resolveApiKeyForCompaction` / `checkAutoCompact` wrappers, the noop async wrapper in `adaptExtensionTool`, auth-format helpers split across three files, the ext-method contract typed as `Record<string, unknown> → Record<string, unknown>` with the typed client's `ext<T>(...)` papering over it, and a `default` branch on the `mapStopReason` switch that suppresses type-checking new pi-ai stop reasons.

Goal: ship a decomposed, type-tight `src/` ready for `0.1.0`. Behaviour stays identical. The contract is the existing test matrix (`just test`): full bodhi-pi unit + integration + e2e + every adapter + every reference host. Test files only change where an import path moves under our feet.

## Approach

Three grouped commits. Each one must leave `just test` green before the next begins.

1. **Structural decomposition** — introduce five `*Service`s + `ModelRegistry` + `CompactionOrchestrator` + `session-bootstrap`, plus a new `src/settings/` folder absorbing `src/core/settings*.ts`. The agent class becomes a thin composition root.
2. **Deduplication + dead code** — wire the new shared helpers, delete the stale wrappers, collapse the noop async adapter, apply `pickDefined` and `buildEntryIndex` at every site.
3. **Typed dispatch + public surface + typing nits** — `ExtMethodSpec` map, narrow the `as never`/`Model & { contextWindow? }` casts behind helpers, host-injectable logger, extra public exports, JSDoc on the three public interfaces, exhaustive `mapStopReason`.

## Target shape

```
                   BodhiPiAcpAgent (src/acp/agent.ts, ~500 LOC)
                   ├─ ACP methods (initialize/newSession/loadSession/resumeSession/
                   │                listSessions/closeSession/prompt/setSessionConfigOption/
                   │                cancel/extMethod)
                   ├─ subscribeToAgent, advertiseSlashable/refreshSlashable,
                   │  ensureExtensionRunner, appendEntry, emitConfigOptionUpdate
                   └─ extHandlers = Map<keyof ExtMethodSpec, ExtHandler<...>>
                      built once in ctor by merging:
                            │
            ┌───────────────┼──────────────┬────────────┬────────────────┐
            ▼               ▼              ▼            ▼                ▼
       KvService       Settings-      SessionGraph- SessionInfo-   CompactionOrchestrator
   (src/kv/             Service        Service        Service       (src/sessions/
    kv-service.ts)    (src/settings/  (src/sessions/  (src/sessions/  compaction-
                       settings-       session-graph-  session-info-   orchestrator.ts)
                       service.ts)     service.ts)     service.ts)
                                                          │                │
                                                          │                │  cross-branch
                                                          │                │  navigate calls
                                                          └────────────────┘  CompactionOrchestrator
                                                                              .runBranchSummaryForNavigate(...)

                                ▲ depend on ▲
                                │           │
                       ModelRegistry    session-bootstrap.ts (free fns)
                       (src/acp/         buildSessionState() composes
                        model-           the others; called by
                        registry.ts)     newSession + resumeSession +
                                         loadSession via the agent
```

Services share these dependency bags injected via constructor:
- `events: EventDispatcher`
- `config: BodhiPiConfig` (read-only access; the agent passes through)
- shared param-validation helpers from `src/acp/_helpers.ts`: `validateSessionId`, `optionalSessionId`, `requireSession`, `requireSessionRecord`, `requireStringParam`

Each service exposes `register(): Array<[keyof ExtMethodSpec, ExtHandler<M>]>`; the agent's `extHandlers` Map is populated in one shot from the five `register()` results plus the two handlers the agent keeps locally (`EXT_DELETE_SESSION`, the kv/settings ones already moved).

## Module layout after all three commits

```
src/
├── acp/
│   ├── agent.ts                  # ~500 LOC: state + ACP method router + subscribeToAgent
│   │                             #            + advertiseSlashable + ensureExtensionRunner
│   ├── constants.ts              # unchanged
│   ├── notifications.ts          # internal helpers demoted (file-level @internal JSDoc)
│   ├── _helpers.ts               # NEW: shared validation (see "shared helpers")
│   ├── ext-method-spec.ts        # NEW (Commit 3): typed per-method spec map
│   ├── model-registry.ts         # NEW: ModelRegistry
│   └── session-bootstrap.ts      # NEW: buildSessionState + rehydrateSession helpers
├── kv/
│   ├── kv-store.ts               # unchanged
│   ├── in-memory-kv-store.ts     # unchanged
│   ├── auth-format.ts            # NEW: extractAuthApiKey/BaseUrl + normalize/parse
│   └── kv-service.ts             # NEW: KvService
├── settings/                     # NEW folder (absorbs src/core/settings*.ts)
│   ├── settings.ts               # MOVED from src/core/
│   ├── settings-global.ts        # MOVED
│   ├── settings-merge.ts         # MOVED, uses shared isPlainObject
│   ├── settings-writer.ts        # MOVED, canonical home for SettingsScope
│   └── settings-service.ts       # NEW: SettingsService
├── sessions/
│   ├── (existing files unchanged)
│   ├── _shared.ts                # + buildEntryIndex helper
│   ├── compaction.ts             # + getContextWindow(model)
│   ├── compaction-orchestrator.ts # NEW
│   ├── session-graph-service.ts  # NEW
│   └── session-info-service.ts   # NEW
├── extensions/
│   ├── runner.ts                 # uses host logger instead of console.error
│   ├── tool-adapter.ts           # collapsed to direct field map (drops async wrapper)
│   ├── types.ts                  # Awaitable<T> moves to _internal
│   └── (others unchanged)
├── events/
│   ├── dispatcher.ts             # uses host logger
│   └── types.ts                  # Awaitable<T> moves to _internal
├── core/                         # SHRUNK to: resource-loader.ts + system-prompt.ts
├── _internal/
│   ├── frontmatter.ts, sort.ts   # unchanged
│   ├── awaitable.ts              # NEW (Commit 2): Awaitable<T>
│   └── object.ts                 # NEW (Commit 2): isPlainObject + pickDefined<T>
├── client/                       # consumes kv/auth-format.ts; types add ExtMethodSpec overload
├── tools/, skills/, commands/, filesystem/, script-executor/, version.ts  # unchanged
└── index.ts                      # adds: BODHI_PI_VERSION, Skill, PromptTemplate,
                                  # ExtensionFactoryError, BodhiPiConfig.logger?;
                                  # SettingsScope re-export source switches to src/settings/
```

## Shared helpers (used across all three commits)

- `src/acp/_helpers.ts` (Commit 1) — extract `validateSessionId`, `optionalSessionId`, `requireSession`, `requireSessionRecord` from their existing private definitions in `src/acp/agent.ts`. Add a sibling `requireStringParam(method, params, key)` for the `typeof X !== "string" || X.length === 0` pattern used by KV + settings handlers. These take the agent's `sessions` map and `sessionStore` as parameters (not `this.`); services receive them via constructor dependency bag.
- `src/_internal/object.ts` (Commit 2) — `isPlainObject(v): v is Record<string, unknown>` and `pickDefined<T>(obj: T)` returning a shallow object containing only the fields whose values are defined. Replaces the `...(x !== undefined ? { x } : {})` ternary pattern throughout `agent.ts`, the new services, and `src/client/client.ts`.
- `src/_internal/awaitable.ts` (Commit 2) — `export type Awaitable<T> = T | Promise<T>;` consumed by `events/types.ts` and `extensions/types.ts`. Private to the barrel.
- `src/sessions/_shared.ts` (Commit 2) — add `buildEntryIndex(entries: SessionEntry[]): Map<string, SessionEntry>`. Consumed by `branch-summary.ts:detectCrossBranch` and `build-context.ts:walkPath`.

## Commit 1 — Structural decomposition

**Moves** (no behaviour change; pure import-path follow-through):

- `src/core/settings.ts` → `src/settings/settings.ts`
- `src/core/settings-global.ts` → `src/settings/settings-global.ts`
- `src/core/settings-merge.ts` → `src/settings/settings-merge.ts`
- `src/core/settings-writer.ts` → `src/settings/settings-writer.ts`

Import-site updates required:
- `src/index.ts` exports for `./core/settings.js`, `./core/settings-global.js`, `./core/settings-merge.js` switch to `./settings/...`.
- `src/acp/agent.ts` imports `@/core/settings*` switch to `@/settings/...` (these imports themselves go away by the end of this commit when the agent stops touching settings directly, but the move + redirect must compile first).
- `test/settings.test.ts:10-12` (`@/core/settings`, `@/core/settings-global`, `@/core/settings-merge`) — update to `@/settings/...`.

**New modules:**

| New file | Lifts from `src/acp/agent.ts` (current method names) | Constructor deps |
|---|---|---|
| `src/acp/_helpers.ts` | `validateSessionId`, `optionalSessionId`, `requireSession`, `requireSessionRecord` (the four private methods on agent); add `requireStringParam` | (none — free functions parameterised on `sessions: Map<...>`, `sessionStore`) |
| `src/kv/auth-format.ts` | `extractAuthApiKey`, `extractAuthBaseUrl` (free fns in agent.ts) + `normalizeProviderAuth`, `parseProviderAuth` (from `src/client/client.ts`); re-export `AUTH_PREFIX` | none |
| `src/kv/kv-service.ts` | `handleKvSet/Get/List/Remove`, `requireKvStore` | `{ kvStore?, events, helpers }` |
| `src/settings/settings-service.ts` | `handleSettingsGet/Set/Unset/List`, `parseScope`, `assertGlobalSupported`, `effectiveSettings`, `sourceForKey` | `{ config, events, helpers }` |
| `src/sessions/session-info-service.ts` | `handleSessionConfig`, `handleSessionSetName`, `handleSessionStats`, `handleSessionExport`, `emitSessionInfoUpdate` (`agent.appendEntry` passed in via dep bag) | `{ config, sessions, sessionStore, events, helpers, conn, appendEntry }` |
| `src/sessions/session-graph-service.ts` | `handleSessionTree`, `handleSessionNavigate`, `handleSessionEntries`, `handleSessionFork`, `handleSessionClone` | `{ sessions, sessionStore, events, helpers, appendEntry, runBranchSummaryForNavigate }` |
| `src/sessions/compaction-orchestrator.ts` | `makeCompactionEntry`, `runAndPersistCompaction`, `handleSessionCompact`, `checkAutoCompact`, `maybeProactiveCompact`, `runProactiveCompaction`, `tryOverflowRecovery`, `runBranchSummaryForNavigate` (NEW thin wrapper that calls `runBranchSummary` with the orchestrator's `resolveApiKey` callback) | `{ sessions, sessionStore, events, helpers, appendEntry, resolveApiKey }` |
| `src/acp/model-registry.ts` | `allModels`, `findModel`, `pickDefaultModelIdOrNull`, `buildModelConfigOption`, `buildThinkingConfigOption`, `buildAllConfigOptions`, `setSessionModel`, `setSessionThinkingLevel`, `resolveProviderAuth`, `resolveProviderApiKey`, `resolveProviderBaseUrl`, `resolveProviderStreamOptions` (the free function) | `{ config, sessions, sessionStore, events, helpers, appendEntry, extensionRunner: () => ExtensionRunner \| undefined }` |
| `src/acp/session-bootstrap.ts` | `loadProjectArtifacts`, `composeSystemPrompt`, `createPiAgent`, `_resolveSessionModel`, `rehydrateSession`, `_buildSessionState` — exported as free functions (drop the `_` prefixes) consumed by the agent's `newSession`/`loadSession`/`resumeSession` | (none directly — caller passes `{ config, events, modelRegistry, compactionOrchestrator, conn, sessions, ensureExtensionRunner }`) |

**`BodhiPiAcpAgent` (`src/acp/agent.ts`) after this commit:**

```ts
class BodhiPiAcpAgent implements AcpAgent {
  private sessions = new Map<string, SessionState>();
  private readonly events: EventDispatcher;
  private extensionRunner?: ExtensionRunner;
  private extensionRunnerReady?: Promise<void>;

  private readonly kvService: KvService;
  private readonly settingsService: SettingsService;
  private readonly sessionGraphService: SessionGraphService;
  private readonly sessionInfoService: SessionInfoService;
  private readonly compactionOrchestrator: CompactionOrchestrator;
  private readonly modelRegistry: ModelRegistry;
  private readonly extHandlers: Map<string, ExtHandler>;

  constructor(private readonly config: BodhiPiConfig, private readonly conn: AgentSideConnection) {
    this.events = new EventDispatcher(config.eventHandlers);
    // internal subscriber wiring (auth_change/settings_change/model_select) stays here.

    const deps = { /* sessions, sessionStore, events, conn, helpers, appendEntry */ };
    this.modelRegistry          = new ModelRegistry({ ...deps, extensionRunner: () => this.extensionRunner });
    this.compactionOrchestrator = new CompactionOrchestrator({ ...deps, resolveApiKey: p => this.modelRegistry.resolveProviderApiKey(p) });
    this.kvService              = new KvService(deps);
    this.settingsService        = new SettingsService(deps);
    this.sessionInfoService     = new SessionInfoService(deps);
    this.sessionGraphService    = new SessionGraphService({ ...deps, runBranchSummaryForNavigate: this.compactionOrchestrator.runBranchSummaryForNavigate });

    this.extHandlers = new Map<string, ExtHandler>([
      [EXT_DELETE_SESSION, this.handleSessionDelete.bind(this)],
      ...this.kvService.register(),
      ...this.settingsService.register(),
      ...this.sessionInfoService.register(),
      ...this.sessionGraphService.register(),
      ...this.compactionOrchestrator.register(),
    ]);
  }

  // Agent keeps: initialize, authenticate, newSession, loadSession, resumeSession,
  // listSessions, closeSession, extMethod, prompt, cancel, setSessionConfigOption (delegates to modelRegistry),
  // subscribeToAgent, advertiseSlashable, refreshSlashable, ensureExtensionRunner,
  // appendEntry, emitConfigOptionUpdate, affectsPickerKey, handleSessionDelete.
}
```

Confirm the final agent.ts at ~500 LOC: `wc -l src/acp/agent.ts`.

## Commit 2 — Deduplication, dead code, helper consolidation

- **A.8 string-param check sweep**: replace the six `typeof X !== "string" || X.length === 0` open-coded checks (currently in the moved KV + settings handlers — `handleSettingsGet/Set/Unset`, `handleKvSet/Get/Remove`) with `requireStringParam(...)`. Search via `grep -rn 'typeof .* !== "string" || .*length === 0' src/`.
- **B.1 `isPlainObject` + `pickDefined`**: create `src/_internal/object.ts`. `src/settings/settings-merge.ts:3` and `src/settings/settings-writer.ts:8` drop their local copies and import. `pickDefined({ x, y, z })` returns an object containing only the keys whose values are not `undefined` — wire it into the agent + new services + `src/client/client.ts` everywhere there is currently a `...(v !== undefined ? { v } : {})` spread. Sites: every `requireSession`/`requireSessionRecord` caller in `client.ts`, every `_meta`/`additionalDirectories`/`customInstructions`/`position`/`prefix`/`scope` ternary spread, and the matching patterns in the new services.
- **B.2 `SettingsScope` canonical home**: confirm `src/settings/settings-writer.ts` exports `SettingsScope`. Change `src/client/types.ts:195` to `export type { SettingsScope } from "@/settings/settings-writer.js";` (or `export type SettingsScope = ...` mirroring the writer's literal, then prefer the re-export). `src/index.ts:65` re-export source switches to `./settings/settings-writer.js` (or stays as `./client/types.js` if it just re-exports; either is fine — the constraint is a single definition).
- **B.3 settings-path JSDoc**: in `src/settings/settings.ts:6-8`, add a one-line JSDoc on each of `SETTINGS_PATH` and `GLOBAL_SETTINGS_PATH` clarifying that both literals are the same string but resolve relative to different roots (`SETTINGS_PATH` is joined with `cwd` for `loadProjectSettings`; `GLOBAL_SETTINGS_PATH` is joined with `homeDir` for `loadGlobalSettings`).
- **B.4 `buildEntryIndex`**: add to `src/sessions/_shared.ts`. Call sites: replace `const byId = new Map<string, SessionEntry>(); for (const entry of entries) byId.set(entry.id, entry);` in `src/sessions/branch-summary.ts:27-28` and `src/sessions/build-context.ts:21-22` with one call to the helper.
- **B (Awaitable<T>)**: create `src/_internal/awaitable.ts`. `src/events/types.ts:305` and `src/extensions/types.ts:56` drop their local `type Awaitable<T>` and import.
- **C.1 `resolveApiKeyForCompaction`**: this one-line wrapper at `src/acp/agent.ts:1270-1272` (now relocated into `ModelRegistry`) is identical to `resolveProviderApiKey`. Delete the wrapper; call sites already either point at `ModelRegistry.resolveProviderApiKey` or were merged into `CompactionOrchestrator` in Commit 1 — verify-and-delete.
- **C.2 `checkAutoCompact`**: thin wrapper around `runProactiveCompaction` at `src/acp/agent.ts:1443-1445` (now in `CompactionOrchestrator`). Inline; delete the wrapper.
- **C.3 `adaptExtensionTool`**: rewrite `src/extensions/tool-adapter.ts:6-17` as a direct field map: `{ name: def.name, label: def.name, description: def.description, parameters: def.parameters, execute: def.execute }`. The current `async (...) => { const result = await def.execute(...); return result; }` adds nothing.
- **C.6 config-option setters**: in `src/acp/model-registry.ts:setSessionConfigOption`, replace the `if/else if/else` over `configId` with a `Record<string, (sessionId, session, value) => Promise<void>>` keyed by `MODEL_CONFIG_ID` and `THINKING_CONFIG_ID`. New config options become one entry.
- **C.7 demote ACP notification helpers**: drop the `export` keyword from `ToolCallContentBlock` (notifications.ts:12), `ExtractedToolCall` (notifications.ts:35), and `AcpStopReason` (notifications.ts:75). Add a file-level `@internal` JSDoc.

## Commit 3 — Typed dispatch, public surface, typing nits

- **D.1 `ExtMethodSpec`**: create `src/acp/ext-method-spec.ts` exporting:
  ```ts
  export interface ExtMethodSpec {
    [EXT_KV_SET]:               { params: KvSetParams;           result: KvSetResult };
    [EXT_KV_GET]:               { params: KvGetParams;           result: KvGetResult };
    /* … one entry per EXT_* constant, sourcing the param/result types from src/client/types.ts */
  }
  export type ExtHandler<M extends keyof ExtMethodSpec> =
    (params: ExtMethodSpec[M]["params"]) => Promise<ExtMethodSpec[M]["result"]>;
  ```
  Each service's `register()` returns `Array<[M, ExtHandler<M>]>` tuples. The agent's `extHandlers` Map becomes `Map<keyof ExtMethodSpec, ExtHandler<keyof ExtMethodSpec>>`. `BodhiPiAcpAgent.extMethod` gets an overload that selects on the method literal. `BodhiPiAcpConnection.extMethod` in `src/client/types.ts:31` mirrors the overload. `BodhiPiClient.ext<T>` in `src/client/client.ts:274-276` drops `T` and the `as Promise<T>` cast.
- **D.3 export missing types**: `src/index.ts` adds `export type { Skill } from "./skills/skill.js";`, `export type { PromptTemplate } from "./commands/prompt-templates.js";`, `export { type ExtensionFactoryError } from "./extensions/runner.js";`.
- **D.4 export `BODHI_PI_VERSION`**: `src/index.ts` adds `export { BODHI_PI_VERSION } from "./version.js";`.
- **D.5 README typebox note**: in `packages/bodhi-pi/README.md`, add one short line stating that `typebox` is part of the public API surface for extension authors (`ExtensionToolDefinition.parameters` accepts a `TSchema`). README is an allowed file. Skip if no README is present.
- **E.1 `narrowThinkingLevel`**: in `src/acp/model-registry.ts`, add `narrowThinkingLevel(model: Model<Api>, level: ModelThinkingLevel)` returning the appropriately narrowed type, and use it at the four `state.thinkingLevel = X as never` sites (currently lines 1301, 1336, 1913, 1963 in the pre-commit-1 agent.ts; post-commit-1 those live in `model-registry.ts` and `session-bootstrap.ts`).
- **E.2 `getContextWindow`**: add `export function getContextWindow(model: Model<Api>): number` to `src/sessions/compaction.ts`. Replace the two `(state.model as Model<Api> & { contextWindow?: number }).contextWindow ?? 0` reads in the now-`CompactionOrchestrator` (`runProactiveCompaction`, `tryOverflowRecovery`).
- **E.3 navigate bare-catch**: in `src/sessions/session-graph-service.ts:handleSessionNavigate`, replace `catch { /* Non-fatal: fall through to plain navigate */ }` with `catch (err) { config.logger.error(...) }` using the host logger from E.5.
- **E.5 host logger**: extend `BodhiPiConfig` with `logger?: { error(message: string, ...args: unknown[]): void }`. Default at the agent constructor to `console`. Pass to `EventDispatcher` (replace `console.error` at dispatcher.ts:47) and to `ExtensionRunner` (replace `console.error` at runner.ts:91). Expose `logger` through the services' dependency bag so they can use it in place of any future console-error calls.
- **E.7 public-interface JSDoc**: add multi-paragraph contract docs to `Filesystem` (`src/filesystem/filesystem.ts`), `KvStore` (`src/kv/kv-store.ts`), and `SessionStore` (`src/sessions/session-store.ts`). Cover: throw-vs-return-undefined semantics, POSIX-absolute path expectation, append-only / leaf-tracking invariants. Use existing `loadProjectSettings` JSDoc as a tone reference.
- **E.8 exhaustive `mapStopReason`**: drop the `default:` arm in `src/acp/notifications.ts:81-93`. Switch becomes exhaustive over `Exclude<PiStopReason, "error"> | undefined`. A new pi-ai stop reason will fail the type check at the two call sites (`agent.prompt`'s `mapStopReason(outcome.stopReason)` and `tryOverflowRecovery`'s `mapStopReason(retryOutcome.stopReason)`), which is the desired behaviour.

## Per-commit gate

```bash
cd packages/bodhi-pi && npm run test           # vitest unit + integration
cd packages/bodhi-pi && npm run test:e2e       # gpt-4o-mini round-trip
just test                                       # full matrix; no fail-fast,
                                                # read the end-of-run summary
```

Each commit only lands when the matrix is green. `justfile` collects failures across all workspaces — `[ ${#failures[@]} -eq 0 ]` is the success signal.

## Verification (end-of-plan)

1. `wc -l packages/bodhi-pi/src/acp/agent.ts` ≈ 500.
2. `ls packages/bodhi-pi/src/` shows new `settings/` folder; `src/core/` contains only `resource-loader.ts` and `system-prompt.ts`.
3. `grep -rn "isPlainObject\|type Awaitable\b" packages/bodhi-pi/src/` — exactly one definition each, the rest are imports.
4. `grep -rn "as never" packages/bodhi-pi/src/` — zero hits.
5. `grep -rn "Record<string, unknown>" packages/bodhi-pi/src/acp/` — sharply reduced; remaining hits live inside `ext-method-spec.ts` constraints and at the KV `JsonValue` boundary, not on ext-method signatures.
6. `grep -rn "extractAuthApiKey\|normalizeProviderAuth\|parseProviderAuth" packages/bodhi-pi/src/` — definitions in `src/kv/auth-format.ts` only; everything else is an import.
7. `grep -rn "console.error" packages/bodhi-pi/src/` — zero hits in `dispatcher.ts` and `runner.ts`.
8. `packages/bodhi-pi/dist/index.d.ts` after `npm --workspace @bodhiapp/bodhi-pi run build`: contains `BODHI_PI_VERSION`, `Skill`, `PromptTemplate`, `ExtensionFactoryError`, `BodhiPiConfig.logger?`.
9. `just test` ends with `✅ All steps passed.`
10. Manual smoke via `npm --workspace @bodhiapp/bodhi-pi-cli run dev`: `/login`, prompt, `/compact`, `/fork`, `/goto`, `/settings get`/`set`, `/logout` behave as before.

## Out of scope

- Export-surface redesign (subpath exports for in-memory adapters, typebox subpath) — deferred to a future "publish surface" pass.
- Typebox runtime validation of ext-method params — type-only contract for this pass.
- Narrowing the open `[key: string]: unknown` index signature on `BodhiPiProjectSettings` — deferred.
- Test behaviour changes — none. Only test imports change where the file they import from moved (test/settings.test.ts, test/resource-loader.test.ts).
- Renaming `src/core/` to something else — `resource-loader.ts` and `system-prompt.ts` stay there; not worth the churn.

## Critical files

Modified (cumulative across all three commits):

- `packages/bodhi-pi/src/acp/agent.ts` (2103 → ~500 lines)
- `packages/bodhi-pi/src/acp/notifications.ts`
- `packages/bodhi-pi/src/client/client.ts`
- `packages/bodhi-pi/src/client/types.ts`
- `packages/bodhi-pi/src/events/dispatcher.ts`
- `packages/bodhi-pi/src/events/types.ts`
- `packages/bodhi-pi/src/extensions/runner.ts`
- `packages/bodhi-pi/src/extensions/tool-adapter.ts`
- `packages/bodhi-pi/src/extensions/types.ts`
- `packages/bodhi-pi/src/filesystem/filesystem.ts`
- `packages/bodhi-pi/src/index.ts`
- `packages/bodhi-pi/src/kv/kv-store.ts`
- `packages/bodhi-pi/src/sessions/branch-summary.ts`
- `packages/bodhi-pi/src/sessions/build-context.ts`
- `packages/bodhi-pi/src/sessions/compaction.ts`
- `packages/bodhi-pi/src/sessions/session-store.ts`
- `packages/bodhi-pi/src/sessions/_shared.ts`
- `packages/bodhi-pi/test/settings.test.ts` (import paths only — three `@/core/settings*` lines move to `@/settings/...`)

Moved (Commit 1):

- `src/core/settings.ts` → `src/settings/settings.ts`
- `src/core/settings-global.ts` → `src/settings/settings-global.ts`
- `src/core/settings-merge.ts` → `src/settings/settings-merge.ts`
- `src/core/settings-writer.ts` → `src/settings/settings-writer.ts`

New (Commit 1 unless noted):

- `src/acp/_helpers.ts`
- `src/acp/model-registry.ts`
- `src/acp/session-bootstrap.ts`
- `src/acp/ext-method-spec.ts` (Commit 3)
- `src/kv/auth-format.ts`
- `src/kv/kv-service.ts`
- `src/settings/settings-service.ts`
- `src/sessions/compaction-orchestrator.ts`
- `src/sessions/session-graph-service.ts`
- `src/sessions/session-info-service.ts`
- `src/_internal/awaitable.ts` (Commit 2)
- `src/_internal/object.ts` (Commit 2)