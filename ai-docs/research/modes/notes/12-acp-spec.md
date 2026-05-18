# ACP spec — modes & permissions deep-read

## Headline: `session/setSessionMode` is being deprecated

`docs/protocol/session-modes.mdx:6-10`:

> You can now use [Session Config Options](./session-config-options). Dedicated session mode methods will be removed in a future version of the protocol. Until then, you can offer both to clients for backwards compatibility.

The replacement: **`session/setSessionConfigOption`** with `category: "mode"` (`docs/protocol/session-config-options.mdx`, RFD `docs/rfds/session-config-options.mdx`). Bodhi-pi already implements `setSessionConfigOption` for `model` + `thinking` (`src/models/registry.ts:208-236`).

## The full picture of ACP's mode/permission surface

| Concept | ACP surface | Status | Spec source |
|---|---|---|---|
| Mode advertisement (initial) | `NewSessionResponse.configOptions[]` with `category: "mode"` | Live | `session-config-options.mdx` |
| Mode advertisement (initial — legacy) | `NewSessionResponse.modes: SessionModeState` | **Deprecated** | `session-modes.mdx` |
| Mode change from client | `session/setSessionConfigOption { configId, value }` | Live | `session-config-options.mdx` |
| Mode change from client (legacy) | `session/setSessionMode { modeId }` | **Deprecated** | `session-modes.mdx` |
| Mode change from agent | `session/update { sessionUpdate: "config_option_update", configOptions: [...] }` | Live | `session-config-options.mdx` |
| Mode change from agent (legacy) | `session/update { sessionUpdate: "current_mode_update", currentModeId }` | **Deprecated** | `session-modes.mdx` |
| Permission request from agent | `session/request_permission { sessionId, toolCall, options }` | **Live (not deprecated)** | `tool-calls.mdx:108-186` |
| Permission options | `PermissionOptionKind = allow_once \| allow_always \| reject_once \| reject_always` | Live | `tool-calls.mdx:200-208` |
| Permission outcome | `RequestPermissionOutcome = { outcome: "cancelled" } \| { outcome: "selected", optionId }` | Live | `tool-calls.mdx:153-186` |
| Tool-call awaiting approval | `ToolCallStatus = "pending"` (covers both streaming-input AND awaiting-approval) | Live | `tool-calls.mdx:213-218` |
| Filesystem access (agent → client) | `fs/read_text_file`, `fs/write_text_file` — gated by `clientCapabilities.fs.*` | Live | `file-system.mdx` |

## Critical implementation details from spec

### 1. `PermissionOption.optionId` is arbitrary, defined by the agent

```json
"options": [
  { "optionId": "allow-once", "name": "Allow once", "kind": "allow_once" },
  { "optionId": "reject-once", "name": "Reject",    "kind": "reject_once" }
]
```

`kind` is the UI hint (allow/reject + once/always); `optionId` is whatever the agent wants. Adapters use this — e.g. for plan-mode exit, claude-agent-acp uses `optionId: "auto"`, `optionId: "acceptEdits"` etc. to encode "approve plan AND switch to this mode" in a single option. **This is a critical insight**: bodhi-pi's `submit_plan` exit flow uses the same trick to bundle approval+mode-switch.

### 2. Plan-mode exit canonical example (spec §session-modes:128-167)

```json
"options": [
  { "optionId": "code", "name": "Yes, and auto-accept all actions", "kind": "allow_always" },
  { "optionId": "ask",  "name": "Yes, and manually accept actions",  "kind": "allow_once" },
  { "optionId": "reject", "name": "No, stay in architect mode",      "kind": "reject_once" }
]
```

The optionIds ARE mode IDs. When the agent receives the response, it switches to the selected mode AND auto-allows the exit. Notable: only 3 options, NOT 4. `reject_always` doesn't make sense for plan exit.

### 3. Cancellation MUST resolve pending approvals (spec §prompt-turn:298)

> The Client **MUST** respond to all pending `session/request_permission` requests with the `cancelled` outcome.

Bodhi-pi's `session/cancel` handler MUST walk `pendingApprovals` and resolve them. Already in my milestone 030.

### 4. Agents MUST always have a default for every config option (RFD §"Default Values and Graceful Degradation")

> Agents MUST always provide a default value for every configuration option. This ensures the Agent can operate correctly even if the Client doesn't support configuration options.

Mode change is best-effort from the client's perspective; the agent must function with whatever default it picked at session start.

### 5. `setSessionConfigOption` response MUST return the FULL set

Bodhi-pi's existing implementation already does this (per the "bug fix bundled" mention in `PARITY.md` Phase I). When mode change might affect other options (e.g. unlocks a mode-specific model), the full re-rendered list lets the client refresh deterministically.

### 6. `category` is for UX only, not correctness

> Categories are for UX purposes only and MUST NOT be required for correctness. Clients MUST handle missing or unknown categories gracefully.

Bodhi-pi sets `category: "mode"` on the mode config option but cannot rely on clients recognising it. The `id: "mode"` IS the contract.

### 7. The `configOptions` array order matters

> Clients SHOULD display options in the order provided by the Agent. Use ordering to resolve ties when multiple options share the same category.

Bodhi-pi will list `mode` first (most important), then `model`, then `thinking`. The existing `buildAllConfigOptions(sessionId)` in `src/models/registry.ts:208` becomes the place to enforce this order — `mode` is prepended.

### 8. ACP-spec example "ask" mode matches our chosen mode name

Spec example uses `"ask"` and `"code"` (not `edit`). Bodhi-pi uses `ask | plan | edit | allow-all` — slight divergence on `edit` vs `code`. Decision: keep bodhi-pi's `edit` because (a) it's clearer about what it does, (b) opencode + many other harnesses use `code/build` to mean the same thing, (c) the IDs are arbitrary anyway.

## What bodhi-pi must NOT invent (because ACP already has it)

| Tempting custom method | ACP-native replacement | Why ACP is better |
|---|---|---|
| `_bodhi-pi/mode/set` | `session/setSessionConfigOption { configId: "mode" }` | Already implemented in bodhi-pi for model+thinking; same dispatch table |
| `_bodhi-pi/mode/get` | Part of `_bodhi-pi/session/config` (which already lists configOptions) | Already there |
| `_bodhi-pi/mode/list` | `configOptions[].options` on initial `session/new` response | Already there |
| `_bodhi-pi/permission/request` | `session/request_permission` (Agent → Client) | Native; Zed renders the 4 buttons inline |
| `_bodhi-pi/permission/respond` | `RequestPermissionResponse` to the above request | Native; same round-trip |
| `_bodhi-pi/permission/policy/{get,set}` | `_bodhi-pi/session/settings/*` with `permission.*` key | Already there; no new wire surface |
| New `tool_approval_request` / `tool_approval_response` lifecycle wire | `tool_call_update { status: "pending" }` + `request_permission` | Wire ALREADY covers it; in-process events still useful |

The in-process `EventDispatcher` events `mode_change`, `tool_approval_request`, `tool_approval_response` can still exist for extensions to subscribe to — they just don't need to be wire-forwarded because the same information goes over the wire via native ACP messages.

## What stays bodhi-pi-specific

- The **PermissionService** core service (policy engine + preset registry + pending-approvals map). ACP defines the wire; not the policy. Bodhi-pi owns the policy because bodhi-pi owns the filesystem (see notes 14/15/16/17 for how other agents handle this).
- The **`alwaysAllow` / `alwaysDeny` rule storage** under `permission.*` settings keys (uses existing `_bodhi-pi/session/settings/*` wire). Three of four surveyed agents persist rules agent-side (cc → `.claude/settings.json`, Codex → `~/.codex/config.toml`, bodhi-pi → `.bodhi-pi/settings.json` via existing SettingsService). Only Zed doesn't persist — and Zed is a client, not an agent.
- The **safety-immune deny list** (`.git/**`, `.bodhi-pi/**`, `.env*`, `~/.ssh/**`) — a bodhi-pi safety net unique to its "agent owns fs" architecture.
- **`mode_change` SessionEntry** for cross-session persistence — internal to bodhi-pi's session log. Not exposed over ACP wire; it's how rehydration restores last-active mode.
