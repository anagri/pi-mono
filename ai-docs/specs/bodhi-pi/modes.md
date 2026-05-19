# Modes & permissions

> **Status — Phase 0 (foundation slab)**: mode state is settable, persisted, advertised, and
> observable across all four reference Hosts. **No policy enforcement.** Every tool still runs
> unconditionally. Milestone 030 layers enforcement on top.

## Mode taxonomy

| Mode | Default | Description |
|---|---|---|
| `ask` | yes | Request permission for edits, shell, MCP, sub-agents. (Phase 0: no requests fire.) |
| `plan` | | Read-only — explore and propose without touching the workspace. |
| `edit` | | Allow file edits; still ask for shell, MCP, sub-agents. |
| `allow-all` | | Run every tool without asking. Gated by `allowsAllowAllMode` host capability. |

Permissiveness ordering (low → high): `plan < ask < edit < allow-all`. Constant in `src/permissions/types.ts`.

## Architecture

Bodhi-pi owns the agent side of every read/write decision (mirrors cc / Codex / Pi — opposite from
Goose which routes filesystem through ACP). Policy data + persisted rules live agent-side.

| Concern | Where it lives |
|---|---|
| Mode vocabulary + presets | `src/permissions/types.ts`, `src/permissions/presets.ts` |
| Mode state on a session | `SessionState.runtime.mode` (`src/sessions/session-state.ts`) |
| Mode change entry | `ModeChangeEntry` in `src/sessions/entries.ts` (filtered out of LLM context) |
| Bootstrap chain | `resolveInitialMode` in `src/sessions/session-bootstrap.ts` |
| `setMode` + `buildModeConfigOption` | `PermissionService` (`src/permissions/permission-service.ts`) |
| Wire dispatch | `BodhiPiAcpAgent.setSessionConfigOption` switches over `configId` and delegates per service |
| Wire notification | `mode_change` domain event → `event-wiring.ts` forwards as `config_option_update` |
| Tool category fan-out | `toolKindFor` in `src/tools/index.ts` (`read | edit | search | execute | mcp | subagent | other`) |

### Dispatch ownership (refactor delivered alongside this phase)

Pre-Phase-0 the entire `setSessionConfigOption` dispatch table lived inside `ModelRegistry`.
Adding mode (owned by `PermissionService`) would have created a circular service dependency.
Phase 0 lifts the dispatch up to `BodhiPiAcpAgent`:

- `ModelRegistry` exposes `buildModelConfigOption` / `buildThinkingConfigOption` / `setSessionModel` /
  `setSessionThinkingLevel` as public.
- `PermissionService` exposes `buildModeConfigOption` / `setMode`.
- `BodhiPiAcpAgent.setSessionConfigOption(params)` switches on `params.configId` and delegates.
- `BodhiPiAcpAgent.buildAllConfigOptions(sessionId)` composes mode first, then model, then optional thinking.

Future config-ids (profile, agent axes, …) plug in by exposing a builder + setter on their owning service.

## ACP-native wire surface

| Concern | Method / sessionUpdate | Notes |
|---|---|---|
| Advertise mode | `configOptions: [{ id: "mode", category: "mode", type: "select", ... }]` on `NewSessionResponse` / `LoadSessionResponse` / `ResumeSessionResponse` | First option (highest priority). |
| Change mode | `session/setSessionConfigOption { configId: "mode", value: <id> }` | Same surface as model + thinking. |
| Notify change | `session/update { sessionUpdate: "config_option_update", configOptions: [...] }` | Fires *before* the request response so subscribers see the update via either rail. |
| Read mode | Walk `configOptions[]` (no separate `_bodhi-pi/session/config` field) | Avoids duplicate state. |

### Deprecated paths — DO NOT IMPLEMENT

- `session/setSessionMode` — superseded by `setSessionConfigOption`.
- `session/update { sessionUpdate: "current_mode_update" }` — superseded by `config_option_update`.
- `modes: SessionModeState` legacy field on session responses — superseded by `configOptions[]`.
- `_bodhi-pi/mode/*` extension methods — none exist; mode change rides ACP-native.
- `_bodhi-pi/permission/*` extension methods — milestone 030 uses ACP-native `session/request_permission`.

## Capabilities

Two independent host opt-in flags on `BodhiPiConfig`:

- `allowsAllowAllMode: boolean` (default `false`) — gates ad-hoc `setSessionConfigOption("mode", "allow-all")`.
  When `false`, the option is omitted from the advertised list AND the setter rejects with `-32603`
  as defence in depth.
- `allowsAllowAllModeAsDefault: boolean` (default `false`) — gates `settings.defaultMode = "allow-all"`
  at bootstrap. Host-explicit `BodhiPiConfig.defaultMode = "allow-all"` requires BOTH flags and throws
  at factory time on mismatch.

Reference Host defaults:

| Host | `allowsAllowAllMode` | `allowsAllowAllModeAsDefault` |
|---|---|---|
| `test-apps/cli` | true | false |
| `test-apps/http` | true | false |
| `test-apps/browser` | true | false |
| `test-apps/chrome-ext` (via shared browser bootstrap) | true | false |

The two-step opt-in pattern lets PoCs demonstrate mode feasibility without exposing an always-on
unsafe default. Production hosts choose their own defaults.

## Default-mode resolution at session boot

Chain (first match wins):

1. **Restored** (rehydrate path only) — `currentMode` extracted from the most recent `mode_change`
   entry on the active branch. If the persisted value is `"allow-all"` but `allowsAllowAllMode` is
   disabled on the current host, log via `config.logger` and fall through.
2. **Host-explicit** — `BodhiPiConfig.defaultMode` if set. `"allow-all"` requires both capability
   flags (factory throws otherwise).
3. **Settings** — `mergedFileSettings.defaultMode` if a valid `AgentMode`. Invalid values log a
   warning and fall through. `"allow-all"` requires `allowsAllowAllModeAsDefault` (logs an error
   and falls through otherwise).
4. **Fallback** — `"ask"` (principle of least privilege).

## SessionEntry shape

```ts
interface ModeChangeEntry extends BaseEntry {
  type: "mode_change";
  mode: AgentMode;
  reason: "user" | "session_load" | "submit_plan_approved" | "settings_change" | "subagent_spawn";
}
```

Reason union is forward-compat. Phase 0 emits only `"user"` (via `PermissionService.setMode`).

`mode_change` entries are metadata — filtered out of LLM context by `buildSessionContext` (same
treatment as `model_change` / `thinking_change`).

## In-process lifecycle events

Three new events on `EventDispatcher` (`src/events/types.ts`):

- `mode_change` (emitted in Phase 0 via `setMode`) — `{ sessionId, fromMode, toMode, reason }`.
- `tool_approval_request` (declared, NOT emitted in Phase 0) — `{ sessionId, correlationId, toolCallId, toolName, category, pattern, timeoutMs }`.
- `tool_approval_response` (declared, NOT emitted in Phase 0) — `{ sessionId, correlationId, toolCallId, toolName, kind }`.

Both approval events carry `correlationId: string` so extensions can match request → response cleanly.

**Wire view**: `mode_change` is forwarded to the wire as a native `config_option_update`
`SessionUpdate` (NOT through `LIFECYCLE_EVENT_METHOD`). The approval events will route through
`session/request_permission` in Phase 1.

## Per-Host UI

Phase 0 ships read-only visual surface + slash commands. No interactive dropdown yet.

| Host | Surface |
|---|---|
| `test-apps/cli` | `/mode <id>` + `/modes` slashes; prompt prefix shows current mode `[ask] >`. |
| `test-apps/http` | `/mode <id>` + `/modes` slashes via shared browser AppShell; StatusBar shows `mode: ask`. |
| `test-apps/browser` | Same as http (shared AppShell). |
| `test-apps/chrome-ext` | Inherits via `@bodhiapp/bodhi-pi-test-app-browser`. |

`data-current-mode` attribute on the StatusBar exposes the mode for Playwright assertions.

## Implementation status

| Milestone | Status | Description |
|---|---|---|
| 010 — ground prep (types + tool-cat + event types + settings schema) | ☑ | Phase 0 |
| 020 — mode-state + setSessionConfigOption | ☑ | Phase 0 |
| 030 — plan-mode plumbing (preset + evaluator + gate + suffix + tool_blocked + custom_message renderers) | ☑ | Phase 1 |
| 040 — ask-mode `request_permission` round-trip | ☐ | |
| 050 — edit-mode preset + fine-grained patterns | ☐ | |
| 060 — plan-mode `submit_plan` + 3-option approval UI + plan→edit auto-transition | ☐ | |
| 070 — allow-all semantics & guardrails | ☐ | |
| 080 — sub-agent profile mode field + Qwen inheritance rule | ☐ | |
| 090 — active-tools swap (vs gate-at-call-time) | ☐ | |
| 100 — persistent rules (`alwaysAllow` / `alwaysDeny`) | ☐ | |

### Phase 1 deliverables (milestone 030 — locked-in scope)

- `MODE_PRESETS.plan.policy.categories` filled per the locked table:
  `read`/`search`/`subagent` allow; `edit`/`execute`/`other` deny;
  `mcp` per-annotation (read MCP SDK `annotations.readOnlyHint` /
  `destructiveHint`; research-permissive default-allow on absent).
- `MODE_PRESETS.plan.systemPromptSuffix` appended to `composeSystemPrompt`
  after the existing `appendSystemPrompt` at session boot. Mid-session
  `/mode plan` does NOT rebuild the prompt — convergent CC/Codex/OpenCode/
  Roo pattern: rely on the `tool_result.isError` amendment text alone.
- `PermissionService.evaluateToolCall(sessionId, toolCall: { name, arguments })`
  is the gate. Returns `{ kind: "allow" }` or `{ kind: "deny", reason }`.
- `createPiAgent.beforeToolCall` calls the gate AFTER the existing
  `tool_call` event. On deny: emits a `tool_blocked` lifecycle event,
  appends a `custom_message` entry (`extensionName: "modes"`,
  `customType: "tool_blocked"`, `display: true`), and returns
  `{ block: true, reason }` so pi-agent-core constructs an `isError`
  tool-result with the redirect text.
- Block redirect template:
  `"plan mode is read-only — \`{toolName}\` blocked (category: {category}). Use read-only tools or \`/mode edit\` to proceed."`
- `ToolBlockedEvent { sessionId, toolCallId, toolName, category, mode, reason }`
  fires via `LIFECYCLE_EVENT_METHOD`. No `correlationId` (one-shot — no
  wire round-trip).
- Sub-agent: child inherits `parent.runtime.mode` unconditionally (already
  wired in 020). `SubagentProfile.mode?` field + Qwen-rule combinator
  land in milestone 080.
- 4-Host rendering: cli + browser + http + chrome-ext now have minimal
  `tool_blocked` chat rendering (CLI yellow banner; browser/chrome-ext/http
  reuse `AppShell` to push a `[data-testid="custom-message"][data-test-state="tool-blocked"]`
  system message). Ask/edit/allow-all enforcement stays inert in this phase.

## References

- Research wave: `ai-docs/research/modes/` (000-overview, 005-acp-architecture-decision, 010-100).
- Source: `src/permissions/`, `src/sessions/session-bootstrap.ts`, `src/acp/agent.ts`, `src/acp/event-wiring.ts`, `src/mcp/`.
- Tests: `test/modes-state.test.ts`, `test/permissions-types.test.ts`, `test/tools-categorisation.test.ts`, `test/plan-mode-policy.test.ts`, `test/plan-mode-mcp.test.ts`, `test/plan-mode-subagent.test.ts`, `src/permissions/permission-evaluator.test.ts`, `src/mcp/mcp-registry.test.ts`.
- E2E: `e2e/shared/mode.e2e.ts`, `e2e/shared/plan-mode.e2e.ts`.
- Playwright: `e2e-ui/shared/mode-switch.spec.ts`, `e2e-ui/shared/plan-mode.spec.ts`.
