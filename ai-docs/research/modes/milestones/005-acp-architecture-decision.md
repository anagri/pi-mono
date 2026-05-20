# Milestone 005 — ACP architecture decision (READ FIRST)

> **This document supersedes parts of [000-overview.md](000-overview.md) and rewrites the wire-surface choices in milestones 010-090.** Read this BEFORE any milestone. The implementation milestones (010+) should be treated as updated by this document — where they conflict, this document wins.

## TL;DR

After deep research on ACP spec + 5 reference implementations (Zed client + cc/Codex/Pi adapters + Goose native ACP server), the answer is:

> **Use ACP-native wire primitives for everything mode + permission related. Do NOT invent `_bodhi-pi/mode/*` or `_bodhi-pi/permission/*` extension methods. Keep policy + persistence in the bodhi-pi agent because bodhi-pi owns the filesystem (different from Zed/Goose; same as cc/Codex/Pi).**

The four ACP-native primitives bodhi-pi will use:

| Concern | ACP-native method/notification | Status |
|---|---|---|
| Mode advertisement | `NewSessionResponse.configOptions[]` with `category: "mode"` | Live (preferred over deprecated `modes` field) |
| Mode change from client | `session/setSessionConfigOption { configId: "mode", value: <modeId> }` | Live (preferred over deprecated `session/setSessionMode`) |
| Mode change from agent | `session/update { sessionUpdate: "config_option_update", configOptions: [...] }` | Live (preferred over deprecated `current_mode_update`) |
| Approval request | `session/request_permission { sessionId, toolCall, options: PermissionOption[] }` | Live (not deprecated) |

And the four key architectural pillars:

1. **Bodhi-pi owns the filesystem**, so bodhi-pi's PermissionService is the trust boundary for fs operations. Standard ACP (Zed-as-client) puts that boundary in the client via `fs/read_text_file` / `fs/write_text_file` round-trips; bodhi-pi opted out (`CLAUDE.md`: "ACP `fs/*` methods are deliberately absent"). This means modes/permissions MUST be enforced in the agent — we can't delegate to the client.

2. **Persistence is agent-side** for `alwaysAllow`/`alwaysDeny` rules. cc, Codex, and Pi all do this; Zed (as client) doesn't bother persisting at all. Bodhi-pi follows the agent pattern — uses existing `_bodhi-pi/session/settings/*` with `permission.alwaysAllow/Deny` keys; no new wire methods.

3. **Bodhi-pi extends the existing `setSessionConfigOption` dispatch** — does NOT add a new `setSessionMode` handler. The bodhi-pi codebase already has `MODEL_CONFIG_ID = "model"` and `THINKING_CONFIG_ID = "thinking"` in `src/wire/constants.ts:2,20`; the dispatch table is in `src/models/registry.ts:217-236`. Adding `MODE_CONFIG_ID = "mode"` is one more entry in that table. `PermissionService` provides the `buildModeConfigOption(session)` builder and the `setSessionMode(sessionId, modeId)` action; the registry's dispatch glue is unchanged in shape.

4. **In-process EventDispatcher events stay** — `mode_change`, `tool_approval_request`, `tool_approval_response` remain on the bodhi-pi event bus for extensions to subscribe to. `mode_change`'s wire view is the native `config_option_update`, so it is NOT separately wire-forwarded.

   **Revised in milestone 040 (implementation):** `tool_approval_request` / `tool_approval_response` ARE forwarded via `LIFECYCLE_EVENT_METHOD` (mirroring 030's `tool_blocked`). The native `request_permission` round-trip carries the *decision*; the two lifecycle notifications are pure *observability* so remote Clients and the e2e/Playwright suites can watch the request→response pair (the repo's "major components expose lifecycle events on both rails" pillar mandates the wire forwarder + an `extNotifications` regression test). This supersedes the original "NOT wire-forwarded" stance for the two approval events; `mode_change` stays in-process-only.

## Why ACP-native (not custom `_bodhi-pi/*`)

Three reasons:

### Reason 1: bodhi-pi's "Stable ACP over `unstable_*`" pillar mandates it

From `packages/bodhi-pi/CLAUDE.md` § "Architecture pillars":

> **Stable ACP over `unstable_*`.** Non-spec features use `_bodhi-pi/<area>/<verb>` extensions, advertised via `agentCapabilities._meta["bodhi-pi"]`.

The rule is: use `_bodhi-pi/<area>/<verb>` ONLY when ACP doesn't already have the method. ACP DOES have:

- `session/setSessionConfigOption` (live, the new path) — covers mode change
- `session/request_permission` (live, not deprecated) — covers approval round-trip
- `session/update { sessionUpdate: "config_option_update", ... }` — covers mode change notifications

So `_bodhi-pi/mode/*` and `_bodhi-pi/permission/*` would violate the pillar.

### Reason 2: client interop is free

Zed (the flagship ACP client) renders `request_permission` inline in the conversation with 4 buttons keyed to `PermissionOptionKind`. Zed renders `availableModes` (legacy) or `configOptions` with `category: "mode"` (new) as a mode picker dropdown. Any other ACP client (Cursor, Junie, Augment, etc.) does the same. Bodhi-pi gets all these client UIs for free if it stays ACP-native.

If bodhi-pi invented `_bodhi-pi/mode/set`, every client would need a bodhi-pi-specific shim. Wasted ecosystem work.

### Reason 3: bodhi-pi already implements the dispatch infrastructure

`src/models/registry.ts:208-236` is the existing pattern for `model` + `thinking` config options:

```ts
// existing — abridged
async buildAllConfigOptions(sessionId: string): Promise<SessionConfigOption[]> {
  const session = this.sessions.get(sessionId);
  const options: SessionConfigOption[] = [await this.buildModelConfigOption(session.runtime.currentModelId)];
  // ... thinking option appended conditionally
  return options;
}

private setters: Record<string, (sid, s, v) => Promise<void>> = {
  [MODEL_CONFIG_ID]:    (sid, s, v) => this.setSessionModel(sid, s, v),
  [THINKING_CONFIG_ID]: (sid, s, v) => this.setSessionThinkingLevel(sid, s, v),
};

async setSessionConfigOption(params): Promise<SetSessionConfigOptionResponse> {
  const session = this.sessions.get(params.sessionId);
  const setter = this.setters[params.configId];
  if (!setter) throw new RequestError(...);
  await setter(params.sessionId, session, params.value);
  return { configOptions: await this.buildAllConfigOptions(params.sessionId) };
}
```

Adding mode is a one-table-row addition:

```ts
// new
[MODE_CONFIG_ID]: (sid, s, v) => this.permissionService.setMode(sid, v),
```

Plus `buildAllConfigOptions` prepends `mode` (highest priority — order matters per spec):

```ts
async buildAllConfigOptions(sessionId): Promise<SessionConfigOption[]> {
  const session = this.sessions.get(sessionId);
  return [
    this.permissionService.buildModeConfigOption(session),
    await this.buildModelConfigOption(session.runtime.currentModelId),
    ...(thinking ? [thinking] : []),
  ];
}
```

That's it. No new wire surface; no new dispatch class; no new ACP handler in `BodhiPiAcpAgent`. The work shifts to `PermissionService` exposing those two methods.

## Why agent-side policy + persistence (not client-side)

| Reference impl | Policy lives in | Persistence lives in | Filesystem owned by |
|---|---|---|---|
| Bodhi-pi (planned) | Agent (PermissionService) | Agent (SettingsService → `.bodhi-pi/settings.json`) | Agent (Host-injected `Filesystem`) |
| cc + claude-agent-acp | cc SDK (canUseTool) | cc SDK (`.claude/settings.json`) | Client (`fs/*` proxy through ACP) |
| Codex + codex-acp | Codex (exec_policy + sandbox) | Codex (`~/.codex/config.toml`) | Agent (direct + OS sandbox) |
| Goose | Goose (permission_inspector) | Goose (permission_manager) | Client (`fs/*` proxy through ACP) |
| Pi + pi-acp | Pi (inside subprocess) | Pi (subprocess state) | Agent (pi direct) |
| Zed (as ACP client) | — | None (session memory only) | Zed itself |

The pattern: **the side that owns the filesystem owns the permission engine + persistence.** Bodhi-pi owns fs (because Host injects the adapter and bodhi-pi's tools call directly), so bodhi-pi owns the policy. This is consistent with cc/Codex/Pi.

The contrast is Goose: it COULD own fs (it's a full native agent) but chose to route fs through ACP for editor-buffer integration. Bodhi-pi made the opposite choice for browser-runtime performance + headless-by-design reasons.

## What changes vs the original 000-overview.md

### Things to STRIKE from the original plan

| Original (incorrect) | Reason |
|---|---|
| `_bodhi-pi/mode/set`, `_bodhi-pi/mode/get`, `_bodhi-pi/mode/list` wire methods | Use `session/setSessionConfigOption` + existing `_bodhi-pi/session/config` |
| `_bodhi-pi/permission/respond`, `_bodhi-pi/permission/request` wire methods | Use native `session/request_permission` |
| `_bodhi-pi/permission/policy/{get,set,list,unset}` wire methods | Use existing `_bodhi-pi/session/settings/*` with `permission.*` keys |
| Custom `setSessionMode` handler on `BodhiPiAcpAgent` | Extend existing `setSessionConfigOption` dispatch table |
| Custom `CurrentModeUpdate` SessionUpdate (or LIFECYCLE_EVENT_METHOD fallback) | Use native `ConfigOptionUpdate` (no fallback needed — it's in the SDK) |
| New `MODE_CONFIG_ID` constant on bodhi-pi side | **Keep** — it's the bodhi-pi-side name for the existing `configId: "mode"` ACP convention |

### Things to KEEP

- Default mode `ask`
- 4 modes: `ask | plan | edit | allow-all`
- 30s configurable approval timeout
- `submit_plan` as built-in tool registered only when mode=plan
- `allowsAllowAllMode` capability gate (Host-injected)
- Safety-immune deny list (`.git/**`, `.bodhi-pi/**`, `.env*`, `~/.ssh/**`)
- Qwen rule for sub-agent inheritance
- `setActiveTools` extension API for hiding denied tools from LLM
- `mode_change` SessionEntry for cross-session persistence (it's an internal record, not a wire concept)
- In-process `EventDispatcher` events `mode_change` / `tool_approval_request` / `tool_approval_response` (NOT wire-forwarded; for extensions to subscribe to)
- `permission.alwaysAllow` / `permission.alwaysDeny` settings keys at session/project/global scope

### Things to ADD

- **Scope encoded in `optionId`** — when offering `allow_always` in `ask` mode, render 3 distinct `AllowAlways` options with `optionId` = `allow_session` / `allow_project` / `allow_global` (codex-acp pattern). Avoids needing a secondary scope picker UI.
- **Emit `ConfigOptionUpdate` BEFORE returning from `setSessionConfigOption`** (Goose pattern) — prevents the race where the response unblocks the client before the notification arrives.
- **`MODE_CONFIG_ID = "mode"` constant** in `src/wire/constants.ts` alongside `MODEL_CONFIG_ID` and `THINKING_CONFIG_ID`.

## Per-milestone delta (what each milestone changes vs the original version)

### Milestone 010 — Ground preparation

**Mostly unchanged.** Updates:
- Add `MODE_CONFIG_ID = "mode"` to `src/wire/constants.ts` (was implied as `EXT_MODE_*` in original — replace)
- The `BodhiPiEvent` union additions (`mode_change`, `tool_approval_request`, `tool_approval_response`) stay — these are in-process events, NOT wire methods. They're for extensions to subscribe to, and the wire view of mode change is via native `config_option_update`.
- Drop any reference to `_bodhi-pi/mode/*` or `_bodhi-pi/permission/*` wire constants. Specifically: do NOT add `EXT_MODE_SET`, `EXT_MODE_GET`, `EXT_MODE_LIST`, `EXT_PERMISSION_RESPOND`, etc. to `src/wire/constants.ts`. They were leftovers from my pre-ACP-research draft.

### Milestone 020 — Mode state + setSessionMode

**Significant rewrite.** Updates:
- File rename suggested: `020-mode-state-and-set-session-mode.md` → `020-mode-state-and-set-config-option.md` (more accurate)
- Do NOT implement a new `setSessionMode` handler on `BodhiPiAcpAgent`. Extend the existing `setSessionConfigOption` dispatch table in `src/models/registry.ts:217-236` with a `MODE_CONFIG_ID` entry that delegates to `PermissionService.setMode`.
- The `PermissionService` core service still exists, gets registered alongside `ModelRegistry` / `McpService` etc., but its public API is:
  - `buildModeConfigOption(session): SessionConfigOption` — for the registry's `buildAllConfigOptions` to call
  - `setMode(sessionId, modeId, reason): Promise<void>` — for the registry's dispatch table to call
  - `getCurrentMode(sessionId): AgentMode`
- The registry's `buildAllConfigOptions` prepends mode first (highest priority per spec).
- `setMode` emits `mode_change` in-process event AND triggers the registry to send `ConfigOptionUpdate` notification (NOT a `CurrentModeUpdate` — they're equivalent, but `ConfigOptionUpdate` is the new way and Zed handles both).
- The Goose-pattern detail: emit `ConfigOptionUpdate` BEFORE returning from `setSessionConfigOption`. The existing registry implementation may already do this; verify.
- Hosts (`test-apps/<host>/src/client/*`) implement `/mode <id>` slash by calling `client.setSessionConfigOption({ sessionId, configId: "mode", value: modeId })`. NOT `client.setSessionMode(...)` — that's the deprecated path.
- BUT: also call `client.setSessionMode(...)` for backward compatibility with older ACP clients? **Decision: NO.** Bodhi-pi has no production users; we ship the new path only. Document.
- Existing legacy `modes` field on `NewSessionResponse` (from the deprecated `SessionModeState`) — do NOT populate. The `configOptions` field is sufficient.

### Milestone 030 — `ask` mode + requestPermission flow

**Mostly unchanged.** Updates:
- Replace ALL references to "`_bodhi-pi/permission/request`" / "`_bodhi-pi/permission/respond`" with native ACP `session/request_permission`.
- Bodhi-pi's `PermissionService.evaluateToolCall` async hook (registered on `tool_call` event) calls `await this.conn.requestPermission({ sessionId, toolCall: {...}, options: [...] })` — uses the agent-side conn the `BodhiPiAcpAgent` already holds.
- The 4 `PermissionOptionKind` mapping:
  - `allow_once` → tool runs
  - `allow_always` → 3 sub-options in `ask` mode (see "Scope encoded in optionId" below); 1 option in restricted modes
  - `reject_once` → tool blocked
  - `reject_always` → adds session-grant deny pattern
- **Scope encoded in optionId** (codex-acp pattern): in `ask` mode, render `AllowAlways` as 3 entries:
  ```ts
  { optionId: "allow_always_session",  name: "Allow this session", kind: "allow_always" },
  { optionId: "allow_always_project",  name: "Allow for project",   kind: "allow_always" },
  { optionId: "allow_always_global",   name: "Allow always (global)", kind: "allow_always" },
  ```
  Plus the normal `allow_once`/`reject_once`/`reject_always`. **5-6 buttons total** in the modal/card. Brings persistence scope choice into the same UI without a secondary modal. Milestone 090 now mostly about reading these settings, not about adding new wire methods.
- Test-harness changes around `approvalResponses` queue stay.
- Browser host UI: **prefer Zed-style inline card** in the conversation transcript over modal (better UX — user can scroll while pending). Smaller diff to existing tool-call rendering.
- CLI host: prompt grows from `[y/n/A/N]` to `[y/n/A/N/p/g]` where `p`=allow_always_project, `g`=allow_always_global. Or stays at 4 keys and adds a follow-up scope prompt — implementer's choice.

### Milestone 040 — `edit` preset

**Unchanged.**

### Milestone 050 — `plan` mode + submit_plan

**Small update.** Updates:
- `submit_plan` tool's `requestPermission` invocation uses the canonical plan-exit pattern from the spec (`docs/protocol/session-modes.mdx:128-167`) AND claude-agent-acp:
  ```ts
  options: [
    { optionId: "edit",     name: "Approve and switch to edit mode", kind: "allow_always" },
    { optionId: "edit_notes", name: "Approve with notes",            kind: "allow_once" },
    { optionId: "revise",   name: "Revise (don't switch mode)",     kind: "reject_once" },
  ]
  ```
  When user selects `edit`, the tool returns success AND `PermissionService.setMode(sid, "edit", "submit_plan_approved")` is called inside the tool's execute. The `optionId` IS the target mode (key insight from cc-acp + spec).
- 3 options, not 4 — `reject_always` doesn't make sense here.

### Milestone 060 — `allow-all` + safety gate

**Unchanged.**

### Milestone 070 — Sub-agent inheritance

**Unchanged.**

### Milestone 080 — Active-tools swap

**Unchanged.**

### Milestone 090 — Persistent rules

**Significant simplification.** Updates:
- Drop the `_bodhi-pi/permission/policy/{get,set,list,unset}` wire methods entirely. They were redundant — the existing `_bodhi-pi/session/settings/*` already supports arbitrary keys, and `permission.alwaysAllow` / `permission.alwaysDeny` slot in naturally.
- Scope picker UI per host is replaced by the "scope encoded in optionId" pattern (already added in milestone 040). 090 becomes mostly about:
  - Reading `session.settings.effective.permission.alwaysAllow` / `alwaysDeny` in `PermissionService.evaluateToolCall`
  - Writing those keys via existing `SettingsService.set` when the user picks an `allow_always_*` option
- `/permissions` slash command in hosts becomes `/settings list permission.*` (uses existing `/settings` slash from Phase I).

## Updated overview pointer

[000-overview.md](000-overview.md) describes the original design. Where it conflicts with this document, this document wins. The dated rewrite of 000-overview itself can land in milestone 020's commit (a single targeted edit to the overview's "Key architectural decisions" section).

## Verification checklist before milestone 010 starts

- [ ] Confirm bodhi-pi's `@agentclientprotocol/sdk` version is `0.12.x` or newer. If older, bump in `package.json` so `SessionConfigOption` + `request_permission` types are available. (pi-acp uses 0.12; codex-acp + Zed use 0.11.1; claude-agent-acp uses 0.22.) `node_modules/@agentclientprotocol/sdk/package.json` already imports `ConfigOptionUpdate` + `RequestPermissionRequest` per the schema dump we already verified, so the version in use IS new enough. **Action: no version bump needed**, just confirm.
- [ ] Read `src/models/registry.ts:182-236` to confirm the dispatch-table pattern. The mode addition mirrors model+thinking exactly.
- [ ] Read `src/acp/agent.ts:497-499` (the `setSessionConfigOption` ACP handler) — it already delegates to `ModelRegistry.setSessionConfigOption`. No change to `BodhiPiAcpAgent` for the dispatch wiring; only the registry grows a new entry.

## Open question

Should bodhi-pi ALSO populate the legacy `modes: SessionModeState` field on `NewSessionResponse` for clients stuck on 0.11.x that haven't migrated to `configOptions`? Zed merges both; Goose only writes `modes`; cc-acp writes both.

**Recommendation: NO.** Bodhi-pi has no production users; the new path is sufficient. Save the diff. If a real consumer is found on an older ACP version, add legacy support in a follow-up commit (one method on `PermissionService.buildLegacyModeState()`).

## Summary

ACP gives us almost everything we want for free. The work is:
1. Add `MODE_CONFIG_ID = "mode"` constant
2. Add `PermissionService` core service with mode-state + policy engine + builder for the mode `SessionConfigOption`
3. Extend `ModelRegistry.setters` dispatch table with a mode entry
4. Implement `requestPermission` invocation in PermissionService
5. Each Host implements ACP-native `requestPermission` Client-side
6. Existing `_bodhi-pi/session/settings/*` carries persistent rules
7. Existing `_bodhi-pi/session/config` exposes current mode

No new wire methods. No deprecated-path implementation. Maximum spec compliance, minimum invention.
