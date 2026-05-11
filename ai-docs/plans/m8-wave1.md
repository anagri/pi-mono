# Wave 1 — ACP Notifications + Event Catalog Expansion

## Context

The 2026-05-11 tech-debt review (`ai-docs/reviews/2026-05-11-bodhi-pi-tech-debt.md`) flagged a stable-ACP conformance gap: the SDK ships `sessionUpdate: "config_option_update"` and `"session_info_update"` as stable variants, but bodhi-pi instead bundles `configOptions` into ext-method response payloads in four spots and silently mutates session names without any notification. The CLAUDE.md "Stable ACP over `unstable_*`" pillar is bent. At the same time, seven state-changing extension methods (auth/settings mutations, compaction, branch summary, navigate, fork, clone) emit no events, so extensions cannot react. The picker-refresh side-effect, repeated four times across handlers as ad-hoc response patching, is the visible symptom of the missing event spine.

This wave fixes both: it adds the seven missing event types, makes the agent **subscribe to its own events** to centralise the picker-refresh side-effect, and routes that side-effect through the spec-stable `config_option_update` / `session_info_update` notifications. The response-field `configOptions` is removed from the four extension responses (clean break — no dual-write); the three Node reference hosts (cli, ws-frontend, http frontend) migrate in the same series. Includes two trivia freebies: removing dead `LabelEntry` and the brittle dist-path import of `pi-agent-core`.

The intended outcome: extensions can subscribe to `auth_change`, `settings_change`, `compaction_*`, `branch_summary_created`, `session_navigate`, `session_fork`, `session_clone`. Hosts learn picker / title changes by listening to spec-native notifications, not by reading custom response fields. The agent itself routes its picker-refresh logic through the same event bus extensions use, demonstrating the pattern. Net source-code change: +~250 LOC (new events + helpers), -~100 LOC (deduped emitters + dropped response branches + dead code).

## Scope

**In:**
- 7 new lifecycle events with handlers + dispatcher emitters + tests
- `EventDispatcher` generic emitter for the 17 observation-only events (Batch E.1 from review)
- `safeRun` semantics JSDoc (Batch E.5)
- `model_select` event also fires when `defaultModel` setting changes (Batch E.3)
- `emitConfigOptionUpdate(sessionId)` + `emitSessionInfoUpdate(sessionId, ...)` private helpers wired through internal event subscribers (Batch A.1, A.2)
- Drop `configOptions` field from the four ext-method responses (BREAKING)
- Update `bodhi-pi-cli`, `bodhi-pi-ws-frontend`, `bodhi-pi-http` (frontend) to consume notifications (host parity, same series)
- Update mirror `event-recorder.ts` in core + CLI test helpers
- Remove `LabelEntry` (Batch G.1)
- Switch `pi-agent-core` import to public barrel (Batch A.3)

**Out:**
- Batch B (agent.ts dispatcher table, `requireSession` everywhere, `_buildSessionState` decomposition) — sequential follow-up
- Batch C/D (sessions module dedup) — orthogonal, separate worktree
- Batch F (capability advertisement, `EXT_SESSION_CONFIG` slimdown) — needs design discussion
- Batch H (e2e gap fills for settings/kv/sessions/thinking) — separate worktree
- `bodhi-pi-web` and `bodhi-pi-ws-server` — web has no slash UI consuming these responses; ws-server is backend only (no frontend handler to update)
- `bodhi-pi-http` server-side `model-switch.test.ts:28-50` is the only test that asserts response-field configOptions on a stable-ACP method (`setSessionConfigOption`) which is unchanged — leave it alone

## Architecture decisions (locked)

1. **Clean break on the four ext responses.** `_bodhi-pi/session/settings/{set,unset}` and `_bodhi-pi/kv/{set,remove}` stop returning `configOptions`. The notification fires inside the same agent turn before the response is sent. Hosts subscribe; no dual-write, no deprecation cycle. Keep `configOptions` on `setSessionConfigOption` (stable ACP, spec-mandated).
2. **Internal event subscriber pattern.** The agent's constructor wires its own subscriber that emits `config_option_update` whenever `auth_change`, `settings_change`, or `model_select` fires (with the `defaultModel`/`defaultThinkingLevel` filter applied inside the subscriber, not at every emission site). Demonstrates the extension pattern; collapses the four ad-hoc affectsPicker blocks into one place.
3. **Event handler registration via `EventDispatcher.appendHandlers`** — already supported (`events/dispatcher.ts:42-48`) for late-loaded extension handlers; reuse the same path for the agent's internal subscriber. No new mechanism.
4. **`session_info_update`** fires on `EXT_SESSION_SET_NAME` only (not on `newSession`/`loadSession`/`resumeSession`). Hosts that need initial title use the existing `EXT_SESSION_STATS.name` field. Kept narrow to avoid scope creep.
5. **Naming**: events use the existing `<noun>_<verb>` snake_case convention from `events/types.ts`. New event types: `auth_change`, `settings_change`, `compaction_start`, `compaction_end`, `branch_summary_created`, `session_navigate`, `session_fork`, `session_clone`.
6. **Compaction events fire from each call site** (handleSessionCompact, runProactiveCompaction, tryOverflowRecovery) with a `reason: "manual"|"proactive"|"recovery"` discriminator. Don't extract `runAndPersistCompaction` here — that's Batch B/C territory; keep this commit additive only.
7. **`model_select`-on-`defaultModel`-change** fires from inside `handleSettingsSet` when `path[0] === "defaultModel"` AND the resolved effective model id differs from `session.currentModelId`. Reuse the existing event type, not a new one — the semantic is identical.
8. **Test-recorder mirrors are kept in sync.** `packages/bodhi-pi/test/helpers/event-recorder.ts` ALL_EVENT_TYPES list (currently 19 events) expands to 26. The mirror at `packages/bodhi-pi-cli/test/helpers/event-recorder.ts` updates in lockstep.

## Implementation strategy (commit ordering)

Work proceeds in nine commits. Commits 1–3 are pure refactor/freebies. Commits 4–7 add the event spine and notifications additively. Commit 8 is the breaking change that removes the response field. Commit 9 updates the three Node reference hosts in lockstep with Commit 8 (could be split per-host if hooks balk).

### Commit 1 — chore: pi-agent-core barrel import + LabelEntry removal

- `packages/bodhi-pi/src/acp/agent.ts:38` — replace `import { Agent } from "@earendil-works/pi-agent-core/dist/agent.js"` with `import { Agent } from "@earendil-works/pi-agent-core"`. Verify the package's `exports` map exposes `Agent` from the root; if not, that fix lands in `pi-agent-core` first.
- `packages/bodhi-pi/src/sessions/entries.ts:61-65, :96` — delete `LabelEntry` interface and union arm.
- `packages/bodhi-pi/src/sessions/session-store.ts:8` — drop `LabelEntry` import.
- `packages/bodhi-pi/src/index.ts:99` — drop `LabelEntry` re-export.
- Re-grep `LabelEntry`/`type: "label"` across all packages to confirm zero consumers.

### Commit 2 — refactor(events): generic emit<T> + safeRun JSDoc

- `packages/bodhi-pi/src/events/dispatcher.ts:60-116` — replace 17 observation-only `emitX` methods with a single `private async emit<T extends keyof BodhiPiEventHandlers>(type: T, event: BodhiPiEventOf<T>): Promise<void>` plus a small typed `emitObservation(type, event)` wrapper if needed for variance.
- Keep mutation-aware emitters (`emitInput`, `emitBeforeAgentStart`, `emitBeforeProviderRequest`, `emitToolCall`, `emitToolResult`) untouched.
- Update `agent.ts` callers (`emitSessionStart` → `emit("session_start", ...)`, etc.). Roughly 30 call sites, mechanical.
- `packages/bodhi-pi/src/events/types.ts:208` — add JSDoc on `BodhiPiEventHandlers` describing `safeRun` semantics: errors caught, logged via `console.error`, peer handlers continue.
- All existing tests pass without modification (behaviour identical).

### Commit 3 — feat(events): expand catalog (types only, no callers)

Add 7 event interfaces + 7 handler-map fields + 7 union arms:
- `packages/bodhi-pi/src/events/types.ts` — add `AuthChangeEvent`, `SettingsChangeEvent`, `CompactionStartEvent`, `CompactionEndEvent`, `BranchSummaryCreatedEvent`, `SessionNavigateEvent`, `SessionForkEvent`, `SessionCloneEvent` (8 actually — fork and clone separate). Update `BodhiPiEvent` union, `BodhiPiEventType`, `BodhiPiEventHandlers`.
- `packages/bodhi-pi/src/events/dispatcher.ts` — generic emitter from Commit 2 means no per-method addition; just exposed via `emit("auth_change", ...)`.
- `packages/bodhi-pi/src/index.ts` — re-export the new event interfaces.
- `packages/bodhi-pi/test/helpers/event-recorder.ts:12-32` — extend `ALL_EVENT_TYPES` to include the 8 new entries (now 27 total).
- `packages/bodhi-pi-cli/test/helpers/event-recorder.ts` — mirror.
- No agent.ts changes; no callers fire the new events yet. Build green; recorder captures empty arrays for the new types.

### Commit 4 — feat(events): emit auth_change, settings_change, model_select-on-defaultModel

- `packages/bodhi-pi/src/acp/agent.ts:606-661` (handleSettingsSet) — after the in-memory mutation, emit `settings_change { sessionId, scope, key, value, reason: "set" }`. If `path[0] === "defaultModel"` AND the effective resolved model id changed, ALSO emit `model_select { sessionId, fromModelId, toModelId }`. Skip the `defaultThinkingLevel` case for `model_select` — that has no equivalent (the picker option just refreshes via the `config_option_update` subscriber added in Commit 7).
- `packages/bodhi-pi/src/acp/agent.ts:663-710` (handleSettingsUnset) — emit `settings_change { ..., reason: "unset", value: null }`. Same `defaultModel`-change logic.
- `packages/bodhi-pi/src/acp/agent.ts:741-762` (handleKvSet) — when `key.startsWith(AUTH_PREFIX)`, emit `auth_change { sessionId: <if provided>, provider: key.slice(AUTH_PREFIX.length), action: "login" }`. Note: `sessionId` is OPTIONAL in `KvSet` params today; mirror that — emit with `sessionId: undefined` when not provided so extensions still see auth changes from off-session writes.
- `packages/bodhi-pi/src/acp/agent.ts:791-804` (handleKvRemove) — same for `action: "logout"`.
- Tests: extend `test/settings-slash.test.ts` and `test/kv-slash.test.ts` to assert the new events appear in the recorder log with correct payloads. Use the existing harness pattern.

### Commit 5 — feat(events): emit compaction_start/end, branch_summary_created, session_navigate, session_fork, session_clone

- Compaction (3 sites): wrap each `runCompaction` call in agent.ts (`:1116`, `:1355`, `:1411`) with `emit("compaction_start", { sessionId, reason })` before and `emit("compaction_end", { sessionId, reason, summary, firstKeptEntryId, tokensBefore, error? })` after (in both success and catch paths). `reason` is one of `"manual"`/`"proactive"`/`"recovery"`.
- Branch summary: `agent.ts:984-996` — emit `branch_summary_created { sessionId, abandonedTailLeafId: oldLeaf, commonAncestorId: cross.commonAncestorId, summary }` after the entry is persisted.
- Navigate: `agent.ts:960-1021` (handleSessionNavigate) — emit `session_navigate { sessionId, fromLeafId: oldLeaf, toLeafId: targetEntryId, crossedBranches: !!cross }` at the end of the success path.
- Fork: `agent.ts:1043-1074` (handleSessionFork) — after `forkRecord` returns, emit `session_fork { sessionId: <parent>, newSessionId, fromEntryId: entryId, position }`.
- Clone: `agent.ts:1076-1090` (handleSessionClone) — after `forkRecord`, emit `session_clone { sessionId: <parent>, newSessionId, fromLeafId: leafId }`.
- Tests: extend `test/compaction.test.ts`, `test/auto-compact.test.ts`, `test/overflow-recovery.test.ts`, `test/branch-summary.test.ts`, `test/tree-navigate.test.ts`, `test/fork-clone.test.ts` to assert the new events fire with correct payloads.

### Commit 6 — feat(acp): add emitConfigOptionUpdate + emitSessionInfoUpdate helpers (unwired)

- `packages/bodhi-pi/src/acp/agent.ts` — add two private async helpers:
  ```ts
  private async emitConfigOptionUpdate(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const configOptions = await this.buildAllConfigOptions(sessionId);
    await this.conn.sessionUpdate({
      sessionId,
      update: { sessionUpdate: "config_option_update", configOptions },
    });
  }

  private async emitSessionInfoUpdate(sessionId: string, name: string | null, updatedAt: string | null): Promise<void> {
    await this.conn.sessionUpdate({
      sessionId,
      update: { sessionUpdate: "session_info_update", title: name, updatedAt },
    });
  }
  ```
- Verify SDK union has both members (already confirmed at `/tmp/acp-sdk-inspect/package/dist/schema/types.gen.d.ts:4347-4350`).
- No callers wired yet — pure additive surface. Build green.

### Commit 7 — feat(acp): wire internal event subscribers + session_info notification

- `packages/bodhi-pi/src/acp/agent.ts` constructor (`:247-255`) — after `this.events = new EventDispatcher(...)`, register internal subscribers:
  ```ts
  this.events.appendHandlers("auth_change", [async (e) => {
    if (e.sessionId) await this.emitConfigOptionUpdate(e.sessionId);
  }]);
  this.events.appendHandlers("settings_change", [async (e) => {
    if (e.key === "defaultModel" || e.key.startsWith("defaultModel.") || e.key === "defaultThinkingLevel" || e.key.startsWith("defaultThinkingLevel.")) {
      await this.emitConfigOptionUpdate(e.sessionId);
    }
  }]);
  this.events.appendHandlers("model_select", [async (e) => {
    await this.emitConfigOptionUpdate(e.sessionId);
  }]);
  ```
- `agent.ts:849-870` (handleSessionSetName) — after `appendEntry` succeeds, call `await this.emitSessionInfoUpdate(sessionId, name, new Date(timestamp).toISOString())`.
- Existing `model_select` emission at `agent.ts:1197` (setSessionConfigOption path) now triggers `config_option_update` notification automatically via the subscriber. The response field on `setSessionConfigOption` continues to carry `configOptions` (spec-mandated).
- Tests: assert `config_option_update` notification arrives at the client side after `/login`, `/logout`, `/settings set defaultModel`, `/settings set defaultThinkingLevel`, and `setSessionConfigOption`. Use the harness's update-recorder. Assert `session_info_update` arrives after `/name`.

### Commit 8 — feat(acp)!: drop configOptions from ext responses (BREAKING)

- `packages/bodhi-pi/src/acp/agent.ts:649-660` — remove the `affectsPicker`/`configOptions` block from `handleSettingsSet` return.
- `packages/bodhi-pi/src/acp/agent.ts:699-709` — same for `handleSettingsUnset`.
- `packages/bodhi-pi/src/acp/agent.ts:753-761` — remove the `AUTH_PREFIX` block from `handleKvSet` (response collapses to `{ key, secret }`).
- `packages/bodhi-pi/src/acp/agent.ts:797-803` — same for `handleKvRemove` (collapses to `{ key }`).
- Update existing tests that asserted `result.configOptions` from these methods (`test/settings-slash.test.ts:220`, `test/kv-slash.test.ts:4` and similar) to instead assert the `config_option_update` notification appeared (Commit 7's tests already do this; here we just remove the now-incorrect response-field assertions).
- `packages/bodhi-pi/CHANGELOG.md` — add entry under unreleased: BREAKING — `configOptions` removed from `_bodhi-pi/session/settings/{set,unset}` and `_bodhi-pi/kv/{set,remove}` responses; subscribe to `sessionUpdate: "config_option_update"`.

### Commit 9 — feat(hosts): consume config_option_update + session_info_update notifications

Three reference hosts in one commit (or split per host if pre-commit hooks prefer). Each follows the same shape: add notification handler cases, drop response-field reads.

**`packages/bodhi-pi-cli/`:**
- `src/repl/repl.ts:83-88` — extend the `sessionUpdate` switch with cases for `config_option_update` (call `refreshStateFromConfigOptions(state, update.configOptions)`) and `session_info_update` (echo title change to stdout if interactive).
- `src/repl/commands.ts:501-507` (settings set) — drop the `as { ... configOptions?: SessionConfigOption[] }` cast and the `refreshStateFromConfigOptions` call. The notification handler in repl.ts now does it.
- `src/repl/commands.ts:518-523` (settings unset) — same.
- `src/repl/commands.ts:544-550` (login) — same.
- `src/repl/commands.ts:565-569` (logout) — same.
- `src/repl/commands.ts:384-388` (setName) — keep echoing the response `name` (still returned), no functional change.
- `e2e/chat.e2e.ts:88` — keep (asserts `setSessionConfigOption` response `configOptions`, which is unchanged).

**`packages/bodhi-pi-ws-frontend/`:**
- `src/hooks/useChat.ts:99-162` — add `config_option_update` and `session_info_update` cases in the dispatcher; update model state from `update.configOptions`.
- `src/ui/commands.ts:541` (login `EXT_KV_SET`) — drop the `result.configOptions?.find(...)` read; rely on the notification.
- `src/ui/commands.ts:563` (logout `EXT_KV_REMOVE`) — same.
- `src/ui/commands.ts` — also drop the equivalent reads from `EXT_SESSION_SETTINGS_SET`/`EXT_SESSION_SETTINGS_UNSET` (line numbers similar; locate by grep on `EXT_SESSION_SETTINGS`). Lines 132 (`setSessionConfigOption`) and 206 (`loadSession`) keep their `configOptions` reads — those are stable-ACP responses and unchanged.

**`packages/bodhi-pi-http/src/frontend/`:**
- `src/frontend/hooks/useChat.ts:54-71` — add `config_option_update` and `session_info_update` cases; call `App.tsx`'s `adoptModelFromConfig` (or pass the configOptions up via context).
- `src/frontend/ui/commands.ts` — locate the `EXT_KV_SET`/`EXT_KV_REMOVE`/`EXT_SESSION_SETTINGS_SET`/`EXT_SESSION_SETTINGS_UNSET` call sites and drop their `result.configOptions` reads. Lines 112, 153, 185 (model/new/resume) keep their reads — stable-ACP responses.
- `lib/acp-http-client.ts` response types — drop `configOptions?: SessionConfigOption[]` from the four ext-method response shapes.

## Critical files

| Path | Role |
|---|---|
| `packages/bodhi-pi/src/acp/agent.ts` | Constructor wiring (subscriber registration), 4 ext handlers, setName, navigate, fork/clone, compaction call sites |
| `packages/bodhi-pi/src/events/types.ts` | New event interfaces, handler-map fields, union arms |
| `packages/bodhi-pi/src/events/dispatcher.ts` | Generic `emit<T>`, kept mutation-aware emitters |
| `packages/bodhi-pi/src/sessions/entries.ts` | `LabelEntry` removal |
| `packages/bodhi-pi/src/sessions/session-store.ts` | `LabelEntry` import removal |
| `packages/bodhi-pi/src/index.ts` | New event re-exports, `LabelEntry` removed |
| `packages/bodhi-pi/test/helpers/event-recorder.ts` | `ALL_EVENT_TYPES` extended (19 → 27) |
| `packages/bodhi-pi-cli/test/helpers/event-recorder.ts` | Mirror update |
| `packages/bodhi-pi/CHANGELOG.md` | Breaking-change note for Commit 8 |
| `packages/bodhi-pi-cli/src/repl/repl.ts` | sessionUpdate switch additions |
| `packages/bodhi-pi-cli/src/repl/commands.ts` | 4 ext-method response-read removals |
| `packages/bodhi-pi-ws-frontend/src/hooks/useChat.ts` | sessionUpdate switch additions |
| `packages/bodhi-pi-ws-frontend/src/ui/commands.ts` | 4 ext-method response-read removals |
| `packages/bodhi-pi-http/src/frontend/hooks/useChat.ts` | sessionUpdate switch additions |
| `packages/bodhi-pi-http/src/frontend/ui/commands.ts` | 4 ext-method response-read removals |
| `packages/bodhi-pi-http/src/frontend/lib/acp-http-client.ts` | Response type updates for 4 ext methods |

## Reused existing utilities (do not reimplement)

- `EventDispatcher.appendHandlers` (`events/dispatcher.ts:42-48`) — already exists for late-loaded extensions; reuse for the agent's internal subscribers.
- `buildAllConfigOptions(sessionId)` (`acp/agent.ts:1693-1700`) — already exists; the new `emitConfigOptionUpdate` helper just wraps it in a `sessionUpdate` dispatch.
- `parseDottedKey` + `getAt` from `core/settings-writer.ts` — already used by settings handlers; no changes needed.
- `recorder()` (`test/helpers/event-recorder.ts:39-47`) — already covers all event types via the `ALL_EVENT_TYPES` array; extending the array auto-extends test coverage.
- `createTestHarness` (`test/helpers/harness.ts:79`) — single source of truth for ACP test wiring; reuse unchanged.
- `refreshStateFromConfigOptions` in CLI (`packages/bodhi-pi-cli/src/repl/commands.ts:54`) — reuse from the new sessionUpdate handler.

## Verification

**Unit & integration:** `bun run test` from `packages/bodhi-pi` — every existing test must still pass. New tests added in Commits 4, 5, 7, 8 land green. Specifically:
- New test asserts `config_option_update` notification arrives at the client harness after each of: `/login`, `/logout`, `/settings set defaultModel <id>`, `/settings set defaultThinkingLevel <level>`, `setSessionConfigOption(model)`, `setSessionConfigOption(thinking)`.
- New test asserts `session_info_update` notification arrives after `/name`.
- New tests assert each new event (`auth_change`, `settings_change`, `compaction_start`/`end` with each `reason`, `branch_summary_created`, `session_navigate`, `session_fork`, `session_clone`) appears in the `recorder()` log with correct payload.
- Tests previously asserting `result.configOptions` from the four ext methods are removed/replaced.

**E2E:** `bun run test:e2e` from `packages/bodhi-pi` — existing 7 e2e files must still pass against `gpt-4o-mini`. No new e2e files in this wave (Batch H, separate worktree).

**Host smoke:**
- `cd packages/bodhi-pi-cli && bun run repl` — `/login openai sk-...`, `/settings set defaultModel gpt-4o-mini`, observe model picker state updates without polling.
- `cd packages/bodhi-pi-ws-frontend && bun run dev` — same flow via web UI; React state updates from notification.
- `cd packages/bodhi-pi-http && bun run dev` — same.
- `bodhi-pi-web` and `bodhi-pi-ws-server`: build only; neither consumes the changed responses.

**ACP wire check:** start the CLI with `BODHI_PI_DEBUG_WIRE=1` (or equivalent), perform a `/login`, grep stderr for `"sessionUpdate":"config_option_update"` — must appear exactly once.

**Build:** `bun run build` at the repo root — every package builds clean.

**Type check:** `bun run typecheck` at the repo root — no errors. SDK types confirm `config_option_update` (`SDK:4347`) and `session_info_update` (`SDK:4349`) are members of the `SessionNotification.update` union.

## Out-of-scope follow-ups (post-Wave-1)

- **Wave 2 — agent.ts decomposition (Batch B):** dispatcher table, `requireSession` everywhere, `_buildSessionState` split. Sequential after Wave 1 because it touches the same handlers.
- **Wave 3 — Sessions module dedup (Batch C/D):** `_file-ops.ts` + `_serialize.ts` shared between compaction & branch-summary; reuse `walkPath`; collapse 3 message wrappers. Independent worktree, can run in parallel with Wave 2.
- **Wave 4 — e2e gap fills (Batch H.3):** add `e2e/settings.e2e.ts`, `e2e/kv.e2e.ts`, `e2e/sessions.e2e.ts`, `e2e/thinking.e2e.ts`, `e2e/auto-compact.e2e.ts`. Settings/KV e2e specifically assert the new notification, confirming the host-side migration end-to-end.
- **Wave 5 — Capability advertisement + `EXT_SESSION_CONFIG` slimdown (Batch F):** needs design discussion (collapse to `version` flag vs enumerate; host-breaking).
