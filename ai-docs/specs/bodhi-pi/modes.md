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
`SessionUpdate` (NOT through `LIFECYCLE_EVENT_METHOD`). The approval round-trip itself rides native
`session/request_permission` (request/response). As of milestone 040 the two approval events are
ALSO forwarded as `LIFECYCLE_EVENT_METHOD` notifications (mirroring `tool_blocked`) so remote Clients
and e2e/Playwright suites can observe the request → response pair on the wire.

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
| 040 — ask-mode `request_permission` round-trip | ☑ | Phase 2 |
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

### Phase 2 deliverables (milestone 040 — ask mode + approval round-trip)

- `MODE_PRESETS.ask.policy.categories` filled: `read`/`search`/`subagent` allow;
  `edit`/`execute`/`mcp`/`other` ask. Subagent AUTO-ALLOWS — a parent→child
  `subagent` call does not prompt (child still gates its own tools).
- `PermissionService.evaluateToolCall` resolves an `ask`-category call internally
  (the public return stays `allow | deny`): it checks `runtime.permissionGrants`
  first, else emits a pending `tool_call` card (`status: "pending"`) + a
  `tool_approval_request` lifecycle event, then awaits `conn.requestPermission`
  raced against `runtime.approvalTimeoutMs` (default 30000) and `session/cancel`.
  It decodes the verdict, records `*_always` grants, emits `tool_approval_response`,
  and returns `allow`/`deny`. The 030 gate is unchanged — a `deny` reuses the
  existing `tool_blocked` + `custom_message` path (which also flips the pending card
  to `failed`).
- 4 approval options: `allow_once`, `allow_always`, `reject_once`, `reject_always`
  (6-option scope-encoding deferred to milestone 100). On reject BOTH
  `tool_approval_response{kind:"reject_*"}` and `tool_blocked` fire.
- `runtime.permissionGrants: Map<toolName, "allow"|"deny">` is in-memory, per-session,
  cleared on `setMode` (no cross-mode leak), and NOT inherited by child sessions.
  KV persistence + glob patterns are milestone 100.
- MCP: `evaluateMcpTool` honors ask — `readOnlyHint===true` auto-allows; otherwise the
  call runs the same approval round-trip.
- `tool_approval_request` / `tool_approval_response` forward via `LIFECYCLE_EVENT_METHOD`.
- Compaction is NOT gated (its summarization is tool-less direct model calls; the
  `beforeToolCall` hook never fires during compaction — no bypass flag is needed).
- Approval flow:

```mermaid
sequenceDiagram
  participant Gate as beforeToolCall (030, unchanged)
  participant PS as PermissionService
  participant Conn as conn (ACP)
  participant Cli as Client
  Gate->>PS: evaluateToolCall(sid, {id,name,args})
  alt allow category / known grant
    PS-->>Gate: allow | deny (no prompt)
  else ask category
    PS->>Conn: sessionUpdate(tool_call, status:"pending")
    PS->>PS: emit tool_approval_request (→ wire)
    PS->>Conn: requestPermission(toolCall, 4 options)
    Conn->>Cli: session/request_permission
    Note over PS: race( response , timeout , cancel )
    Cli-->>PS: selected{optionId} | cancelled
    PS->>PS: decode → kind; record *_always grant
    PS->>PS: emit tool_approval_response (→ wire)
    PS-->>Gate: allow (allow_*) | deny (reject_*/cancel/timeout)
  end
```

### Test-app drivers (no UI modals — `test-apps/CLAUDE.md` doctrine)

- Vitest: harness `requestPermission` reads `autoApproveAll` (default `true` →
  `allow_once`) or a per-test `approvalResponses` FIFO queue.
- Playwright + CLI: a Client-side pending-approval registry decodes a composer-typed
  `/approve [once|always]` / `/reject [once|always]` into the `RequestPermissionResponse`.
- HTTP+SSE cannot carry `requestPermission` (server→client request); the WS transport
  covers the HTTP runtime for approvals. Documented gap; SSE bridge deferred.

## References

- Research wave: `ai-docs/research/modes/` (000-overview, 005-acp-architecture-decision, 010-100).
- Source: `src/permissions/`, `src/sessions/session-bootstrap.ts`, `src/acp/agent.ts`, `src/acp/event-wiring.ts`, `src/mcp/`.
- Tests: `test/modes-state.test.ts`, `test/permissions-types.test.ts`, `test/tools-categorisation.test.ts`, `test/plan-mode-policy.test.ts`, `test/plan-mode-mcp.test.ts`, `test/plan-mode-subagent.test.ts`, `test/ask-mode-policy.test.ts`, `test/ask-mode-approval-flow.test.ts`, `src/permissions/permission-evaluator.test.ts`, `src/mcp/mcp-registry.test.ts`.
- E2E: `e2e/shared/mode.e2e.ts`, `e2e/shared/plan-mode.e2e.ts`, `e2e/shared/ask-mode.e2e.ts`.
- Playwright: `e2e-ui/shared/mode-switch.spec.ts`, `e2e-ui/shared/plan-mode.spec.ts`, `e2e-ui/shared/ask-mode.spec.ts`.
