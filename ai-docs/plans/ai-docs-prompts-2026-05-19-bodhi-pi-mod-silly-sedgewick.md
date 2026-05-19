# bodhi-pi modes Phase 0 — foundation slab (milestones 010 + 020)

> Plan file for the kickoff at `ai-docs/prompts/2026-05-19-bodhi-pi-modes-p0-foundation.md`.
> Source-of-truth milestone docs: `ai-docs/research/modes/milestones/{000,005,010,020}.md`.

## Context

Bodhi-pi has **no mode or permission concept** today. Every built-in tool runs unconditionally. The deep-research wave (commits `e8e1c308`, `91a725e7`, `2fe30535`) landed (a) a 13-harness + 8-library survey, (b) a binding ACP-architecture decision (005), and (c) a 010→090 milestone plan. Milestone 005 locks an **ACP-native wire** strategy: `setSessionConfigOption { configId: "mode" }` for changes, `config_option_update` `SessionUpdate` for notifications, no deprecated `setSessionMode` / `current_mode_update` / `_bodhi-pi/mode/*` paths.

**Phase 0 = milestones 010 + 020 = foundation slab.** It lands the type vocabulary, the `PermissionService` skeleton, and end-to-end mode-state plumbing across all four reference Hosts **with NO policy enforcement**. Every tool still runs unconditionally. The mode is settable, persisted, advertised, observable — but inert. Phase 1 (milestone 030) adds enforcement on top.

This plan reorganises one architectural smell along the way: today `ModelRegistry` owns the entire `setSessionConfigOption` dispatch table even though new config-ids (mode, future profile, future agent-axes) are owned by other services. We lift dispatch up to `BodhiPiAcpAgent` so each service owns its own setter+builder for the config-ids it owns. Rule-of-three: model+thinking+mode justifies the extraction.

## Goal

Quoting the kickoff (foundation slab — no enforcement):

> Lay the type vocabulary and small data-shape additions, AND wire the mode-state plumbing through `setSessionConfigOption` end-to-end across all four reference Hosts, such that:
> - A user can call `setSessionConfigOption({ configId: "mode", value: "edit" })`
> - The session's runtime mode mutates
> - A `ConfigOptionUpdate` `SessionUpdate` notification fires
> - A `mode_change` SessionEntry persists in the SessionStore
> - `session/load` and `session/resume` restore the last mode from that entry
> - The mode appears in `configOptions[]` with `category: "mode"`, ordered FIRST
> - Each Host's Client adds a `/mode <id>` + `/modes` slash command + a mode badge
> - `allowsAllowAllMode=false` rejects `setSessionConfigOption("mode", "allow-all")` with `-32603`
> - `allowsAllowAllModeAsDefault=false` rejects bootstrap-time `defaultMode: "allow-all"` from settings unless host opts in
> - All four reference Hosts (cli + http + browser + chrome-ext) prove this works under their transports, including http's per-turn agent rebuild

**No policy enforcement.** `PermissionService.evaluateToolCall` returns `{ kind: "allow" }` unconditionally — 030 fills it in.

## Locked-scope decisions (from kickoff + 005 + this grilling)

| Decision | Locked answer | Where it lands |
|---|---|---|
| Mode vocabulary | `ask \| plan \| edit \| allow-all` | `src/permissions/types.ts` (new) |
| Default mode for new sessions | `ask` (safe) | `src/sessions/session-bootstrap.ts` (buildSessionState) |
| Wire method for change | `session/setSessionConfigOption { configId: "mode" }` | `src/acp/agent.ts:577` (handler) |
| Wire notification | `session/update { sessionUpdate: "config_option_update" }` | `src/acp/event-wiring.ts` (new handler for `mode_change` domain event) |
| Deprecated paths to avoid | NO `session/setSessionMode`, NO `current_mode_update`, NO `_bodhi-pi/mode/*`, NO legacy `modes: SessionModeState` field | n/a |
| Domain-event emission ordering | Notification BEFORE response (Goose pattern). Today already true for model+thinking via synchronous event-wiring forward; mode joins the same chain. | `src/acp/event-wiring.ts` |
| Service ownership of dispatch | **Refactor**: dispatch lifted to `BodhiPiAcpAgent`. Each service owns its own setter+builder for the config-ids it owns. | `src/acp/agent.ts`, `src/models/registry.ts`, `src/permissions/permission-service.ts` |
| `setMode` idempotency | Always append `mode_change` entry + emit event, even when called with current mode | `src/permissions/permission-service.ts` (setMode) |
| `allow-all` option in `configOptions[].options[]` when capability is false | Omit entirely | `src/permissions/permission-service.ts` (buildModeConfigOption) |
| Bootstrap `defaultMode: "allow-all"` from `BodhiPiConfig` without `allowsAllowAllMode` | **Throw** at factory time (programmer error) | `src/acp/agent.ts` constructor |
| Bootstrap `defaultMode: "allow-all"` from `BodhiPiConfig` with `allowsAllowAllMode=true` but `allowsAllowAllModeAsDefault=false` | **Throw** at factory time | same |
| Bootstrap `defaultMode: "allow-all"` from settings without `allowsAllowAllModeAsDefault` | Log error via `config.logger`, fall through to bootstrap chain (no client-side surface) | `src/sessions/session-bootstrap.ts` |
| Rehydrate persisted `allow-all` from incompatible host | Silent downgrade to bootstrap chain; log via `config.logger` | `src/sessions/build-context.ts` / `rehydrateSession` |
| `_bodhi-pi/session/config` mode surface | configOptions[] only — do NOT add a `mode` field. (Existing `currentModelId` / `thinkingLevel` redundancy with configOptions is pre-existing tech-debt; flagged in "Follow-ups" below.) | `src/sessions/session-info-service.ts` (no change for mode) |
| Tool category expansion | Add `mcp` (via `name.includes("__")`) and `subagent` (only). No `subagent_batch` — that surface was deleted in `e136c804`. | `src/permissions/types.ts`, `src/tools/index.ts` |
| Host capability defaults | All four hosts: `allowsAllowAllMode=true`, `allowsAllowAllModeAsDefault=false`. PoCs demonstrate full feasibility; default-mode persistence stays two-step everywhere. | `packages/bodhi-pi-{cli,http,browser,chrome-ext}/...` |
| Per-host UI scope for Phase 0 | Slash commands (`/mode`, `/modes`) + read-only badge. **No interactive dropdown** in Phase 0 (lands in 030 when mode does something). | All four host packages |
| Approval-timeout settings key | `permission.approvalTimeoutMs` defaults to 30000; parse-and-store only — nothing consults it yet | `src/settings/settings.ts` |
| `mode_change` SessionEntry reason union | Full union declared for forward-compat: `"user" \| "session_load" \| "submit_plan_approved" \| "settings_change" \| "subagent_spawn"`. Phase 0 emits only `"user"` and `"session_load"`. | `src/sessions/entries.ts` |
| In-process lifecycle event types declared in 010 | `mode_change`, `tool_approval_request`, `tool_approval_response`. `mode_change` is the only one emitted in Phase 0. Both approval events get a `correlationId: string` field for extension request↔response matching. | `src/events/types.ts` |
| `PermissionService` location | `src/permissions/` (mirrors `src/mcp/`, `src/subagents/`) | new folder |

## Dispatch-ownership refactor (the architectural change)

**Current state** (`src/models/registry.ts:218-238`):
```ts
private readonly configOptionSetters: Record<string, (sid, s, v) => Promise<void>> = {
  [MODEL_CONFIG_ID]: (sid, s, v) => this.setSessionModel(sid, s, v),
  [THINKING_CONFIG_ID]: (sid, s, v) => this.setSessionThinkingLevel(sid, s, v),
};
async setSessionConfigOption(params) { … dispatch via configOptionSetters … }
async buildAllConfigOptions(sessionId) { … model + optional thinking … }
```
ACP handler at `src/acp/agent.ts:577` delegates all config-option writes to `ModelRegistry`. Adding mode to this dispatch creates a circular dep (mode setter needs `PermissionService.setMode`; `PermissionService` is constructed after `ModelRegistry`).

**After refactor**:
- `ModelRegistry` drops `configOptionSetters`, `setSessionConfigOption`, `buildAllConfigOptions`. Its private `buildModelConfigOption` / `buildThinkingConfigOption` and `setSessionModel` / `setSessionThinkingLevel` become **public methods** on the class. No new dependencies on `PermissionService`.
- `PermissionService` (new) owns: `buildModeConfigOption(session)` + `setMode(sessionId, modeId, reason)` + the policy-evaluation stub `evaluateToolCall(...)` returning `{ kind: "allow" }`.
- `BodhiPiAcpAgent` owns the thin dispatch:
  ```ts
  async setSessionConfigOption(params) {
    const session = this.sessions.get(params.sessionId) ?? throw -32602;
    switch (params.configId) {
      case MODEL_CONFIG_ID:    await this.modelRegistry.setSessionModel(params.sessionId, session, params.value); break;
      case THINKING_CONFIG_ID: await this.modelRegistry.setSessionThinkingLevel(params.sessionId, session, params.value); break;
      case MODE_CONFIG_ID:     await this.permissionService.setMode(params.sessionId, params.value, "user"); break;
      default: throw new RequestError(-32602, `unknown configId: ${params.configId}`);
    }
    return { configOptions: await this.buildAllConfigOptions(params.sessionId) };
  }
  async buildAllConfigOptions(sessionId) {
    const session = this.sessions.get(sessionId)!;
    const opts = [this.permissionService.buildModeConfigOption(session)];
    opts.push(await this.modelRegistry.buildModelConfigOption(session.runtime.currentModelId));
    const thinking = this.modelRegistry.buildThinkingConfigOption(session);
    if (thinking) opts.push(thinking);
    return opts;
  }
  ```
- All other callers of `modelRegistry.setSessionConfigOption` / `modelRegistry.buildAllConfigOptions` redirect to the agent's new public methods (need to grep — only the ACP handler today, per agent.ts:577–579).
- **Notification path is unchanged**: setters emit their domain event (`model_select`, `thinking_change` — verify thinking name — `mode_change` new); `src/acp/event-wiring.ts:37-51` already forwards `model_select` + `settings_change` to a `config_option_update` wire notification. Add a handler for `mode_change` that does the same thing. Goose ordering is automatic because the event-wiring forward is synchronous within the setter body, before the agent's handler returns.

## File-level inventory

### New source files
- `src/permissions/types.ts` — `AgentMode`, `ALL_AGENT_MODES`, `MODES_BY_PERMISSIVENESS`, `ToolCategory` (7-entry: `read | edit | search | execute | mcp | subagent | other`), `PermissionDecision`, `PermissionPattern`, `PermissionPolicy`, `ModePreset`, `ApprovalDecision`, `ModeRuntimeCapabilities`, per-mode `MODE_DISPLAY` constant (name + description).
- `src/permissions/presets.ts` — placeholder `ALLOW_ALL_PRESET` skeleton; full preset registry fills in across 030–060.
- `src/permissions/permission-service.ts` — `PermissionService` class. Constructor takes `{ sessions, events, appendEntry, capabilities, logger }`. Public surface: `buildModeConfigOption(session)`, `setMode(sessionId, modeId, reason)`, `getCurrentMode(sessionId)`, `evaluateToolCall(...)` (stub returns `{ kind: "allow" }`), `register()` returns `[]`.

### Touched source files
- `src/wire/constants.ts` — add `MODE_CONFIG_ID = "mode"` (sibling of MODEL_CONFIG_ID at line 2, THINKING_CONFIG_ID at line 20).
- `src/tools/index.ts` — expand `toolKindFor` return union to 7 categories; add `EDIT_TOOL_NAMES` constant; add `name.includes("__")` → `"mcp"` branch; add `subagent` → `"subagent"` branch; re-export `ToolCategory` from `src/permissions/types.ts`. **Verify** no downstream caller relies on the old union being exhaustively 5-wide.
- `src/settings/settings.ts` — add `defaultMode?: AgentMode` and `permission?: { approvalTimeoutMs?: number }` to `BodhiPiProjectSettings`.
- `src/acp/agent.ts` —
  - `BodhiPiConfig`: add `defaultMode?: AgentMode`, `allowsAllowAllMode?: boolean`, `allowsAllowAllModeAsDefault?: boolean`.
  - Constructor: validate `config.defaultMode === "allow-all"` against capabilities (throw on mismatch). Instantiate `PermissionService` alongside other domain services. Advertise `agentCapabilities._meta["bodhi-pi"].available.modes = true` (verify the `_meta` extension shape against current code).
  - Replace `setSessionConfigOption` handler at line 577 with the agent-owned dispatch switch.
  - Add `buildAllConfigOptions(sessionId)` private/public composer.
  - Include `configOptions` on `NewSessionResponse` / `LoadSessionResponse` / `ResumeSessionResponse` (verify whether already wired for model+thinking; if so, mode joins via the new composer).
- `src/models/registry.ts` — delete `configOptionSetters`, `setSessionConfigOption`, `buildAllConfigOptions`. Promote `buildModelConfigOption`, `buildThinkingConfigOption`, `setSessionModel`, `setSessionThinkingLevel` to public.
- `src/sessions/session-state.ts` — add `mode: AgentMode` to `SessionRuntime` (line 37–51 area).
- `src/sessions/entries.ts` — add `ModeChangeEntry` variant: `{ type: "mode_change", id, parentId, timestamp, mode: AgentMode, reason: "user" | "session_load" | "submit_plan_approved" | "settings_change" | "subagent_spawn" }`. Add to `SessionEntry` union (currently lines 112–123).
- `src/sessions/session-bootstrap.ts` — in `buildSessionState`, resolve initial mode via chain: `config.defaultMode` → `mergedSettings.defaultMode` (validate against capability; on mismatch log + fall through) → `"ask"`. Set `runtime.mode`.
- `src/sessions/build-context.ts` — add `mode_change` to the entry-type extractor (sets `currentMode` alongside `currentModelId` / `currentThinkingLevel` at lines 96–99). `mode_change` is metadata, NOT appended to LLM messages (mirrors `model_change` / `thinking_change`).
- `src/sessions/session-bootstrap.ts` (rehydrate path at lines 341–375) — read `currentMode` from `buildSessionContext`; if persisted is `"allow-all"` and current capability disallows, downgrade to bootstrap chain (log via `config.logger`).
- `src/events/types.ts` — extend `BodhiPiEvent` union with `ModeChangeEvent`, `ToolApprovalRequestEvent`, `ToolApprovalResponseEvent`. Both approval events carry `correlationId: string`. Extend `BodhiPiEventHandlers`.
- `src/acp/event-wiring.ts` — add handler for `mode_change` domain event → emit `session/update` with `sessionUpdate: "config_option_update"` carrying the full configOptions. Mirrors the existing `model_select` handler at lines 37–51.
- `src/index.ts` — re-export new public types/constants (`AgentMode`, `ALL_AGENT_MODES`, `MODES_BY_PERMISSIVENESS`, `ToolCategory`, `PermissionDecision`, `PermissionPolicy`, `ModePreset`, `ApprovalDecision`, `ModeRuntimeCapabilities`, `MODE_CONFIG_ID`).

### New test files
- `packages/bodhi-pi/test/modes-state.test.ts` — integration tests with faux provider via `createTestHarness`. Cases:
  1. Default new session is `"ask"`.
  2. `setSessionConfigOption({configId:"mode", value:"edit"})` mutates session, returns configOptions with mode first.
  3. Mode persists across `session/load` and `session/resume` via `mode_change` SessionEntry.
  4. `allowsAllowAllMode: false` → setMode to allow-all rejects with `-32603`.
  5. `allowsAllowAllMode: true` → setMode to allow-all succeeds.
  6. `defaultMode: "allow-all"` in settings + `allowsAllowAllModeAsDefault: false` → logged error, falls through to `"ask"`; capability error visible in logger spy.
  7. Unknown `defaultMode` value in settings → logged warning, falls through.
  8. `BodhiPiConfig.defaultMode = "allow-all"` + capability false → factory throws.
  9. `setMode` called with current mode → still appends entry + emits event (non-idempotent per user decision).
  10. `mode_change` SessionEntry is filtered out of LLM context (assert via `buildSessionContext`).
  11. `config_option_update` notification fires before `setSessionConfigOption` returns (assert ordering via recorded notification stream).
- `packages/bodhi-pi/test/permissions-types.test.ts` — smoke tests that the type surface compiles + constants have expected entries.
- `packages/bodhi-pi/test/tools-categorisation.test.ts` — `toolKindFor` returns `mcp` for `name.includes("__")`; `subagent` for `"subagent"`; existing 5 categories unchanged for known tool names.
- `packages/bodhi-pi/e2e/modes-state.e2e.ts` — single round-trip with `gpt-4o-mini`: newSession → setSessionConfigOption(mode=edit) → verify configOptions contains mode=edit → close + reopen → verify mode persists. Pure wire-state proof; no policy.
- `packages/bodhi-pi-cli/e2e/modes-state.e2e.ts` — spawn CLI, send `/modes` (assert tabulated output), `/mode edit` (assert badge update + `mode switched to: edit`), reopen REPL and verify badge.
- `packages/bodhi-pi-http/test/integration/modes-state.test.ts` — per-turn-rebuild round-trip. Set mode via HTTP setSessionConfigOption; prompt; verify mode survives rebuild by reading next configOptions.
- `packages/bodhi-pi-browser/e2e/modes-state.spec.ts` — Playwright. Type `/mode edit` in chat input; assert StatusBar mode badge updates; reload page; assert badge persists.
- `packages/bodhi-pi-chrome-ext/e2e/modes-state.spec.ts` — Playwright. Same as browser, in chrome-ext shell.

(Test templates to copy: `packages/bodhi-pi/test/session-config-ext.test.ts` for integration; `packages/bodhi-pi-cli/test/commands.test.ts:41-74` for CLI harness; `packages/bodhi-pi-web/e2e/model-switch.spec.ts` for Playwright.)

### Touched host files
- `packages/bodhi-pi-cli/src/repl/commands.ts:220-238` — add `/mode` and `/modes` cases mirroring the `/model` block. `/mode <id>` calls `ctx.client.setSessionConfigOption({sessionId, configId:"mode", value:id})`. `/modes` prints the list with current marker.
- `packages/bodhi-pi-cli/src/repl/repl.ts:~105` (prompt rendering) — append mode badge to the readline prompt (e.g. `chalk.cyan(mode)` prefix). Read mode from the maintained client state mirror.
- `packages/bodhi-pi-cli/src/repl/*` — extend the client-state mirror (currently tracks `models`, `currentModelId`) with `currentMode: AgentMode` synced from `configOptions[0]` after each setSessionConfigOption response and on session bootstrap.
- `packages/bodhi-pi-http/src/frontend/ui/commands.ts:96-123` — add `/mode` + `/modes` cases mirroring `/model`. Calls `client.setSessionConfigOption({...configId:"mode"...})`.
- `packages/bodhi-pi-http/src/frontend/components/StatusBar.tsx` — add `mode: <strong>{currentMode}</strong>` badge alongside model badge. Wire `currentMode` through props from chat context.
- `packages/bodhi-pi-browser/src/ui/commands.ts:97-115` — add `/mode` + `/modes`. Browser's commands uses `ctx.client.model(modelId)` direct API today for /model; for /mode it should call `ctx.client.setSessionConfigOption(...)`. **Verify**: if `BodhiPiClient` doesn't expose `setSessionConfigOption` directly today, add the thin pass-through method.
- `packages/bodhi-pi-browser/src/ui/StatusBar.tsx:26` — add `<span className="status-bar-mode">mode: {currentMode}</span>` next to existing model badge. Read `currentMode` from `useChatStore()`.
- `packages/bodhi-pi-browser/src/ui/store.ts` (or equivalent) — add `currentMode: AgentMode` to chat store; populate from session bootstrap + setSessionConfigOption responses.
- `packages/bodhi-pi-chrome-ext/` — inherits all of the above via `@bodhiapp/bodhi-pi-browser`. No code changes; verify build picks up.
- Each host factory file (where `BodhiPiConfig` is constructed) — set `allowsAllowAllMode: true`, `allowsAllowAllModeAsDefault: false`.

### Spec docs
- **NEW** `ai-docs/specs/bodhi-pi/modes.md` — canonical reference. Sections: (1) Mode taxonomy (4 modes + description). (2) Architecture (agent owns policy + persistence). (3) ACP-native surface (table: use vs avoid). (4) Implementation status table (010-090 rows; 010 ☑ + 020 ☑ after this phase).
- `ai-docs/specs/bodhi-pi/index.md` — add "Read-this-if" row: "What modes does bodhi-pi support, how do permissions work?" → `modes.md`.
- `ai-docs/specs/bodhi-pi/configuration.md` — document `BodhiPiConfig.defaultMode/allowsAllowAllMode/allowsAllowAllModeAsDefault` and `BodhiPiProjectSettings.defaultMode/permission.approvalTimeoutMs`.
- `ai-docs/specs/bodhi-pi/architecture.md` — add `PermissionService` row to services table; describe the dispatch-ownership refactor (`BodhiPiAcpAgent` owns `setSessionConfigOption` dispatch, services own their own setter+builder per configId).
- `ai-docs/specs/bodhi-pi/lifecycle.md` — add `mode_change` row to SessionEntry table.
- `ai-docs/specs/bodhi-pi/acp.md` — mention `setSessionConfigOption` accepts `configId: "mode"`; `session/update { sessionUpdate: "config_option_update" }` emitted from agent side on every successful set.
- `ai-docs/specs/bodhi-pi/extensions-skills-commands.md` — line 90 footnote: Permissioner lands across milestones 010-030 (Phase 0 ships the foundation).
- `ai-docs/specs/bodhi-pi/hosts.md` — document per-host capability defaults.

### Other
- `ai-docs/prompts/2026-05-19-bodhi-pi-modes-p0-foundation.md` — correct path drift (`test-apps/` → `packages/bodhi-pi-*/`) and line-number drift (registry dispatch 218–225 not 217–236; constructor 196–308 not 185–315; setSessionConfigOption handler line 577 not 583). User requested this fix in the grilling round.

## Commit slice (C0–C8)

Each commit ends green on `npm run check` + the relevant test slices. Each is individually bisectable. Conform to `feedback_atomic_commit_with_reset`: single chained `git reset . && git add <paths> && git commit ...`.

| # | Subject | Contents | Gate |
|---|---|---|---|
| C0 | `bodhi-pi modes p0 prep: correct kickoff path + line-number drift` | Edit `ai-docs/prompts/2026-05-19-bodhi-pi-modes-p0-foundation.md` only. | none (docs) |
| C1 | `bodhi-pi modes p0 010: types + tool-cat expansion + settings schema + event-type declarations + spec scaffold` | `src/permissions/types.ts` (new), `src/permissions/presets.ts` (new, skeleton only), `src/tools/index.ts` (toolKindFor expansion), `src/settings/settings.ts` (defaultMode + permission.approvalTimeoutMs), `src/events/types.ts` (3 new event variants), `src/acp/agent.ts` interface only (BodhiPiConfig gains 3 fields, no behaviour change yet), `src/index.ts` re-exports, `src/wire/constants.ts` (MODE_CONFIG_ID), spec scaffold: `modes.md` (new), `index.md`, `configuration.md`. NO `PermissionService` class yet, NO state on SessionState, NO behaviour. Tests: `permissions-types.test.ts`, `tools-categorisation.test.ts`. | `npm run check && npm test -- permissions-types tools-categorisation` |
| C2 | `bodhi-pi modes p0 020a: lift setSessionConfigOption dispatch from ModelRegistry to BodhiPiAcpAgent (refactor)` | The refactor in isolation, no mode added yet. `src/models/registry.ts`: drop `configOptionSetters`, `setSessionConfigOption`, `buildAllConfigOptions`; promote private builders + setters to public. `src/acp/agent.ts`: own the dispatch switch (2-way: model + thinking) + own `buildAllConfigOptions`. Update all internal callers. **All existing model+thinking tests stay green** — pure refactor. | `npm run check && npm test` (full suite, expect zero regressions) |
| C3 | `bodhi-pi modes p0 020b: PermissionService skeleton + SessionState.runtime.mode + ModeChangeEntry + bootstrap chain` | `src/permissions/permission-service.ts` (new; setMode, buildModeConfigOption, getCurrentMode, evaluateToolCall stub). `src/sessions/session-state.ts` (mode field). `src/sessions/entries.ts` (ModeChangeEntry). `src/sessions/build-context.ts` (extract currentMode; filter from LLM context). `src/sessions/session-bootstrap.ts` (default-mode resolution chain in buildSessionState + rehydrateSession). `src/acp/agent.ts` (instantiate PermissionService; wire into dispatch + composer; factory-time validation throws). Integration test cases 1, 2, 3, 8, 10. | `npm run check && npm test -- modes-state` |
| C4 | `bodhi-pi modes p0 020c: capability gates + config_option_update notification + lifecycle event emit` | `setMode` rejects `allow-all` with `-32603` when capability false. `buildModeConfigOption` omits `allow-all` when capability false. Bootstrap path logs + falls through for settings-side `allow-all` when capability false. `src/acp/event-wiring.ts` adds `mode_change` → `config_option_update` forward. Integration test cases 4, 5, 6, 7, 9, 11. | `npm run check && npm test -- modes-state` |
| C5 | `bodhi-pi modes p0 020d: e2e (gpt-4o-mini) round-trip` | `packages/bodhi-pi/e2e/modes-state.e2e.ts`. Confirms wire works through a real ACP connection. | `npm run check && just test-e2e modes-state` |
| C6 | `bodhi-pi-cli modes p0: /mode + /modes slashes + footer badge + e2e` | CLI host wiring + `packages/bodhi-pi-cli/e2e/modes-state.e2e.ts`. Capability defaults set in cli host factory. | `npm run check && npm test --workspace bodhi-pi-cli && just test-e2e bodhi-pi-cli/modes-state` |
| C7 | `bodhi-pi-http modes p0: /mode + /modes + StatusBar badge + per-turn-rebuild integration` | HTTP frontend slash + StatusBar badge + `packages/bodhi-pi-http/test/integration/modes-state.test.ts`. Capability defaults set in http host factory. | `npm run check && npm test --workspace bodhi-pi-http` |
| C8 | `bodhi-pi-browser + chrome-ext modes p0: slashes + StatusBar badge + Playwright` | `bodhi-pi-browser` slash + StatusBar + store update. chrome-ext picks up automatically. Playwright specs in both packages. Capability defaults in both host factories. Spec docs finalisation: `acp.md`, `architecture.md`, `lifecycle.md`, `hosts.md`, `extensions-skills-commands.md`, modes.md table flips 010+020 = ☑. | `npm run check && just test-e2e-ui modes-state` |

## Verification matrix

After each commit, run the gate. After C8, run the full matrix:

| Runtime | Command |
|---|---|
| bodhi-pi core (integration) | `npm test --workspace=packages/bodhi-pi -- modes-state permissions-types tools-categorisation` |
| bodhi-pi core (e2e, gpt-4o-mini) | `just test-e2e modes-state` |
| bodhi-pi-cli (e2e) | `just test-e2e bodhi-pi-cli/modes-state` |
| bodhi-pi-http (integration) | `npm test --workspace=packages/bodhi-pi-http -- modes-state` |
| bodhi-pi-browser (Playwright) | `just test-e2e-ui bodhi-pi-browser/modes-state` |
| bodhi-pi-chrome-ext (Playwright) | `just test-e2e-ui bodhi-pi-chrome-ext/modes-state` |
| full check | `npm run check` |

## Risk register

1. **Dispatch refactor blast radius** (C2). Touches the ACP `setSessionConfigOption` handler — the wire shape doesn't change, but internal callers of `ModelRegistry.setSessionConfigOption` / `buildAllConfigOptions` (if any beyond `agent.ts:577–579`) need to be redirected. Mitigation: pre-C2 grep `setSessionConfigOption\|buildAllConfigOptions` across the repo; redirect every caller. C2 lands as a pure refactor with zero behaviour change and the full test suite green.
2. **`config_option_update` emission breaking session-update count assertions**. Today, model+thinking changes already emit `config_option_update` via `event-wiring.ts:37-51` (`model_select` → forward). So this is NOT new behaviour — existing tests already tolerate it. Mode joins the same chain. Mitigation: search existing tests for hardcoded session-update counts; verify none break. If any do, fix the assertion (the test was over-specifying anyway).
3. **`BodhiPiClient.setSessionConfigOption` not exposed in browser/cli mirrors**. Some host packages use a wrapped `client.model(modelId)` helper rather than calling `setSessionConfigOption` directly. Mitigation: in C2 prep, audit each host's client wrapper; add a thin `client.mode(modeId)` helper or have hosts call `setSessionConfigOption` directly with `configId: "mode"`.
4. **Test harness `requestPermission: cancelled` stub** at `test/helpers/harness.ts:82`. No Phase 0 code path triggers `requestPermission`. Mitigation: add an assertion in C3 integration tests that `requestPermission` is never called.
5. **ACP SDK version**. `@agentclientprotocol/sdk@^0.21.0` already has `ConfigOptionUpdate`, `RequestPermissionRequest`, `SessionMode`, `SessionConfigOption`. No bump needed for Phase 0. Phase 030 may need to revisit.
6. **Mode resolution under host capability mismatch on resume** (e.g. session created in CLI with allowsAllowAllMode=true, persisted as `allow-all`, resumed under HTTP with allowsAllowAllMode=false). Mitigation: silent downgrade to bootstrap chain in `rehydrateSession`, log via `config.logger`. Documented in `modes.md`.

## Out of scope (explicit)

- **Policy enforcement** — every tool runs unconditionally in Phase 0. Milestone 030.
- **`session/request_permission` invocation** — no permission round-trips. Milestone 030.
- **`submit_plan` tool** — milestone 050.
- **`allow-all` semantics beyond the capability gate** — milestone 060.
- **Sub-agent mode inheritance** — milestone 070.
- **Active-tools swap** — milestone 080.
- **Persistent rules (alwaysAllow / alwaysDeny)** — milestone 090.
- **Interactive mode dropdown selector in UI** — Phase 0 ships read-only badge + slash commands only. Dropdown lands in 030 when mode does something.
- **Removing the existing `currentModelId` / `thinkingLevel` redundancy on `_bodhi-pi/session/config`** — flagged as tech-debt during grilling. Pre-existing; orthogonal to mode. Recommended follow-up commit separate from the foundation slab.
- **`subagent_batch` tool category** — surface was deleted in `e136c804`; no forward-compat hedge per user's clean-code stance.

## Follow-ups (post-Phase-0, not in this plan)

1. `_bodhi-pi/session/config` redundancy cleanup: drop direct `currentModelId` / `thinkingLevel` fields and have all hosts walk `configOptions[]` instead. Aligns with the mode decision to NOT add a `mode` field. Separate plan.
2. Milestone 030 kickoff prompt — to write after Phase 0 lands and the retrospective is captured.
3. `ai-docs/modes/p0-retrospective.md` — capture what surprised, what carried forward, what got punted. Match the sub-agents `v1-retrospective.md` precedent.

## When done

Per kickoff: print the plan path, count of open questions resolved during grilling, and proposed commit subjects in order.

- Plan path: `ai-docs/plans/ai-docs-prompts-2026-05-19-bodhi-pi-mod-silly-sedgewick.md`
- Open questions resolved: 8 (across 2 grilling rounds: dispatch ownership, config-read shape, UI scope, kickoff drift fix, setMode idempotency, session/config mode field shape, host capability defaults, tool-category forward-compat)
- Commit subjects in order:
  1. `bodhi-pi modes p0 prep: correct kickoff path + line-number drift`
  2. `bodhi-pi modes p0 010: types + tool-cat expansion + settings schema + event-type declarations + spec scaffold`
  3. `bodhi-pi modes p0 020a: lift setSessionConfigOption dispatch from ModelRegistry to BodhiPiAcpAgent (refactor)`
  4. `bodhi-pi modes p0 020b: PermissionService skeleton + SessionState.runtime.mode + ModeChangeEntry + bootstrap chain`
  5. `bodhi-pi modes p0 020c: capability gates + config_option_update notification + lifecycle event emit`
  6. `bodhi-pi modes p0 020d: e2e (gpt-4o-mini) round-trip`
  7. `bodhi-pi-cli modes p0: /mode + /modes slashes + footer badge + e2e`
  8. `bodhi-pi-http modes p0: /mode + /modes + StatusBar badge + per-turn-rebuild integration`
  9. `bodhi-pi-browser + chrome-ext modes p0: slashes + StatusBar badge + Playwright + spec finalisation`
