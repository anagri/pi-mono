# bodhi-pi uniformity + audit-fix plan

## Context

The 2026-05-21 full-tree audit (`ai-docs/reviews/2026-05-21-full-tree-audit.md`)
surfaced that bodhi-pi's four reference runtimes diverge in ways that are not
forced by the runtime: the three client dispatchers expose different command
sets and reach the agent three different ways (cli REPL via the `BodhiPiClient`
SDK, cli headless via raw `client.ext(...)`, browser/http/chrome-ext via raw
`conn.extMethod(...)` bypassing the SDK entirely); session-scope settings are
lost under http/ws per-turn rebuild because they live only in memory while
`model_change`/`thinking_change`/`mcp_inclusion_set` persist as `SessionEntry`
and replay; and several e2e gates (`!isRuntime("http")`, `test.skip(!inProcess)`,
`runIf(!in-memory)`) document divergence instead of fixing it.

**Goal:** make the agent behave identically on every runtime (long-lived cli/
browser-worker and rebuilt-per-turn http/ws), give every host the same
user-visible command surface routed through one SDK, delete the accidental
runtime gates, and back it all with coverage at the right level. The runtime
matrix exists to prove cross-runtime uniformity — divergence is a bug class, not
a fact to document.

**Outcome:** one command-logic source (`BodhiPiClient`), functional parity across
hosts (rendering stays per-runtime), consistent session hydration, a complete +
canonical event-forwarding surface, and a green trunk after each batch.

## Locked decisions (from review feedback)

1. Keep the **3 client dispatchers** (they test bodhi-pi from different angles;
   duplication across them is acceptable). Do NOT build one shared command engine.
2. Route **all three through `BodhiPiClient`** (`src/client/client.ts`); the
   browser-family stops calling `conn.extMethod(EXT_*)` directly.
3. **Fill the command-surface gaps** so every host exposes the same commands
   (functional parity; terminal/XML/React rendering stays per-runtime).
4. Shared **dispatch helpers live in `test-apps/app-utils/`** (string formatters),
   not the published SDK. The SDK stays the runtime-neutral command-logic source.
5. **Cross-runtime state consistency** via persisted+replayed `SessionEntry`
   (mirror the `mcp_inclusion_set` pattern). Code is source of truth; specs
   refresh last and cite `file:symbol`, never line numbers.
6. Remove accidental runtime gates; KEEP true capability boundaries (stdio spawn).
7. Tests: dedup WITHIN a level (`test/`, `e2e/`, `e2e-ui/`); KEEP cross-level
   scenario duplication (each level is a different mechanism; e2e-ui proves
   4-runtime uniformity). Sub-agent e2e/e2e-ui use `claude-haiku-4-5-20251001`.

## Validated baseline (read-confirmed; corrects stale audit points)

- `src/client/client.ts:BodhiPiClient` has **no** subagent methods (only
  `EXT_SUBAGENT_*` constants exist) — they must be added.
- `test-apps/browser/src/client/lib/commands.ts:tryHandleSlash` **already** has
  `/model /sessions /new /resume /close /fork /clone /mcps /mcp /agents /subagent`
  (via raw `extMethod`). It is **missing** the session-management + auth subset:
  `/compact /entries /tree /goto /name /session(stats) /export /config /settings
  /login /logout /logins /delete`.
- Root cause confirmed: `src/sessions/entries.ts:SessionEntry` has no
  `settings_change`; `src/sessions/build-context.ts:buildSessionContext` folds
  `model_change`/`thinking_change`/`mcp_inclusion_set` (last-on-path wins) but not
  settings; `src/sessions/session-bootstrap.ts:buildSessionState` re-inits
  `sessionOverrides: {}` every rebuild.
- Host event forwarders are genuinely divergent (canonical union = the
  `src/events/types.ts` `BodhiPiEvent` set): the http
  `test-apps/http/src/host/agent/wire-agent-shared.ts:createForwardingEventHandlers`
  omits the 5 MCP/subagent lifecycle events (masked because
  `src/acp/event-wiring.ts:wireInternalEventHandlers` forwards them independently);
  the browser `bootstrap-worker.ts` list omits `session_start`/`session_shutdown`/
  `agent_start`.
- `e2e/` is a blackbox tree that must NOT import `test-apps/` or `@bodhiapp/
  bodhi-pi-*` (`e2e/CLAUDE.md`); shared adapters are duplicated under
  `e2e/helpers/` in lockstep.
- `acp.md` already draws `ED-->>C` for `branch_summary_created`/`session_navigate`/
  `compaction_end` (emitted but not forwarded) → forward them (no arrow deletion).

## Safety net per batch

Each batch ends green then commits. Behavioral/cross-cutting batches run the full
trio: `npm test` + `just test-e2e` + `just test-e2e-ui`. Source-only batches run
`npm test` + scoped `just test-e2e`; the doc/spec batch runs `npm test` +
`npm run check`. Commit per [[atomic-commit-with-reset]]; the husky hook runs
`npm run check` ([[bodhi-pi-commit-gate]]).

---

## Batch 1 — Session-scope settings persistence (root cause)

**Goal:** session-scope settings survive per-turn rebuild + worker reload by
persisting/replaying a `settings_change` `SessionEntry`, mirroring
`mcp_inclusion_set`.

**Changes:**
- Add `SettingsChangeEntry` (`type:"settings_change"`, `key`, `value`, `op`) to
  `src/sessions/entries.ts:SessionEntry`.
- `src/sessions/build-context.ts:buildSessionContext` — add `sessionOverrides` to
  `SessionContext`; fold `settings_change` entries in path order (set/unset per
  dotted key) reusing `src/settings/settings-writer.ts` (`setAt`/`unsetAt`/
  `parseDottedKey`).
- `src/sessions/session-bootstrap.ts` — `rehydrateSession` returns replayed
  overrides; `buildSessionState` takes an **optional** `sessionOverrides`
  (default `{}`, so `newSession` + `src/subagents/build-child-state.ts` are
  untouched) and seeds `settings.sessionOverrides`. Update
  `src/sessions/session-state.ts:SettingsState` doc.
- `src/settings/settings-service.ts:SettingsService` — add `appendEntry` to its
  deps (wire `this.appendEntry` at construction in `src/acp/agent.ts`, same shape
  as registry/mcp-store); in `handleSettingsSet`/`handleSettingsUnset`, when
  `scope==="session"`, append a `settings_change` entry (mirror
  `src/models/registry.ts:setSessionModel`). Keep the in-memory mutation AND the
  existing `settings_change` domain-event emit.
- Forward `settings_change` to the wire in `src/acp/event-wiring.ts` (through the
  typed mapper added in Batch 4).

**Tests:** `test/settings-persistence.test.ts` (faux, no LLM): set session-scope
key → rebuild agent over same `sessionStore` → `resumeSession` → read back;
assert the entry appended + folded; add a `harness.extNotifications` assertion for
the wire notification. Remove the `!isRuntime("http")` gates in
`e2e/shared/settings.e2e.ts` and `e2e/shared/sessions.e2e.ts`.

**Gate:** full trio. **Deps:** none. **Highest risk** (see below).

## Batch 2 — Route 3 dispatchers through the SDK + command-surface parity

**Goal:** every dispatcher drives bodhi-pi via `BodhiPiClient`; all hosts expose
the same surface.

**Changes:**
- Add SDK methods to `src/client/client.ts:BodhiPiClient`: `runSubagent`,
  `listSubagents`, `subagentChildren` (→ `EXT_SUBAGENT_RUN/LIST/CHILDREN`); add
  param/result types to `src/client/types.ts`; re-export from `src/index.ts`.
- New `test-apps/app-utils/command-format.ts` — runtime-neutral string
  formatters (`formatTree`/`formatEntries`/`formatStats`/`formatConfig`/
  `formatMcpList`/`formatSubagentRun`) reused by cli + browser.
- Browser-family `test-apps/browser/src/client/lib/commands.ts` — `SlashContext`
  carries `client: BodhiPiClient` (built once in
  `react/AppShell.tsx:onComposerSend` via `createBodhiPiClient(connRef.current)`);
  replace every `conn.extMethod`/`conn.setSessionConfigOption` with the SDK
  method (keep the OAuth two-path race + `data-*` attrs); ADD the missing
  session-management + auth commands via SDK + formatters.
- cli REPL `test-apps/cli/src/client/lib/commands.ts:handleCommand` — ADD `/mcps
  /mcp* /agents /subagent` via the new SDK methods; resolve the `/session`
  overload (REPL `/session` = stats; registry verbs stay in headless).
- cli headless `test-apps/cli/src/client/acp/headless.ts:tryHandleSlash` (the e2e
  driver) — replace raw `client.ext("_bodhi-pi/subagent/*")` with SDK methods;
  extend to the **full** surface; keep its XML renderer + `/session new|switch|list`.

**Tests:** `e2e-ui/shared/*.spec.ts` (Playwright × 4 runtimes) for each newly
browser-exposed command, modeled on `e2e-ui/shared/session-tree.spec.ts` +
`e2e-ui/pages/ChatPanel.ts`; `e2e/cli-headless/*.e2e.ts` for the headless-driver
commands; `src/client/client.test.ts` asserting the 3 new methods hit the right
`EXT_*`. Keep cross-level duplication.

**Gate:** full trio. **Deps:** Batch 1 (so `/settings` is uniform under e2e-ui).

## Batch 3 — bash on every runtime (remove the in-memory gate)

**Goal:** delete the only accidental gate.

**Changes:** inject a just-bash `Terminal` into
`e2e/helpers/in-memory/harness.ts:createInMemoryHarness` the way it already
injects `scriptExecutor`. Since `e2e/` cannot import `test-apps/app-utils`, add a
lockstep copy `e2e/helpers/node-adapters/just-bash-terminal.ts` (+ fs-adapter)
mirroring `test-apps/app-utils/just-bash-terminal.ts:createJustBashTerminal`;
import `Bash` from `just-bash`; pass `terminal` into `createTestHarness`. Note the
new lockstep copy in `e2e/CLAUDE.md`. Remove `runIf(!isRuntime("in-memory"))` from
`e2e/shared/bash.e2e.ts`.

**Tests:** existing `e2e/shared/bash.e2e.ts` now runs on all 6 vitest projects.
**Gate:** `npm test` + `just test-e2e`. **Deps:** none.

## Batch 4 — Lifecycle-event wiring uniformity + wire/in-process coverage

**Goal:** canonical, complete wire-translation surface; close wire-test gaps.

**Changes:**
- Forward `branch_summary_created`/`session_navigate`/`compaction_end`
  (+`compaction_start`) in `src/acp/event-wiring.ts:wireInternalEventHandlers`
  (matches the `acp.md` diagrams + both-rails rule).
- Replace the five `e as unknown as Record<string,unknown>` casts in
  `event-wiring.ts` with one typed `lifecycleParams(event)` mapper.
- Canonicalize host enumerations: export `ALL_EVENT_TYPES` +
  `buildForwardingEventHandlers(post)` from `test-apps/app-utils/`; consume in
  `cli/src/host/cli.ts`, `http/src/host/agent/wire-agent-shared.ts`,
  `browser/src/host/runtime/bootstrap-worker.ts`. Add a `satisfies`-against-the-
  `BodhiPiEvent`-union compile guard so a new event fails to compile until listed.
- Other casts at the same boundary: `src/mcp/mcp-tool-adapter.ts`,
  `src/mcp/mcp-oauth-state-kv.ts` + `src/mcp/mcp-oauth-provider.ts` (tighten
  `serializeMcpServerEntry` return type), `src/mcp/mcp-client.ts`; drop redundant
  `as KnownProvider` in `src/models/registry.ts`.

**Tests:** `test/` wire assertions (`harness.extNotifications`) for
`mcp_status_change`/`mcp_tools_change`/`mcp_oauth_status_change` (incl. the
`sessionId===""` oauth edge); `recorder()` assertions in `test/compaction.test.ts`
+ `test/branch-summary.test.ts` (reason discriminant + failure `errorMessage`) and
for the now-forwarded events.

**Gate:** full trio (host-enum swap touches all 3 bootstraps). **Deps:** Batch 1.

## Batch 5 — Source health + guard consolidation

**Goal:** dead code, dup guards, magic numbers, long method.

**Changes:** delete `src/acp/agent.ts:_resolveProviderStreamOptions` (dead; dup of
`src/models/registry.ts:resolveProviderStreamOptions`) + trim its imports; extract
one `requireKvStore(kv, method)` from `src/mcp/mcp-store.ts:requireKv` +
`src/kv/kv-service.ts:requireKvStore`; name the `160` cap in
`src/subagents/subagent-service.ts` and the `4800` estimate in
`src/sessions/compaction.ts:estimateTokens`; decompose
`src/subagents/subagent-service.ts:spawn` (extract `appendLinkEntry`/
`appendCompleteEntry`/`deriveStatus`); dedup the thinking-level cascade between
`src/sessions/session-bootstrap.ts:buildSessionState` and
`src/subagents/build-child-state.ts` into one helper.

**Gate:** `npm test` + scoped `just test-e2e` (subagents + compaction). **Deps:** Batch 4.

## Batch 6 — Test architecture

**Goal:** rename, fixture promotion, brittle assertions, scenario rename.

**Changes:** rename `test/subagents-llm-invocation.test.ts` →
`test/subagents-schema-rejection.test.ts`; promote `test/helpers/faux-provider.ts`
(the `providers=[]`/`beforeEach`/`afterEach`/`newProvider()` boilerplate repeated
across ~14 `test/subagents-*.test.ts`) and adopt it; tighten
`test/compaction.test.ts` (assert the appended `CompactionEntry` +
`firstKeptEntryId`) and `test/name-stats-export.test.ts` (exact counts); rename
`scenarios/subagents-batch/` → `scenarios/subagents-parallel/` + update both call
sites. Add the aimock-OK-in-e2e / faux-preferred-in-`test/` split to `CLAUDE.md` +
`DEVELOPMENT.md` ([[bodhi-pi-e2e-strategy]]).

**Gate:** `npm test`; `just test-e2e` + `just test-e2e-ui` for the scenario rename.
**Deps:** Batches 2 + 4.

## Batch 7 — e2e haiku + adapter naming + comments

**Goal:** sub-agent model standardization, swap-parity naming, comment cleanup.

**Changes:** switch `e2e/shared/{subagents,subagents-builtin,subagents-fork,
subagents-list}.e2e.ts` and `e2e-ui/shared/subagents-parallel.spec.ts` to
`claude-haiku-4-5-20251001` (`e2e-ui/helpers/prompts.ts:SWITCH_TARGET_MODEL`
already = haiku) and tighten the loosened parallel-count assertion. Rename the
SQLite store factories at source (`test-apps/node-adapters/sessions/{multi,single}-
tenant/store.ts` both export `createSqliteSessionStore` →
`create{Multi,Single}TenantSqliteSessionStore`), drop the `node-adapters/index.ts`
re-alias, fix the import in `http/src/host/agent/wire-agent-shared.ts`. Comment
cleanup ([[no-comments-at-all]]): reword stale slice/plan/PR refs
(`src/mcp/mcp-oauth-provider.ts`, `test/helpers/env.ts`,
`test-apps/http/src/host/acp/{handler,inflight}.ts`,
`test-apps/http/src/host/server.ts`, `test-apps/node-adapters/kv-store.test.ts`,
`e2e/shared/mcp-session-resume.e2e.ts`); delete restating comments; strip
step-narration; collapse the `// === Foo ===` banners in `src/events/types.ts`,
`src/events/dispatcher.ts`, `src/client/types.ts`.

**Gate:** full trio (haiku is a real-LLM change; rename touches the http build).
**Deps:** Batch 6.

## Batch 8 — Spec refresh (lands LAST)

**Goal:** regenerate specs against corrected code; encode new rules. All under
`ai-docs/specs/bodhi-pi/` ([[specs-no-line-numbers]]).

**Changes:** rewrite `testing.md` (per-host e2e dirs + `browser/src/ui-lib` that
don't exist → centralized `e2e/{shared,cli-headless}` + `e2e-ui/shared`); fix
`client-sdk-seed.md` pre-split paths + the new SDK routing/subagent methods; fix
`mcp.md` store path → `test-apps/http/src/host/mcp/server-mcp-store.ts`; purge all
numeric line cites → `file:symbol` across the 10 affected specs + encode the rule
in `CLAUDE.md`; `e2e/CLAUDE.md` "four Vitest projects" → six; add `settings_change`
to the `lifecycle.md` SessionEntry table; reconcile `hosts.md` adapter table +
`PARITY.md` real parity; add the sub-agent-haiku exception + aimock/faux split +
[[runtime-consistency-no-skips]] note to `CLAUDE.md`. Create `e2e/SKIPPED.md` +
`e2e-ui/SKIPPED.md` documenting the one residual gate (stdio spawn) + PARITY
deferrals as a `spec/test | gate | runs-on/skips-on | reason` table.

**Gate:** `npm test` + `npm run check`. **Deps:** all.

---

## Dependency order

1 → 2 → 4 → 5 → 6 → 7 → 8, with Batch 3 insertable anywhere (independent). Batch 2
needs 1; Batch 4 needs 1; Batch 5 needs 4; Batch 6 needs 2+4; Batch 7 needs 6;
Batch 8 needs all.

## Highest risk + mitigation

**Batch 1.** It adds a persisted `SessionEntry`, changes the `buildSessionContext`
replay every rebuild depends on, and threads a new arg through `buildSessionState`
(used by new/load/resume AND child builds). Mitigate: mirror the proven
`mcp_inclusion_set` path exactly; make the `buildSessionState` `sessionOverrides`
arg **optional** (only `rehydrateSession` passes replayed values); land the `test/`
rebuild→resume→read-back proof BEFORE flipping any e2e gate; keep both the
in-memory mutation and the persisted entry; verify dotted-key replay uses the same
`setAt`/`unsetAt`/`parseDottedKey` as live writes so nested keys round-trip.

## Do NOT touch (intentional)

- The `@earendil-works/pi-agent-core/dist/agent.js` deep import (browser-bundle
  safety) and the runtime-gated `await import(".../stdio.js")` in `mcp-client.ts`.
- `supportsMcpStdio` gating + the `e2e/shared/mcp-stdio.e2e.ts` `runIf` partition —
  the `-32601` rejection IS the consistent contract for an unsupportable capability.
- The 3 `// seam-exception:` markers; the Host/Client seam (shared symbols go to
  `app-utils/`, never behind a new exception).
- Cross-LEVEL test duplication (same scenario at `test/`/`e2e/`/`e2e-ui/`).
- The 3 client dispatchers themselves (route through SDK + share string formatters
  only; no shared command engine).
- Out of scope: deprecated top-level `packages/bodhi-pi-*` and `packages/coding-agent`;
  no new code comments.

## Verification

- Per batch: `npm test` (vitest unit/integration), then `just test-e2e` (6 vitest
  projects: in-memory/cli/http/ws/browser/chrome-ext, real LLM) and
  `just test-e2e-ui` (Playwright × 4 runtimes) for behavioral batches; `npm run
  check` (biome + host/client seam) always runs in the husky pre-commit hook.
- Uniformity acceptance: after Batch 2, the same `e2e-ui/shared/*.spec.ts` command
  scenarios pass on all four Playwright runtimes; after Batch 1, `settings.e2e.ts`
  + `sessions.e2e.ts` pass with no `!isRuntime("http")` gate; after Batch 3,
  `bash.e2e.ts` passes on in-memory.
- Final: zero `runIf`/`test.skip` in `e2e/`+`e2e-ui/` except the stdio capability
  partition; `e2e/SKIPPED.md` + `e2e-ui/SKIPPED.md` document only that;
  `npm run check` green; specs contain no numeric line cites.
