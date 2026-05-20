# Kickoff: bodhi-pi modes phase 0 — ground prep + mode state via ACP-native `setSessionConfigOption`

**Output**: implement the feature AFTER you've grilled the user on the open questions below. Read code first, batch decision points via `AskUserQuestion` (each option marked with your recommended answer), get plan approval before any code edits. Same shape as the sub-agents v1/v2 kickoff workflow.

## Status going in

Bodhi-pi currently has **no mode or permission concept**. Every built-in tool runs unconditionally when the LLM invokes it. The single existing primitive that the mode system will plug into is `ToolCallEventResult.block` from the `tool_call` extension event — extensions can already veto tool calls today; bodhi-pi just doesn't have a built-in policy engine doing the vetoing.

The research wave for modes is done (commits `e8e1c308` / `91a725e7` / `2fe30535` on `main`):

- Deep research report at `ai-docs/research/modes/report.md` surveying 13 production coding-agent harnesses + 8 framework libraries.
- Per-harness notes under `ai-docs/research/modes/notes/01-` through `17-` (cc, opencode, mastracode, gemini-cli, codex, cline+roo, continue+aider+openhands, goose+qwen, framework libs, plannotator, ACP spec deep-dive, Zed client, claude-agent-acp, codex-acp, goose-acp, pi-acp).
- Milestone plan at `ai-docs/research/modes/milestones/` (000-overview through 090). **Milestone 005 (`005-acp-architecture-decision.md`) is the binding decision doc — READ IT FIRST.**

The key architectural locked decision (from 005): **use ACP-native wire primitives**. `session/setSessionConfigOption` with `configId: "mode"` (not the deprecated `session/setSessionMode`), `session/request_permission` (live), `session/update { sessionUpdate: "config_option_update" }` (not the deprecated `current_mode_update`). NO `_bodhi-pi/mode/*` or `_bodhi-pi/permission/*` extension methods will be added.

This phase covers **milestone 010 (Ground preparation) + milestone 020 (Mode state + setSessionConfigOption extension)** as a single foundation slab. It lands the mode-state plumbing end-to-end across all four reference Hosts **without yet enforcing any policy** (every tool still runs unconditionally — milestone 030 is the next phase and adds enforcement). The mode is settable, persisted, advertised, observable — but inert. This is intentional: foundation first, behavior layered on top in 030+.

**Read first** (in this order):

1. [`ai-docs/research/modes/milestones/000-overview.md`](../research/modes/milestones/000-overview.md) — the map. Note the ⚠ banner pointing at 005.
2. [`ai-docs/research/modes/milestones/005-acp-architecture-decision.md`](../research/modes/milestones/005-acp-architecture-decision.md) — **locks the wire-surface choices**. Internalise this before writing any TS.
3. [`ai-docs/research/modes/milestones/010-ground-preparation.md`](../research/modes/milestones/010-ground-preparation.md) — milestone-level brief for the types + scaffold half of this phase.
4. [`ai-docs/research/modes/milestones/020-mode-state-and-set-config-option.md`](../research/modes/milestones/020-mode-state-and-set-config-option.md) — milestone-level brief for the mode-state half.
5. [`ai-docs/research/modes/notes/01-bodhi-pi-current-state.md`](../research/modes/notes/01-bodhi-pi-current-state.md) — current bodhi-pi audit for permissions/modes (none yet).
6. [`ai-docs/research/modes/notes/12-acp-spec.md`](../research/modes/notes/12-acp-spec.md) — what ACP gives us; what's deprecated vs live. Cross-reference with the canonical spec at `/Users/amir36/Documents/workspace/src/github.com/agentclientprotocol/agent-client-protocol/docs/protocol/session-config-options.mdx`.
7. [`ai-docs/specs/bodhi-pi/configuration.md`](../specs/bodhi-pi/configuration.md) — three-layer settings + `setSessionConfigOption` story for model/thinking (the pattern mode will join).
8. [`ai-docs/specs/bodhi-pi/architecture.md`](../specs/bodhi-pi/architecture.md) — agent-host-client + the table of existing domain services (`KvService`, `McpService`, …) that `PermissionService` joins.
9. [`ai-docs/specs/bodhi-pi/extensions-skills-commands.md`](../specs/bodhi-pi/extensions-skills-commands.md) — line 90 note about the deferred `Permissioner` from "the permissions phase". This phase ships the foundation; line 90 gets crossed off in milestone 030.

**Source pointers** (read selectively, not exhaustively):

- `packages/bodhi-pi/src/wire/constants.ts` — `MODEL_CONFIG_ID = "model"` (line 2), `THINKING_CONFIG_ID = "thinking"` (line 20). `MODE_CONFIG_ID = "mode"` joins them here.
- `packages/bodhi-pi/src/models/registry.ts:182-236` — **the dispatch-table pattern this phase extends**. `buildModelConfigOption`, `buildThinkingConfigOption`, `buildAllConfigOptions`, `setters` dispatch map, `setSessionConfigOption`. Mode follows this exact pattern.
- `packages/bodhi-pi/src/sessions/session-state.ts` — `SessionState.runtime` gains a `mode: AgentMode` field.
- `packages/bodhi-pi/src/sessions/entries.ts` — `SessionEntry` discriminated union; `mode_change` entry joins (mirrors `model_change` / `thinking_change`).
- `packages/bodhi-pi/src/sessions/session-bootstrap.ts:227-330` — `buildSessionState` resolves initial mode at session boot; `rehydrateSession:336` restores from last `mode_change` entry on the active branch.
- `packages/bodhi-pi/src/tools/index.ts:77-95` — `toolKindFor`; expands to include `"mcp"` and `"subagent"` categories.
- `packages/bodhi-pi/src/settings/settings.ts:35-51` — `BodhiPiProjectSettings`; gains `defaultMode?: AgentMode`.
- `packages/bodhi-pi/src/acp/agent.ts:67-136` — `BodhiPiConfig`; gains `defaultMode?`, `allowsAllowAllMode?`, `allowsAllowAllModeAsDefault?`. The `BodhiPiAcpAgent` constructor (line 185-315) wires `PermissionService` alongside other domain services.
- `packages/bodhi-pi/src/events/types.ts` — `BodhiPiEvent` union gains `mode_change`, `tool_approval_request`, `tool_approval_response` variants (these are **in-process events for extensions**, NOT wire-forwarded — the wire view is native ACP `ConfigOptionUpdate` / `request_permission`).
- `packages/bodhi-pi/test/helpers/harness.ts:82` — the `requestPermission` test stub. Don't change behaviour here in phase 0 (no approvals yet); milestone 030 reworks the harness for the approval flow.

## Goal

Lay the type vocabulary and small data-shape additions, AND wire the mode-state plumbing through `setSessionConfigOption` end-to-end across all four reference Hosts, such that:

- A user can call `setSessionConfigOption({ configId: "mode", value: "edit" })` from the client side
- The session's runtime mode mutates
- A `ConfigOptionUpdate` `SessionUpdate` notification fires to the client with the full new config-options list
- A `mode_change` SessionEntry persists in the SessionStore
- `session/load` and `session/resume` restore the last mode from that entry
- The mode appears in the `configOptions[]` advertised on `NewSessionResponse` / `LoadSessionResponse` / `ResumeSessionResponse` with `category: "mode"`, ordered FIRST (highest priority per spec)
- Each Host's Client adds a `/mode <id>` + `/modes` slash command (slash dispatcher pattern shared via `test-apps/browser/src/client/...` + cli's commands.ts)
- The `allowsAllowAllMode` capability gate rejects `setSessionConfigOption("mode", "allow-all")` with `-32603` when the Host hasn't opted in
- The `allowsAllowAllModeAsDefault` capability rejects bootstrap-time `defaultMode: "allow-all"` from settings unless the Host opts in
- All four reference Hosts (cli + http + browser + chrome-ext) prove this works under their respective transports, including http's per-turn agent rebuild

**No policy enforcement.** Every tool still runs unconditionally. `PermissionService.evaluateToolCall` returns `{ kind: "allow" }` unconditionally — milestone 030 fills it in.

## Locked scope decisions (per 005 + user-confirmed in prior session)

- **Four modes**: `ask | plan | edit | allow-all`. Strings, no enum tag bikeshedding.
- **Default mode for new sessions**: `ask` (safer / principle of least privilege).
- **ACP-native wire**: `session/setSessionConfigOption { configId: "mode" }`. **DO NOT** implement `session/setSessionMode` (deprecated, slated for removal). **DO NOT** populate the legacy `modes: SessionModeState` field on session responses — `configOptions` alone is sufficient.
- **Notifications**: `ConfigOptionUpdate` via `session/update`. **DO NOT** emit `current_mode_update` (deprecated).
- **No new `_bodhi-pi/*` extension methods.** Mode change, get, list all ride the existing `setSessionConfigOption` + the existing `_bodhi-pi/session/config` response (which already lists `configOptions`).
- **Mode change emission ordering**: emit `ConfigOptionUpdate` BEFORE returning from `setSessionConfigOption`. Goose's pattern; prevents the response unblocking the client before the notification arrives.
- **30s approval timeout, configurable** via `permission.approvalTimeoutMs` settings key — the SETTINGS KEY lands in this phase (it's just a parse-and-store; nothing consults it yet). The actual timeout machinery lands in milestone 030.
- **Default mode resolution priority**: `BodhiPiConfig.defaultMode` (host-explicit) → merged settings `defaultMode` → `"ask"` fallback. Loud rejection if `defaultMode: "allow-all"` appears in settings without `allowsAllowAllModeAsDefault: true`.
- **`PermissionService` lives at `src/permissions/`** — domain folder owns types + service. Mirrors `src/subagents/`, `src/mcp/`, etc.
- **In-process `EventDispatcher` events `mode_change` / `tool_approval_request` / `tool_approval_response` are declared in 010**. The first emitter is in 020 (mode_change). The other two get their emitters in 030.
- **Phase 0 ships NO behaviour change to tool execution**. Existing tests that invoke tools continue to pass without any changes. Tools all run.

## What still exists (don't reimplement)

- **`setSessionConfigOption` ACP handler** at `src/acp/agent.ts:583-584` already delegates to `ModelRegistry.setSessionConfigOption`. Mode joins the dispatch table inside `ModelRegistry`; the ACP-layer handler is unchanged.
- **`ModelRegistry.setters` dispatch table** at `src/models/registry.ts:217-236` — one new entry, `[MODE_CONFIG_ID]: (sid, _s, v) => permissionService.setMode(sid, v, "user")`.
- **`ModelRegistry.buildAllConfigOptions`** at `src/models/registry.ts:208` — prepend `permissionService.buildModeConfigOption(session)` first (highest priority per ACP spec); model + thinking follow.
- **`SettingsService`** at `src/settings/settings-service.ts` — generic key/value store keyed by dotted path; `defaultMode` is just another key. No new methods needed in phase 0.
- **`SessionEntry` discriminated-union pattern** — `mode_change` joins `model_change` and `thinking_change` as siblings. `buildSessionContext` already filters non-message entries out of LLM context.
- **`appendEntry` in `BodhiPiAcpAgent`** (line 317) — bumps leaf, persists, used unchanged.
- **`EventDispatcher.emit` / `emitToolCall`** — used unchanged; new event types are just additions to the discriminated union.
- **Lifecycle event forwarding** at `src/acp/event-wiring.ts` — the WIRE forwarding goes via native `ConfigOptionUpdate` (sessionUpdate), NOT via `LIFECYCLE_EVENT_METHOD`. The in-process events are dispatcher-only.
- **Test harness** at `test/helpers/harness.ts:82` — the `requestPermission` stub stays as `cancelled` for phase 0 (no approvals fire anyway).

## Open exploration questions to resolve before designing

Resolve these by reading source first, then `AskUserQuestion` (with your recommended answer per question) before writing the plan. Batched per area:

### PermissionService construction + circular dep with ModelRegistry

- **`PermissionService` needs `sessions`, `events`, `appendEntry`, capabilities** (allowsAllowAllMode + allowsAllowAllModeAsDefault), and a way for `ModelRegistry` to call its `setMode` and `buildModeConfigOption`.
- **`ModelRegistry` is constructed before `PermissionService` in the current code** (`agent.ts:217-228`). If `PermissionService` is constructed after, the dispatch-table entry can't be added in `ModelRegistry`'s constructor (it doesn't have a reference yet).
- **Options**: (A) construct `PermissionService` first and pass it into `ModelRegistry`'s constructor — but model registry presently doesn't need a permissioner. (B) setter injection — `modelRegistry.setPermissionService(permissionService)` after both are constructed; the setters dispatch table is mutable. (C) move the mode dispatch entry into `PermissionService.register()` returning `[MODE_CONFIG_ID, handler]` pairs that `BodhiPiAcpAgent` merges into a top-level dispatch table — bigger refactor.
- **Recommend (B)** — setter injection, smallest diff to existing code; matches the pattern that `ExtensionRunnerHost.current()` lazy-resolves at use time. Document the rationale in the plan.

### `buildModeConfigOption` shape

- Returns a `SessionConfigOption`. What fields?
  - `id: "mode"` (the MODE_CONFIG_ID constant).
  - `name: "Session Mode"`? Or `"Mode"`? Or `"Permission Mode"`? Spec example uses "Session Mode" (`session-config-options.mdx:24`). **Recommend** "Session Mode" to match spec example.
  - `description: "Controls how the agent requests permission"` — matches spec example. **Recommend** verbatim.
  - `category: "mode"` (reserved category per spec `session-config-options.mdx:118`).
  - `type: "select"` (only supported type today).
  - `currentValue: session.runtime.mode`.
  - `options: SessionConfigSelectOption[]` — one per mode. Display name + per-mode description.
- **Per-mode display name + description**: where does this live? **Recommend** a `MODE_DISPLAY` constant in `src/permissions/types.ts` keyed by `AgentMode`: `{ ask: { name: "Ask", description: "Request permission for edits, shell, MCP, sub-agents" }, plan: { ... }, edit: { ... }, "allow-all": { ... } }`. Cheap to maintain; keeps the JSON-shape of the option self-contained.
- **`allow-all` option visibility**: when `capabilities.allowsAllowAllMode === false`, should the option be omitted from `availableModes`, OR included but greyed out (with a description like "Requires host capability allowsAllowAllMode")?
- **Recommend** OMIT entirely — if a host doesn't allow it, don't tempt the user. The setMode handler still rejects with -32603 as defence-in-depth in case a client tries to bypass.

### `setMode` semantics

- Synchronous in-memory mutation + async persist? Or fully async?
- **Recommend** async (it appends a `mode_change` SessionEntry; needs `await sessionStore.append`).
- **What if `setMode` is called with the SAME mode the session is already in?** Skip the entry + skip the event? Or always append + emit?
- **Recommend** skip — idempotent. Avoids spurious `mode_change` entries in the log when a client racing for state-sync calls `setSessionConfigOption("mode", "ask")` and ask is already current. Document.
- **`mode_change` SessionEntry shape**: `{ type: "mode_change", id, parentId, timestamp, mode, reason }`. `reason: "user" | "session_load" | "submit_plan_approved" | "settings_change" | "subagent_spawn"`. Phase 0 only emits `"user"` (and implicitly `"session_load"` if anything). Document the full union for forward compat.
- **Lifecycle event**: emit `BodhiPiEvent { type: "mode_change", sessionId, fromMode, toMode, reason }`. **In-process only**, not wire-forwarded. Wire view goes via the `ConfigOptionUpdate` notification that `ModelRegistry.setSessionConfigOption` already sends.

### `ConfigOptionUpdate` emission timing

- Today: `ModelRegistry.setSessionConfigOption` returns the full configOptions to the caller. The CALLER (in `BodhiPiAcpAgent`) returns this in the JSON-RPC response. There's NO `session/update { config_option_update }` notification today — the response IS the update.
- Spec says (`session-config-options.mdx:228-258`): the AGENT MAY ALSO emit `config_option_update` notifications when it changes options proactively (e.g. plan-mode auto-transition to edit, or model fallback). Phase 0 doesn't have any agent-initiated changes (only client-initiated via setSessionConfigOption), so the explicit notification path is unnecessary unless we want the client to render the update consistently regardless of which side initiated it.
- **Goose pattern** (note 16): emit the notification BEFORE responding to the request, so clients that subscribe to both rails see the update via either path. Useful for races where the response unblocks the client before the notification arrives.
- **Recommend**: emit `config_option_update` notification AFTER successful mode mutation but BEFORE returning from `setSessionConfigOption`. This requires touching the model registry's existing flow OR doing the emit from `PermissionService.setMode`. Confirm which seam.
- **What about model + thinking?** Should we ALSO emit `config_option_update` after model/thinking changes? Inconsistency between mode (emits) and model/thinking (doesn't) is awkward. **Recommend** emit for ALL setSessionConfigOption successes — keeps the wire surface symmetric. Behaviour change for model/thinking is purely additive (the response remains the same; just an extra notification fires).
- Verify this doesn't break any existing test that asserts on the exact stream of session updates.

### `mode_change` SessionEntry filtering

- `buildSessionContext` walks the active branch and converts entries to AgentMessages for the LLM. `mode_change` entries should be filtered out (they're metadata, not conversation content). Mirror what `model_change` / `thinking_change` already do.
- **Verify** by reading `src/sessions/build-context.ts` — confirm those existing types are already filtered and add `mode_change` to the same filter list.
- Also relevant: the `SUBAGENT_FORK_FILTER` list — when a child session is forked from parent's transcript, do we filter `mode_change` out? **Recommend yes** — child's mode comes from profile/inheritance, not from parent's transcript log.

### Default-mode resolution at boot

- Order: `BodhiPiConfig.defaultMode` (host-explicit, factory-time) → merged settings `defaultMode` (project > global) → `"ask"` fallback.
- **What if `settings.defaultMode` is an unknown string?** Log warning via `config.logger`, fall through to `BodhiPiConfig.defaultMode` or `"ask"`.
- **What if `settings.defaultMode === "allow-all"` and `capabilities.allowsAllowAllModeAsDefault === false`?** Log error, fall through. The error should be surfaced somewhere — `_bodhi-pi/session/config` response gains a `modeBootstrapError?: string` field? OR fold it into `globalSettingsParseError` / `projectSettingsParseError`? **Recommend** new dedicated field for clarity.
- **What if `BodhiPiConfig.defaultMode === "allow-all"` and `allowsAllowAllMode: false`?** Throw at factory time? Or silently downgrade? **Recommend throw** — host-explicit values are programmer-supplied; misconfiguration should fail loud.
- **What if `BodhiPiConfig.defaultMode === "allow-all"` and `allowsAllowAllMode: true` but `allowsAllowAllModeAsDefault: false`?** Throw? Allow? `defaultMode` ≠ "configured as default for new sessions"; it IS the default per session, which is exactly what the second flag governs. So this combination should THROW. Document.

### `rehydrateSession` mode restoration

- `rehydrateSession` walks the active branch; finds the most recent `mode_change` entry; uses its `mode` as the session's runtime mode. If no entry exists, fall back to the bootstrap resolution chain.
- **What if the persisted mode is `allow-all` but the host's `allowsAllowAllMode === false`** (e.g. session was created in cli with capability true, now being resumed from http with capability false)? Downgrade silently to bootstrap-chain mode, surface error? **Recommend** silent downgrade to the default for the current host + surface via the same `modeBootstrapError` field. Document loudly.

### Host capability defaults

- `test-apps/cli`: `allowsAllowAllMode: true`, `allowsAllowAllModeAsDefault: false`. CLI sandbox is the user's own shell; user is responsible for their own safety. But persisted default is two-step.
- `test-apps/http`: BOTH `false` (multi-tenant; admin opts in).
- `test-apps/browser`: BOTH `false`.
- `test-apps/chrome-ext`: BOTH `false`.
- **Recommend** these defaults in the plan. Each host's `agent.ts` (or equivalent factory) sets them explicitly. Document in `hosts.md`.

### Per-host `/mode` + `/modes` slash command UX

- **Where do the slash commands live?** Existing slash dispatchers under `test-apps/<host>/src/client/...`. Each host shares as much as possible via `test-apps/browser/src/client/` (subpath-imported by chrome-ext) or `test-apps/app-utils/`.
- **`/mode <id>`** — calls `client.setSessionConfigOption({ sessionId, configId: "mode", value: id })`. Prints `mode set to <id>`. Tab-completion of mode names?
- **`/modes`** — lists available modes from `_bodhi-pi/session/config` response (which already returns configOptions). Print as a simple table.
- **Mode badge in CLI interactive footer**: bodhi-pi cli already shows model + thinking in the footer (interactive REPL). Add a mode badge. **Recommend** include in phase 0 for visual confirmation; cheap to add.
- **HTTP / browser / chrome-ext UI**: add a mode dropdown in the chat UI? **Recommend** YES for phase 0 — proves the feature reaches the user. Use the same pattern as the existing model dropdown.

### Lifecycle event types in 010

- `mode_change` event has 5 reasons in the union: `"user" | "session_load" | "submit_plan_approved" | "settings_change" | "subagent_spawn"`. Phase 0 emits ONLY `"user"` and `"session_load"`. Document the full union for forward compat.
- `tool_approval_request` event — declared in 010 (so the union is complete), NOT emitted in phase 0. Its shape: `{ type, sessionId, toolCallId, toolName, category, pattern, timeoutMs }`.
- `tool_approval_response` event — same.
- Are these enough to drive an extension that wants to log approval round-trips? **Recommend** add a `correlationId: string` field on both so extensions can match request → response cleanly.

### ACP SDK version

- Verify `node_modules/@agentclientprotocol/sdk` version. The schema dump earlier confirmed `ConfigOptionUpdate`, `RequestPermissionRequest`, `SessionMode`, `SessionConfigOption` are all in the types. Confirm package.json version is fresh enough that `category: "mode"` is supported.
- **Recommend** check `packages/bodhi-pi/package.json` dependency version. If < 0.12.0, bump. Document.

### `_bodhi-pi/session/config` mode surfacing

- Today's response includes `currentModelId`, `thinkingLevel`, `retryOptions`, `compaction`, etc. Add `mode: AgentMode` and `modeBootstrapError?: string`.
- **Recommend** YES, add both. The existing `_bodhi-pi/session/config` response is the natural place for hosts to read the current mode without parsing configOptions (which can be done but feels indirect).

### Spec doc creation

- `ai-docs/specs/bodhi-pi/modes.md` is a NEW spec doc — milestone 010 creates it as the canonical reference; subsequent milestones extend it.
- **Recommend** create in phase 0 with full "Mode taxonomy + Architecture decisions + ACP-native surface + Implementation status table" sections. Implementation status table rows for 010 and 020 = ☑; others = ☐. Each subsequent milestone flips its row.
- Also update: `index.md` (Read-this-if table row), `configuration.md` (BodhiPiConfig fields + BodhiPiProjectSettings fields), `architecture.md` (services table — add PermissionService row), `lifecycle.md` (SessionEntry union table — add `mode_change` row), `acp.md` (mention `setSessionConfigOption` now handles `configId: "mode"`; mention `ConfigOptionUpdate` notification is emitted from agent side), `extensions-skills-commands.md` (line 90 footnote about the Permissioner phase — note it lands across 010-030).

### Tool category expansion

- Today `toolKindFor` returns `"read" | "edit" | "search" | "execute" | "other"`. Phase 0 expands to add `"mcp"` and `"subagent"`.
- **MCP tools** are namespaced `<slug>__<tool>` — detect via `name.includes("__")`. **Verify** this doesn't false-positive on any extension-registered tool name conventions (it shouldn't — extensions use raw names).
- **Subagent tools**: `"subagent"` itself is the current single tool. If subagent_batch revives (per sub-agents milestone 040 superseded notice it's been removed), the category covers both. **Recommend** include `"subagent_batch"` in the match anyway for forward compat.
- The new `ToolCategory` type LIVES in `src/permissions/types.ts` — `toolKindFor` re-exports its return type. Verify no downstream caller expects the old union (which is a strict subset of the new one).

### Test pattern: how to assert mode change without firing real LLM

- Use `createTestHarness` with faux models. After `newSession`, call `clientConn.setSessionConfigOption({ sessionId, configId: "mode", value: "edit" })`. Assert: response has the full configOptions with mode=edit; updates array contains a `config_option_update` SessionUpdate; sessionStore has a `mode_change` entry. Close + reload session; assert mode=edit on the new config response.
- **What about `_bodhi-pi/session/config`?** Assert `mode: "edit"` in the response.
- **For HTTP per-turn-rebuild**: same flow but each `prompt` rebuilds the agent. Assert mode survives the rebuild by reading it from `_bodhi-pi/session/config` after a rebuild boundary. The mode comes from the rehydrated `mode_change` entry.

### Per-runtime parity tests

- `packages/bodhi-pi/test/modes-state.test.ts` (new) — integration tests with faux provider.
- `packages/bodhi-pi/e2e/modes-state.e2e.ts` (new) — `gpt-4o-mini` round-trip just to prove the wire works through a real connection. NOT testing enforcement (because there is none).
- `packages/bodhi-pi/test-apps/cli/e2e/modes-state.e2e.ts` — `/mode edit` slash; assert badge update.
- `packages/bodhi-pi/test-apps/browser/e2e/modes-state.spec.ts` + `chrome-ext/e2e/modes-state.spec.ts` — Playwright; mode dropdown change.
- `packages/bodhi-pi/test-apps/http/test/integration/modes-state.test.ts` — per-turn-rebuild round-trip.

## Process — iterative TDD across the matrix

Per `packages/bodhi-pi/CLAUDE.md` 6-step workflow + `feedback_e2e_coverage_keeps_feature` + `feedback_phasing_depth_first` (depth-first per runtime). A variant is "done" only when it has at least one of `{e2e, cli-headless, Playwright}` per supported runtime. Integration-only is not enough.

Recommended cadence:

1. **Integration first**. `packages/bodhi-pi/test/modes-state.test.ts` — failing tests that drive the design via faux provider + harness. Most cases from the milestone-020 doc carry over (default mode = ask; setSessionConfigOption changes mode; rejection on allow-all without capability; settings rejection on allow-all as default without capability; etc.).
2. **Make it pass in `src/`** — `src/permissions/types.ts`, `src/permissions/permission-service.ts`, `src/sessions/session-state.ts` mode field, `src/sessions/entries.ts` ModeChangeEntry, `src/sessions/session-bootstrap.ts` default-mode resolution + rehydrate, `src/models/registry.ts` dispatch table extension, `src/sessions/build-context.ts` filter, `src/sessions/session-info-service.ts` `_bodhi-pi/session/config` mode field.
3. **e2e (gpt-4o-mini)** — `packages/bodhi-pi/e2e/modes-state.e2e.ts`. Single-shot: set mode, prompt, verify mode badge shows in `_bodhi-pi/session/config` post-prompt.
4. **Cli e2e** — `test-apps/cli/e2e/modes-state.e2e.ts`. Spawn cli; send `/modes`, `/mode edit`, `/config`. Assert outputs.
5. **Browser + chrome-ext Playwright** — `test-apps/browser/e2e/modes-state.spec.ts`, `test-apps/chrome-ext/e2e/modes-state.spec.ts`. Mode dropdown selection; reload page; mode persists.
6. **Http integration** — `test-apps/http/test/integration/modes-state.test.ts`. Per-turn rebuild boundary.
7. **Spec updates same-commit** — `modes.md` (new), `index.md`, `configuration.md`, `architecture.md`, `lifecycle.md`, `acp.md`, `extensions-skills-commands.md`. Each touched ACP method or extension method gets its row updated.

Each commit ends green on `npm run check` + the relevant test slices. Each Host runtime gets its own validation gate before moving on.

## Gate-check + commit cadence

Suggested commit shape (NOT prescriptive — slice however makes commits bisectable):

- **C1**: types + tool-kind expansion + settings schema + lifecycle event type declarations + spec scaffold (`modes.md` created; `index.md` row added; `configuration.md` updated). No behaviour change. Mirror milestone 010's brief.
- **C2**: `PermissionService` skeleton (allow-all policy stub) + `MODE_CONFIG_ID` constant + dispatch table extension in `ModelRegistry` + `SessionState.runtime.mode` field + `ModeChangeEntry` SessionEntry + `buildSessionContext` filter. Integration test passing. Tests under `test/modes-state.test.ts`.
- **C3**: `setMode` implementation + default-mode bootstrap chain + `rehydrateSession` mode restoration + `allowsAllowAllMode`/`allowsAllowAllModeAsDefault` gates. Capability-rejection tests passing.
- **C4**: `ConfigOptionUpdate` emission (BEFORE response) + `_bodhi-pi/session/config` mode field + lifecycle event emit (`mode_change`).
- **C5**: cli host wires `/mode`/`/modes` slash + footer badge. Cli e2e passing.
- **C6**: http frontend dropdown + http integration test passing.
- **C7**: browser + chrome-ext dropdowns. Playwright passing.
- **C8**: spec finalisation (`acp.md`, `architecture.md`, `lifecycle.md`, `hosts.md`, `extensions-skills-commands.md`) + `modes.md` table flips for 010 + 020 = ☑.

Each commit individually green per trunk-based-dev. Bisecting any commit must not break.

## Plan structure (mandatory sections)

When you write the plan after grilling the user, include:

1. **Goal restatement** — quote the foundation slab (types + mode-state plumbing, no enforcement).
2. **Locked-scope summary** — table: decision → user-locked answer → file:line where it lands.
3. **Open-question resolutions** — table: question → recommended answer → user-answer (filled during the grilling session).
4. **File-level inventory** — new files, touched files, spec docs amended. Per file: one-line purpose. Include the new `modes.md` spec doc with its initial section list.
5. **Per-commit slice** — propose commits + the validation gate per commit (npm run check + which test files + which e2e/e2e-ui specs).
6. **Verification matrix** — per runtime: which npm/vitest/playwright command to run after each commit lands. Include both unit and e2e suites.
7. **Risk register** — circular dep between `PermissionService` and `ModelRegistry` (setter injection mitigation); `ConfigOptionUpdate` emission breaking existing tests that count session updates; existing test harness's `requestPermission: cancelled` stub causing surprise if any code path inadvertently triggers approval (no path should in phase 0); SDK version mismatch.
8. **Out of scope** — explicitly: policy enforcement (milestone 030); `requestPermission` invocation (030); `submit_plan` tool (050); `allow-all` semantics beyond capability gate (060); sub-agent inheritance (070); active-tools swap (080); persistent rules (090). Phase 0 is foundation only.

## Anti-patterns to avoid

- **Don't invent `_bodhi-pi/mode/*` or `_bodhi-pi/permission/*` wire methods.** ACP-native `setSessionConfigOption` covers mode change; existing `_bodhi-pi/session/config` covers reads; existing `_bodhi-pi/session/settings/*` covers persistent rules (not in phase 0, but stays the same).
- **Don't implement the deprecated `session/setSessionMode`.** Bodhi-pi has no production users; clean implementation only. The deprecated path is not added even for "backward compat" — there's nothing to be backward-compatible with.
- **Don't populate the legacy `modes: SessionModeState` field** on `NewSessionResponse` / `LoadSessionResponse` / `ResumeSessionResponse`. `configOptions` alone is sufficient.
- **Don't emit `current_mode_update` notifications.** Use `config_option_update` (the new one).
- **Don't add policy enforcement.** Tool execution stays unconditional in phase 0. `PermissionService.evaluateToolCall` is a stub returning `{ kind: "allow" }`. Milestone 030 is where policy lives.
- **Don't add `node:*` imports to `src/permissions/`** — runtime-neutrality rule from `packages/bodhi-pi/CLAUDE.md`.
- **Don't wire-forward in-process events via `LIFECYCLE_EVENT_METHOD`.** The wire view of mode change is the native `ConfigOptionUpdate` notification; in-process `mode_change` is for extensions inside the agent process (e.g. an extension that wants to log mode changes can `pi.on("mode_change", ...)`).
- **Don't add the `_meta["bodhi-pi"].modes` field** — the legacy `modes` field was the alternative; `configOptions` is on its own top-level field on the session response. `_meta` is for genuine extension data.
- **Don't add a `mode` field to `_bodhi-pi/session/config` AS WELL AS `configOptions` if there's redundancy.** It's a small redundancy that aids host code (one read vs walking configOptions); document. **Recommend** ship the small redundancy because the existing `_bodhi-pi/session/config` already returns `currentModelId` redundantly with configOptions.
- **Don't unify the `_bodhi-pi/session/setName` / `_bodhi-pi/session/stats` / `_bodhi-pi/session/export` pattern for modes.** Mode is purely a session-config dimension; it doesn't need its own session-info-style ext method.
- **Don't combine 020 with 030 in this phase.** 030 is the policy engine + `requestPermission` round-trip + 4-runtime UI for approvals — a much heavier slab. Phase 0 stops at "mode is settable / persisted / observable but inert".

## References

- Research wave commits (today's references):
  - `e8e1c308` — initial research report + per-harness notes (sub-agents-research-style).
  - `91a725e7` — initial milestones (000-overview + 010-090).
  - `2fe30535` — ACP-native pivot: 6 notes (12-acp-spec through 17-pi-acp) + 005-decision doc + targeted milestone updates.
- Reference research notes most relevant to phase 0:
  - `ai-docs/research/modes/notes/12-acp-spec.md` — what to use and what to skip.
  - `ai-docs/research/modes/notes/16-goose-acp.md` — `ConfigOptionUpdate` emission ordering.
  - `ai-docs/research/modes/notes/15-codex-acp.md` — multi-axis-collapsed-to-presets pattern; agent-owns-fs camp.
  - `ai-docs/research/modes/notes/14-claude-agent-acp.md` — model-gated mode advertisement.
  - `ai-docs/research/modes/notes/17-pi-acp.md` — confirms bodhi-pi's "agent owns fs" architectural camp.
- Sibling milestone files:
  - `ai-docs/research/modes/milestones/000-overview.md` (READ first)
  - `ai-docs/research/modes/milestones/005-acp-architecture-decision.md` (READ FIRST — binding)
  - `ai-docs/research/modes/milestones/010-ground-preparation.md`
  - `ai-docs/research/modes/milestones/020-mode-state-and-set-config-option.md`
- ACP spec sources (in the agent-client-protocol clone):
  - `docs/protocol/session-config-options.mdx` — the live primitive for mode change.
  - `docs/protocol/session-modes.mdx` — the deprecated path (DO NOT implement).
  - `docs/protocol/tool-calls.mdx` — `request_permission` (out of scope for phase 0; phase 030).
  - `docs/rfds/session-config-options.mdx` — design rationale for the new path.
- Bodhi-pi pattern references:
  - `src/models/registry.ts:182-236` — dispatch-table extension pattern.
  - `src/mcp/mcp-service.ts` — example domain service that owns its types + ext methods.
  - `src/subagents/subagent-service.ts` — recent service-pattern reference; mode service is smaller in scope.
  - `src/sessions/session-bootstrap.ts` — bootstrap + rehydrate seams.
  - `src/sessions/build-context.ts` — entry-type filter; mode_change joins the filtered list.
  - `src/wire/constants.ts` — wire-constants leaf module.

## When done

Print: the plan path, the count of open questions resolved during the grilling session, and the proposed commit subjects in order. Do not start executing the plan in this round — the plan IS the deliverable. Implementation runs in a separate session, ideally guided by `superpowers:executing-plans` or an equivalent execution-mode harness.

The implementation session that follows will land C1-C8 commits on `main` per trunk-based dev, each individually green against `npm run check` + `npm test` + the relevant `just test-e2e` / `just test-e2e-ui` slices. After all commits land, write `ai-docs/modes/p0-retrospective.md` (or equivalent — match the sub-agents `v1-retrospective.md` / `v2-retrospective.md` / `p2a-retrospective.md` precedent) capturing what surprised, what carried forward, and what got punted to phase 1 (milestone 030).
