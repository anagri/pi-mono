# Bodhi-Pi current-state notes — modes & permissions

**Verdict: bodhi-pi `main` has no mode or permission concept whatsoever.** No `Mode`, `PermissionMode`, `ApprovalPolicy`, `autoApprove`, or YOLO surface. Every built-in tool runs unconditionally when the model invokes it.

## What exists that the mode system will plug into

### Built-in tools (`src/tools/index.ts`)

`createBuiltinTools({ filesystem, cwd, scriptExecutor?, terminal?, subagent? })` returns an unconditional list:

```ts
const tools: AgentTool[] = [
  createReadTool(deps), createWriteTool(deps), createEditTool(deps),
  createLsTool(deps), createFindTool(deps), createGrepTool(deps),
];
if (deps.scriptExecutor) tools.push(createRunScriptTool(deps));
if (deps.terminal)      tools.push(createBashTool(deps));
if (deps.subagent && deps.subagent.profiles.length > 0)
                        tools.push(createSubagentTool(deps.subagent));
```

`toolKindFor(name)` already classifies tools into `read | edit | search | execute | other` — that's exactly the **tool-group** axis modes will filter on (cf. Roo Code's `read / edit / browser / command / mcp` groups).

### Tool-call gating hook (`src/events/types.ts:142-153`)

The extension event surface **already includes a block-on-tool-call return shape**:

```ts
export interface ToolCallEvent { type: "tool_call"; sessionId; toolCallId; toolName;
  /** Mutable in place — handlers may rewrite arguments before tool executes. */
  input: Record<string, unknown>;
}
export interface ToolCallEventResult { block?: boolean; reason?: string; }
```

This is the **same primitive Plannotator's pi-extension uses** to enforce plan-mode write restrictions in `pi-coding-agent`. Bodhi-pi's `ToolCallEventResult.block` already lets an extension veto a tool call before it runs. A first-cut mode implementation can be entirely an extension; the question is whether the mode system should be promoted to core.

### System-prompt mutation hook (`src/events/types.ts:61-70`)

```ts
export interface BeforeAgentStartEventResult { systemPrompt?: string; userPrompt?: string; }
```

Plan-mode prompt injection (planner persona, "do not edit code", checklist conventions) goes here. Already wired in `prompt-loop.ts:64-72`.

### Session settings layers (`src/wire/constants.ts:65-72`)

```
_bodhi-pi/session/settings/{get,set,unset,list}  (scope: global|project|session|effective)
```

A persisted mode setting (`mode: "plan"`, `permission.edit: "deny"`, etc.) can ride this without inventing a new persistence path. Settings is the right home for **default mode** and **persistent allow/deny rules**; ephemeral session-scoped mode toggles live in `SessionState` (in-memory).

### Lifecycle events on both rails (`CLAUDE.md` architecture pillar)

Any new mode/permission lifecycle must:
1. Define typed event on `EventDispatcher` (`src/events/types.ts`)
2. Forward via `notifyLifecycle(...)` → `conn.extNotification(LIFECYCLE_EVENT_METHOD, params)` (`src/acp/event-wiring.ts`)
3. Document in `ai-docs/specs/bodhi-pi/acp.md`
4. Add regression test that asserts on `harness.extNotifications`

That gives extensions, hosts, web UIs, and Chrome-ext panels symmetric access — critical for the **multi-runtime parity rule** (must work in cli + http + browser worker + chrome-ext MV3).

### Sub-agent surface (already shipped — `src/subagents/`)

`SubagentProfile` already carries `tools?: string[]` (allowlist over built-ins), `model?`, `context: "fresh" | "fork"`, `max-turns`. Profile-driven tool restriction is **the same lever modes need** — modes just narrow the parent session's tool set, profiles narrow a child's. The mode system can reuse the profile-tool-allowlist code path (and the `validateAndNormalizeProfile` validation pipeline) for mode-tool filtering.

`SubagentService.spawn` already builds a child `piAgent` with filtered tools; the same `buildChildSessionState` is the model for "rebuild active tool set when mode changes mid-session" (if we choose live tool-set swap over a permission-time block).

## What's missing that mode work has to add

### 1. Runtime tool-set override

Plannotator's pi-extension does `pi.setActiveTools(toolList)` / `pi.getActiveTools()` to swap the tool list when entering/exiting plan mode (pi-extension/index.ts:282, 313, 327-335, 1282). **Bodhi-pi's `ExtensionAPI` has no equivalent.** Today, the active tool set is wired once at session bootstrap (`createBuiltinTools` + extension `registerTool` + MCP fanout) and stays fixed.

Two architectural choices:
- **A. Add `pi.setActiveTools(names)` to `ExtensionAPI`** — mirrors Plannotator's API. Pro: extensions can implement modes themselves. Con: tool-set state is in-memory only; needs to be rebuilt on session load/resume.
- **B. Keep tools registered, gate at call time via mode-aware `tool_call` handler** — uses the existing `block` primitive. Pro: no new API; pure policy layer; survives session-reload as long as mode is persisted. Con: the LLM still sees the full schema and may attempt blocked calls (cost + wasted turn).

Recommendation: **(B) for v1 + (A) for v2.** v1 is a pure policy layer (cheaper to ship, no churn in tool registration); v2 adds tool-set swap so the LLM never sees disabled tools (saves tokens + reduces blocked-call confusion). cc, opencode, and mastracode all converged on (A) eventually — the LLM cooperates much better when it can't see the disabled tools.

### 2. Mode-aware system-prompt suffix

Plan mode needs a planner-persona prompt. Edit mode needs a "make edits, don't ramble" prompt. Allow-all needs nothing extra. The `BeforeAgentStartEventResult.systemPrompt` hook supports this, but core needs a `Mode → systemPromptSuffix` registry so it's not 100% extension-owned (mode names should be a stable core concept; the prompt for each mode can be overridden).

### 3. Approval request/response wire

If a mode requires user confirmation (the **`ask`** path), bodhi-pi needs:
- A wire method for the agent to **request** approval: `_bodhi-pi/permission/request` → returns `{decision: "allow_once" | "allow_session" | "allow_always" | "deny" | "deny_session"}`
- A `pending_approval` tool-call status (ACP already supports `pending | in_progress | completed | failed` — adding `pending_approval` may need an ACP `_meta` field, since the spec doesn't have it)
- A lifecycle event pair (`tool_approval_request` / `tool_approval_response`)

The ACP spec has `tool_call_update` but no formal approval interrupt. Bodhi-pi already uses `_bodhi-pi/<area>/<verb>` extension methods for everything off-spec — `_bodhi-pi/permission/request` fits cleanly.

### 4. Mode/permission settings schema

Add to `BodhiPiProjectSettings` (`src/settings/settings.ts`):
- `defaultMode?: "ask" | "plan" | "edit" | "allow-all"` — the mode a new session starts in
- `permissions?: { read?, edit?, bash?, search?, mcp?, subagent? }` — per-group decision (`allow | ask | deny`)
- `autoApprove?: string[]` — array of remembered allow-always patterns (e.g. `bash:npm test`, `edit:*.md`)

Layered via the existing `global | project | session | effective` scope (`EXT_SESSION_SETTINGS_*`).

### 5. Sub-agent mode inheritance

`SubagentProfile` should grow `mode?: AgentMode` (defaults to **inheriting** the parent's mode, with conservative downgrade rules — e.g. `bypass-permissions` parent → `ask` child unless profile explicitly overrides). Mirrors cc's `AgentTool` precedence rules (cc.notes:8).

### 6. Browser/extension-runtime considerations

The Codex-style OS-level sandbox (Seatbelt, Landlock) is **not portable** to browser worker or Chrome-ext MV3. Bodhi-pi's enforcement layer must stay at the tool-call boundary inside the agent. The injected `Filesystem` adapter already gives hosts a place to enforce path scoping (the existing `/sandbox` analogue is "wrap your Filesystem"). Modes can declare *intent* ("read-only") but actual filesystem enforcement is the host's responsibility — same pattern as MCP stdio (`supportsMcpStdio: boolean` host capability).

## Implications for the report's design recommendations

- The **`ToolCallEventResult.block`** primitive means modes can ship as a pure policy layer (no tool-registry restructuring needed) for v1.
- The **lifecycle-events-on-both-rails** pillar forces approval-request/response over the wire (not just in-process), which is good for the Chrome-ext + browser Worker hosts that render UI in a different realm.
- The **`SubagentProfile.tools` allowlist** is the existing template for mode-tool-filtering; reuse the validation pipeline.
- The **multi-runtime parity rule** kills any design that assumes OS-level sandboxing; enforcement stays at the call site.
- The **no-silent-defaults pillar** means the mode field on `BodhiPiConfig` (if any) should throw if invalid, not default to `"allow-all"`.
