# bodhi-pi uniformity + audit-fix plan

## Context

The 2026-05-21 full-tree audit (`ai-docs/reviews/2026-05-21-full-tree-audit.md`)
found that bodhi-pi's reference runtimes diverge in ways the runtime does not
force: the client dispatchers expose different command sets and reach the agent
three different ways (cli REPL via the `BodhiPiClient` SDK, cli headless via raw
`client.ext(...)`, browser/http/chrome-ext via raw `conn.extMethod(...)` bypassing
the SDK); session-scope settings are lost under http/ws per-turn rebuild because
they live only in memory while `model_change`/`thinking_change`/`mcp_inclusion_set`
persist as `SessionEntry` and replay; and several e2e gates (`!isRuntime("http")`,
`runIf(!in-memory)`) document divergence instead of fixing it.

**Goal:** make the agent behave identically on every runtime (long-lived
cli/browser-worker and rebuilt-per-turn http/ws), give every host the same
user-visible command surface routed through one SDK, delete the accidental runtime
gates, and back it all with coverage at the right level. The runtime matrix exists
to prove cross-runtime uniformity — divergence is a bug class, not a fact to
document.

**Outcome:** one command-logic source (`BodhiPiClient`), functional parity across
hosts (rendering stays per-runtime), consistent session hydration, a complete +
canonical event-forwarding surface, and a green trunk after each batch.

## Locked decisions (from review feedback)

1. Keep the **3 client dispatchers** (cli-REPL, cli-headless, browser-family — they
   test bodhi-pi from different angles; duplication across them is acceptable). Do
   NOT build one shared command engine.
2. Route **all three through `BodhiPiClient`** (`src/client/client.ts`); the
   browser-family stops calling `conn.extMethod(EXT_*)` directly.
3. **Fill the command-surface gaps** so every host exposes the same commands
   (functional parity; terminal/XML/React rendering stays per-runtime).
4. Shared **dispatch helpers live in `test-apps/app-utils/`** (string formatters),
   not the published SDK. The SDK stays the runtime-neutral command-logic source.
5. **Cross-runtime state consistency** via persisted+replayed `SessionEntry`
   (mirror the `mcp_inclusion_set` pattern). Code is source of truth; specs refresh
   last and cite `file:symbol`, never line numbers.
6. Remove accidental runtime gates; KEEP true capability boundaries (stdio spawn).
7. Tests: dedup WITHIN a level (`test/`, `e2e/`, `e2e-ui/`); KEEP cross-level
   scenario duplication (each level is a different mechanism; e2e-ui proves
   4-runtime uniformity). Sub-agent e2e/e2e-ui use `claude-haiku-4-5-20251001`.

## Validated baseline (read-confirmed 2026-05-21; corrects stale audit/draft points)

- `src/client/client.ts:BodhiPiClient` has **no** subagent methods; only
  `EXT_SUBAGENT_LIST/RUN/CHILDREN` constants exist (`src/wire/constants.ts:138-140`,
  re-exported from `src/index.ts`). `BodhiPiClient`/`createBodhiPiClient` are
  exported from `src/index.ts:3`.
- `src/client/types.ts:BodhiPiAcpConnection` is structurally a subset of ACP's
  `ClientSideConnection` → `createBodhiPiClient(conn)` over a raw
  `ClientSideConnection` is type-safe (no adapter needed).
- `test-apps/browser/src/client/lib/commands.ts:tryHandleSlash` already handles
  `/model /sessions /new /resume /close /fork /clone /mcps /mcp /agents /subagent`
  (via raw `extMethod`). **Missing** the session-management + auth subset:
  `/compact /entries /tree /goto /name /session(stats) /export /config /settings
  /login /logout /logins /delete`. Its header comment claims it avoids
  `BodhiPiClient` "to stay importable from e2e/" — **stale**: the file already
  imports from `@bodhiapp/bodhi-pi`, and e2e is blackbox and never imports it. The
  comment is removed in Batch 2.
- cli REPL `test-apps/cli/src/client/lib/commands.ts` (via `BodhiPiClient`) handles
  `/help /new /sessions /resume /close /delete /model /compact /entries /tree /goto
  /fork /clone /name /session /export /config /settings /login /logout /logins`.
  **Missing** `/mcps /mcp /agents /subagent`. Its `/session` (`:353`) = stats.
- cli headless `test-apps/cli/src/client/acp/headless.ts` (e2e driver, raw
  `client.ext`) handles `/session` (`:53` = `new|switch|list`), `/mcps /agents
  /subagent /mcp`. `/session` is overloaded vs the REPL's stats meaning.
- **Settings root cause confirmed:** `src/sessions/entries.ts:SessionEntry` has no
  settings entry; `src/sessions/build-context.ts:buildSessionContext` folds
  `model_change`/`thinking_change`/`mcp_inclusion_set` (last-on-path wins) into
  `SessionContext` but not settings; `src/sessions/session-bootstrap.ts:buildSessionState`
  re-inits `settings.sessionOverrides: {}` on every rebuild (line 322).
- `appendEntry` pattern confirmed: `src/acp/agent.ts:appendEntry` (line 310)
  auto-sets `entry.parentId = session.runtime.leafId`, appends, bumps leafId. It is
  injected into `ModelRegistry`, `McpService`, `SessionInfoService`,
  `CompactionOrchestrator`, `SubagentService` — but **not** `SettingsService`
  (constructed at `agent.ts:249` without it). `ModelRegistry.setSessionModel`
  (`registry.ts:254`) is the canonical "mutate-in-memory + append entry + emit
  event" template.
- **Event-forwarder state (corrects the draft):** `src/acp/event-wiring.ts:wireInternalEventHandlers`
  forwards only `mcp_status_change`/`mcp_tools_change`/`mcp_oauth_status_change`/
  `subagent_start`/`subagent_end` to the wire (plus `config_option_update` for
  auth/settings/model picker keys). It does **not** forward
  `branch_summary_created`/`session_navigate`/`compaction_end`/`compaction_start`.
  Host test-app forwarders: **cli already has a complete `ALL_EVENT_TYPES` array**
  (`cli/src/host/cli.ts:14-47`, 32 types); the **browser worker forwarder is also
  already complete** (`bootstrap-worker.ts:eventForwardingHandlers`, all 32 incl.
  mcp/subagent — fixed by commit `6f068467`). The **only incomplete forwarder is
  http** (`wire-agent-shared.ts:createForwardingEventHandlers`, 27 keys, **omits**
  `mcp_status_change`/`mcp_tools_change`/`mcp_oauth_status_change`/`subagent_start`/
  `subagent_end`).
- **SQLite store rename is already half-done:** `node-adapters/index.ts`
  re-exports `createMultiTenantSqliteSessionStore`, and
  `http/.../wire-agent-shared.ts:10` already imports it (`as createSqliteSessionStore`).
  Only the source `store.ts` files + the leftover alias remain (Batch 7).
- `vitest.e2e.config.ts` defines **6** projects (in-memory/cli/http/ws/browser/
  chrome-ext); `e2e/CLAUDE.md` still says "four Vitest projects" (Batch 8).
- `e2e/` is blackbox (`e2e/CLAUDE.md`): no `test-apps/` or `@bodhiapp/bodhi-pi-*`
  imports; Node adapters are duplicated under `e2e/helpers/node-adapters/`
  (exists: `filesystem.ts`, `index.ts`) in lockstep. `createTestHarness` already
  accepts + forwards `terminal` (`test/helpers/harness.ts:28,70`); the in-memory
  e2e harness (`e2e/helpers/in-memory/harness.ts`) injects a default
  `scriptExecutor` but no terminal. `test-apps/app-utils/just-bash-terminal.ts:createJustBashTerminal`
  is the runtime-neutral Terminal-over-`Filesystem` builder.

## Batch flow & dependencies

```
            ┌─────────────────────────────────────────────┐
 Batch 3 ───┤ bash on in-memory (independent; any time)    │
            └─────────────────────────────────────────────┘

 Batch 1 ──► Batch 2 ──► Batch 4 ──► Batch 5 ──► Batch 6 ──► Batch 7 ──► Batch 8
 settings    SDK routing  lifecycle   source      test        haiku +     spec
 persist     + cmd parity wiring +    health      arch        renames     refresh
   │            │         casts         │           │            │        (LAST)
   │            │           │           │           │            │
   └─ B2 needs B1   B4 needs B1   B5 needs B4   B6 needs B2+B4   B7 needs B6
                                                          B8 needs ALL
```

Batch 1 data flow (the root-cause fix):

```
/settings set foo bar --session
   └─► SettingsService.handleSettingsSet (scope==="session")
         ├─ mutate session.settings.sessionOverrides   (in-memory, unchanged)
         ├─ appendEntry(settings_change{key,value,op})  (NEW → SessionStore)
         └─ emit settings_change domain event           (unchanged)
                                  │
        ── per-turn rebuild / worker reload ──
                                  ▼
   rehydrateSession → buildSessionContext folds settings_change entries
        → SessionContext.sessionOverrides
        → buildSessionState seeds settings.sessionOverrides   ← survives rebuild
```

## Safety net per batch

Each batch ends green then commits. Behavioral/cross-cutting batches run the full
trio: `npm test` + `just test-e2e` + `just test-e2e-ui`. Source-only batches run
`npm test` + scoped `just test-e2e`; the doc/spec batch runs `npm test` +
`npm run check`. Commit per atomic-commit-with-reset; the husky pre-commit hook
runs `npm run check` (biome + host/client seam + browser-smoke).

---

## Batch 1 — Session-scope settings persistence (root cause)

**Goal:** session-scope settings survive per-turn rebuild + worker reload by
persisting/replaying a settings `SessionEntry`, mirroring `mcp_inclusion_set`.

**Changes:**
- `src/sessions/entries.ts` — add `SettingsChangeEntry`
  (`type:"settings_change"`, `key:string`, `value:unknown`, `op:"set"|"unset"`) to
  the `SessionEntry` union. Note: the entry shares the name of the existing
  `settings_change` *domain event* (`src/events/types.ts:SettingsChangeEvent`); they
  live in separate type spaces (event ≠ entry), exactly as `model_select` (event)
  pairs with `model_change` (entry). Keep both. `op` is the persisted twin of the
  event's `reason`.
- `src/sessions/build-context.ts` — add `sessionOverrides: BodhiPiProjectSettings`
  to `SessionContext`; in the path loop, fold `settings_change` entries in path
  order (`op:"set"` → `setAt`, `op:"unset"` → `unsetAt` on the dotted key) reusing
  `src/settings/settings-writer.ts` (`setAt`/`unsetAt`/`parseDottedKey`) so nested
  keys round-trip identically to live writes. Return it from both the empty-path
  early return and the main return.
- `src/sessions/session-bootstrap.ts` — `rehydrateSession` returns the replayed
  `sessionOverrides`; `buildSessionState` takes an **optional**
  `sessionOverrides?: BodhiPiProjectSettings` arg (default `{}`, so `newSession` and
  `src/subagents/build-child-state.ts` stay untouched) and seeds
  `settings.sessionOverrides` from it instead of the hardcoded `{}` (line 322).
  Update `src/sessions/session-state.ts:SettingsState` doc ("in-memory only" →
  "in-memory; persisted+replayed via `settings_change` entries").
- `src/settings/settings-service.ts` — add `appendEntry: AppendEntry` to
  `SettingsServiceDeps` (import the `AppendEntry` type from
  `src/models/registry.ts`); wire `appendEntry: this.appendEntry.bind(this)` at the
  `SettingsService` construction site (`src/acp/agent.ts:249`). In
  `handleSettingsSet`/`handleSettingsUnset`, when `scope==="session"`, after the
  in-memory `setAt`/`unsetAt`, call `this.appendEntry(sessionId, session,
  {type:"settings_change", id: randomUUID(), timestamp: Date.now(), key,
  value: <value | null>, op})` (parentId is auto-set by `appendEntry`). Keep the
  existing in-memory mutation AND the `settings_change` domain-event emit.

**Scope note (deliberate):** do **not** add a new `settings_change`
LIFECYCLE_EVENT_METHOD wire-forward in `event-wiring.ts`. The root-cause fix is
persistence+replay; the existing `config_option_update` path for picker keys is
unchanged. settings_change is not an mcp/subagent lifecycle event, and adding a new
wire contract would conflate concerns. (The test-app http/browser forwarders
already forward every event including settings_change for e2e visibility; that is
independent of the core wire surface.)

**Tests:**
- `test/settings-persistence.test.ts` (faux provider, no LLM): set a session-scope
  key → rebuild the agent over the same `sessionStore` → `resumeSession` → read
  back via `client.settings.get`; assert the override survived and that a
  `settings_change` entry was appended (assert against `sessionStore`); assert a
  dotted/nested key round-trips.
- Remove the `if (!isRuntime("http"))` gate in `e2e/shared/settings.e2e.ts:61` and
  the matching gate in `e2e/shared/sessions.e2e.ts:63` (explicit `resumeSession`
  now uniform); reword the stale comments.

**Gate:** full trio. **Deps:** none. **Highest risk** (see below).

## Batch 2 — Route 3 dispatchers through the SDK + command-surface parity

**Goal:** every dispatcher drives bodhi-pi via `BodhiPiClient`; all hosts expose
the same surface.

**Changes:**
- `src/client/client.ts:BodhiPiClient` — add `runSubagent`, `listSubagents`,
  `subagentChildren` methods (→ `EXT_SUBAGENT_RUN/LIST/CHILDREN`); add their
  param/result types to `src/client/types.ts`; re-export from `src/index.ts`.
- `test-apps/app-utils/command-format.ts` (new) — runtime-neutral string
  formatters (`formatTree`/`formatEntries`/`formatStats`/`formatConfig`/
  `formatMcpList`/`formatSubagentRun`) reused by cli + browser. (Formatters only —
  no command logic; per locked decision 4.)
- Browser-family `test-apps/browser/src/client/lib/commands.ts` — `SlashContext`
  carries `client: BodhiPiClient` (built once in `react/AppShell.tsx:onComposerSend`
  via `createBodhiPiClient(connRef.current)`); replace every
  `conn.extMethod`/`conn.setSessionConfigOption` with the SDK method (keep the OAuth
  two-path race + every `data-*` attr the e2e-ui specs assert); ADD the missing
  session-management + auth commands via SDK + formatters; **remove the stale
  "not the publishable BodhiPiClient" header comment**.
- cli REPL `test-apps/cli/src/client/lib/commands.ts` — ADD `/mcps /mcp* /agents
  /subagent` via SDK methods (`mcpList`/`mcpConnect`/…/`listSubagents`/`runSubagent`/
  `subagentChildren`); keep REPL `/session` = stats.
- cli headless `test-apps/cli/src/client/acp/headless.ts` — replace raw
  `client.ext("_bodhi-pi/subagent/*")` with the new SDK methods; extend to the full
  surface; keep its XML renderer + `/session new|switch|list`.

**Tests:** `src/client/client.test.ts` asserting the 3 new methods hit the right
`EXT_*`; `e2e-ui/shared/*.spec.ts` (Playwright × 4 runtimes) for each newly
browser-exposed command, modeled on `e2e-ui/shared/session-tree.spec.ts` +
`e2e-ui/pages/ChatPanel.ts`; `e2e/cli-headless/*.e2e.ts` for the headless-driver
commands. Keep cross-level duplication.

**Gate:** full trio. **Deps:** Batch 1 (so `/settings` is uniform under e2e-ui).

## Batch 3 — bash on every runtime (remove the in-memory gate)

**Goal:** delete the only accidental gate (independent — schedule any time).

**Changes:** add lockstep copies `e2e/helpers/node-adapters/just-bash-terminal.ts`
(+ `just-bash-fs-adapter.ts`) mirroring `test-apps/app-utils/just-bash-terminal.ts`
+ `just-bash-fs-adapter.ts`; in `e2e/helpers/in-memory/harness.ts:createInMemoryHarness`,
build `createJustBashTerminal(Bash, { filesystem, defaultCwd: cwd })` (import `Bash`
from `just-bash`) and pass `terminal` into `createTestHarness` the same way
`scriptExecutor` is injected. Note the new lockstep copies in `e2e/CLAUDE.md`.
Remove `runIf(!isRuntime("in-memory"))` from `e2e/shared/bash.e2e.ts:17` and reword
its comment.

**Tests:** existing `e2e/shared/bash.e2e.ts` now runs on all 6 vitest projects.
**Gate:** `npm test` + `just test-e2e`. **Deps:** none.

## Batch 4 — Lifecycle-event wiring uniformity + wire/in-process coverage

**Goal:** canonical, complete wire-translation surface; close wire-test gaps.

**Changes:**
- `src/acp/event-wiring.ts:wireInternalEventHandlers` — forward
  `branch_summary_created`/`session_navigate`/`compaction_end`/`compaction_start`
  (matches the `acp.md` `ED-->>C` diagrams + the both-rails rule). Replace the five
  `e as unknown as Record<string,unknown>` casts with one typed
  `lifecycleParams(event)` mapper.
- Canonicalize host enumerations: **move** the existing complete `ALL_EVENT_TYPES`
  array from `cli/src/host/cli.ts:14-47` into `test-apps/app-utils/` and export a
  `buildForwardingEventHandlers(post)` helper from there; consume it in
  `cli/src/host/cli.ts`, `http/src/host/agent/wire-agent-shared.ts` (this **fixes
  the http omission** of the 5 mcp/subagent events), and
  `browser/src/host/runtime/bootstrap-worker.ts` (already complete — swap to the
  shared builder so it can't drift). Add a `satisfies`-against-`BodhiPiEvent["type"]`
  compile guard so a new event fails to compile until it is listed.
- Other casts at the same boundary: `src/mcp/mcp-tool-adapter.ts` (`as unknown as
  AgentTool`), `src/mcp/mcp-oauth-state-kv.ts` + `src/mcp/mcp-oauth-provider.ts`
  (`as JsonValue` — tighten `serializeMcpServerEntry`'s return type),
  `src/mcp/mcp-client.ts` (remote MCP `inputSchema`/`content`); drop the redundant
  `as KnownProvider` in `src/models/registry.ts:145` (`getProviders()` already
  yields `KnownProvider[]`).

**Tests:** `test/` wire assertions (`harness.extNotifications`) for
`mcp_status_change`/`mcp_tools_change`/`mcp_oauth_status_change` (incl. the
`sessionId===""` oauth edge); `recorder()` assertions in `test/compaction.test.ts`
+ `test/branch-summary.test.ts` (reason discriminant + `compaction_end` failure
`errorMessage`) and for the now-forwarded events.

**Gate:** full trio (host-enum swap touches all 3 bootstraps). **Deps:** Batch 1.

## Batch 5 — Source health + guard consolidation

**Goal:** dead code, dup guards, magic numbers, long method.

**Changes:** delete `src/acp/agent.ts:_resolveProviderStreamOptions` (dead; exact
dup of `src/models/registry.ts:resolveProviderStreamOptions`) + trim the now-unused
`ProviderOptionsEntry`/`ResolvedRetryOptions`/`BodhiPiProjectSettings` imports;
extract one `requireKvStore(kv, method)` shared by `src/mcp/mcp-store.ts:requireKv`
+ `src/kv/kv-service.ts:requireKvStore`; name the `160` cap in
`src/subagents/subagent-service.ts` and the `4800` per-image estimate in
`src/sessions/compaction.ts:estimateTokens`; decompose
`src/subagents/subagent-service.ts:spawn` (extract `appendLinkEntry`/
`appendCompleteEntry`/`deriveStatus`); dedup the thinking-level cascade between
`src/sessions/session-bootstrap.ts:buildSessionState` and
`src/subagents/build-child-state.ts` into one helper.

**Gate:** `npm test` + scoped `just test-e2e` (subagents + compaction).
**Deps:** Batch 4.

## Batch 6 — Test architecture

**Goal:** rename, fixture promotion, brittle assertions, scenario rename.

**Changes:** rename `test/subagents-llm-invocation.test.ts` →
`test/subagents-schema-rejection.test.ts`; promote `test/helpers/faux-provider.ts`
(the `providers=[]`/`beforeEach`/`afterEach`/`newProvider()` boilerplate repeated
across ~14 `test/subagents-*.test.ts`) and adopt it; tighten `test/compaction.test.ts`
(assert the appended `CompactionEntry` + `firstKeptEntryId` resolving to a real
entry) and `test/name-stats-export.test.ts` (exact seeded counts, not `>=2`); rename
`scenarios/subagents-batch/` → `scenarios/subagents-parallel/` + update both call
sites (`e2e/shared/subagents-parallel.e2e.ts` `loadScenarioFiles`,
`e2e-ui/shared/subagents-parallel.spec.ts` `scenarioSeedXml`). Add the
aimock-OK-in-e2e / faux-preferred-in-`test/` split to `CLAUDE.md` + `DEVELOPMENT.md`.

**Gate:** `npm test`; `just test-e2e` + `just test-e2e-ui` for the scenario rename.
**Deps:** Batches 2 + 4.

## Batch 7 — e2e haiku + adapter naming + comments

**Goal:** sub-agent model standardization, swap-parity naming, comment cleanup.

**Changes:** switch `e2e/shared/{subagents,subagents-builtin,subagents-fork,
subagents-list}.e2e.ts` and `e2e-ui/shared/subagents-parallel.spec.ts` to
`claude-haiku-4-5-20251001` (`e2e-ui/helpers/prompts.ts:SWITCH_TARGET_MODEL`
already = haiku) and tighten the loosened parallel-count assertion. Finish the
SQLite store rename: in `test-apps/node-adapters/sessions/{multi,single}-tenant/store.ts`
rename the exported `createSqliteSessionStore` → `create{Multi,Single}TenantSqliteSessionStore`
at source, drop the `node-adapters/index.ts` re-alias, and simplify the import in
`http/.../wire-agent-shared.ts:10` (drop `as createSqliteSessionStore`; it already
imports the multi-tenant name). Comment cleanup (necessity rule): reword stale
slice/plan/PR refs (`src/mcp/mcp-oauth-provider.ts`, `test/helpers/env.ts`,
`test-apps/http/src/host/acp/{handler,inflight}.ts`,
`test-apps/http/src/host/server.ts`, `test-apps/node-adapters/kv-store.test.ts`,
`e2e/shared/mcp-session-resume.e2e.ts`); delete restating comments; strip
step-narration; collapse the `// === Foo ===` banners in `src/events/types.ts`,
`src/events/dispatcher.ts`, `src/client/types.ts` to only those marking a
non-obvious grouping.

**Gate:** full trio (haiku is a real-LLM change; rename touches the http build).
**Deps:** Batch 6.

## Batch 8 — Spec refresh (lands LAST)

**Goal:** regenerate specs against corrected code; encode new rules. All under
`ai-docs/specs/bodhi-pi/`.

**Changes:** rewrite `testing.md` (per-host e2e dirs + `browser/src/ui-lib` that
don't exist → centralized `e2e/{shared,cli-headless}` + `e2e-ui/shared`); fix
`client-sdk-seed.md` pre-split paths + the new SDK routing/subagent methods; fix
`mcp.md` store path → `test-apps/http/src/host/mcp/server-mcp-store.ts`; purge all
numeric line cites → `file:symbol` across the ~10 affected specs + encode the rule
in `CLAUDE.md`; `e2e/CLAUDE.md` "four Vitest projects" → six; add `settings_change`
to the `lifecycle.md` SessionEntry table; reconcile `hosts.md` adapter table +
`PARITY.md` real parity; add the sub-agent-haiku exception + aimock/faux split to
`CLAUDE.md`. Create `e2e/SKIPPED.md` + `e2e-ui/SKIPPED.md` documenting the one
residual gate (stdio spawn) + PARITY deferrals as a
`spec/test | gate | runs-on/skips-on | reason` table.

**Gate:** `npm test` + `npm run check`. **Deps:** all.

---

## Highest risk + mitigation

**Batch 1.** It adds a persisted `SessionEntry`, changes the `buildSessionContext`
replay every rebuild depends on, and threads a new arg through `buildSessionState`
(used by new/load/resume AND child builds). Mitigate: mirror the proven
`mcp_inclusion_set` path exactly; make the `buildSessionState` `sessionOverrides`
arg **optional** (only `rehydrateSession` passes replayed values); land the
`test/` rebuild→resume→read-back proof BEFORE flipping any e2e gate; keep both the
in-memory mutation and the persisted entry; verify dotted-key replay uses the same
`setAt`/`unsetAt`/`parseDottedKey` as live writes so nested keys round-trip.

## Do NOT touch (intentional)

- The `@earendil-works/pi-agent-core/dist/agent.js` deep import (browser-bundle
  safety) and the runtime-gated `await import(".../stdio.js")` in `mcp-client.ts`.
- `supportsMcpStdio` gating + the `e2e/shared/mcp-stdio.e2e.ts` `runIf` partition —
  the `-32601` rejection IS the consistent contract for an unsupportable capability.
- The `// seam-exception:` markers (e.g. `cli/src/host/cli.ts:8`); the Host/Client
  seam (shared symbols go to `app-utils/`, never behind a new exception).
- Cross-LEVEL test duplication (same scenario at `test/`/`e2e/`/`e2e-ui/`).
- The 3 client dispatchers themselves (route through SDK + share string formatters
  only; no shared command engine).
- Out of scope: deprecated top-level `packages/bodhi-pi-*` and
  `packages/coding-agent`; no new code comments.

## Verification

- Per batch: `npm test` (vitest unit/integration), then `just test-e2e` (6 vitest
  projects: in-memory/cli/http/ws/browser/chrome-ext, real LLM) and
  `just test-e2e-ui` (Playwright × 4 runtimes) for behavioral batches; `npm run
  check` always runs in the husky pre-commit hook.
- Uniformity acceptance: after Batch 1, `settings.e2e.ts` + `sessions.e2e.ts` pass
  with no `!isRuntime("http")` gate; after Batch 2, the same `e2e-ui/shared/*.spec.ts`
  command scenarios pass on all four Playwright runtimes; after Batch 3,
  `bash.e2e.ts` passes on in-memory; after Batch 4, the http forwarder emits the
  full `BodhiPiEvent` set and `test/` wire assertions cover the mcp/subagent +
  compaction/branch-summary events.
- Final: zero `runIf`/`test.skip` in `e2e/`+`e2e-ui/` except the stdio capability
  partition; `e2e/SKIPPED.md` + `e2e-ui/SKIPPED.md` document only that;
  `npm run check` green; specs contain no numeric line cites.