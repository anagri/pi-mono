# codex-acp adapter — deep-read

Local: `/Users/amir36/Documents/workspace/src/github.com/zed-industries/codex-acp/`. ACP `=0.11.1` with `unstable` features (`Cargo.toml:21`).

## Headline: Codex's 2 orthogonal axes collapsed into 3 ACP modes

`src/thread.rs:115-117`:

```rust
const CODEX_READ_ONLY_PROFILE_ID:        &str = ":read-only";
const CODEX_WORKSPACE_PROFILE_ID:        &str = ":workspace";
const CODEX_DANGER_NO_SANDBOX_PROFILE_ID:&str = ":danger-no-sandbox";
```

Mapping (`src/thread.rs:119-135`):

| ACP mode | Codex internal profile |
|---|---|
| `read-only` | `:read-only` (read-only sandbox, no approval requests possible) |
| `auto` | `:workspace` (workspace-write sandbox, OnRequest approval) |
| `full-access` | `:danger-no-sandbox` (DangerFullAccess, Never approval) |

Codex's full 5×4 product (5 ApprovalPolicy × 4 SandboxPolicy) is reduced to 3 ergonomic presets. Each preset bundles BOTH axes. Drawn from `codex_utils_approval_presets::APPROVAL_PRESETS`.

**Lesson for bodhi-pi**: bodhi-pi's 4-mode design already collapses the policy + UI surface into one user-facing axis. codex-acp validates this approach — explicit preset bundles instead of orthogonal selectors.

## `setSessionMode` handler

`src/codex_agent.rs:771-780` → `src/thread.rs:3349-3395`:

```rust
async fn handle_set_mode(&mut self, mode: SessionModeId) -> Result<(), Error> {
  let preset = APPROVAL_PRESETS.iter().find(|p| mode.0.as_ref() == p.id)
    .ok_or_else(Error::invalid_params)?;

  // Live mutation of Codex's turn context
  self.thread.submit(Op::OverrideTurnContext {
    approval_policy:    Some(preset.approval),
    permission_profile: Some(preset.permission_profile.clone()),
    sandbox_policy: None, model: None, cwd: None, ...
  }).await?;

  // Persist to config
  self.config.permissions.approval_policy.set(preset.approval)?;
  self.config.permissions.set_permission_profile_with_active_profile(
    preset.permission_profile.clone(),
    active_profile_id_for_session_mode(preset.id).map(ActivePermissionProfile::new),
  )?;

  // Project trust in permissive modes
  if mode_trusts_project(preset.id) {
    set_project_trust_level(...)?;
  }
  Ok(())
}
```

Three actions atomically: mutate Codex's in-flight turn context, persist to config, optionally update project trust. **Mode change is a multi-side-effect operation, not a simple state set.**

Bodhi-pi parallel: `PermissionService.setMode` should also (a) mutate `session.runtime.mode`, (b) append `mode_change` SessionEntry, (c) re-compute active tool list (milestone 080), (d) emit lifecycle events on both rails, (e) emit `CurrentModeUpdate` / `ConfigOptionUpdate`. All atomic from the client's perspective.

## `requestPermission` — dynamic option construction per request type

`src/thread.rs:600-672` (MCP elicitation example):

```rust
let mut options = vec![
  PermissionOption::new(MCP_TOOL_APPROVAL_ALLOW_OPTION_ID, "Allow", PermissionOptionKind::AllowOnce)
];

if allow_session_remember {
  options.push(PermissionOption::new("allow-session", "Allow for this session", PermissionOptionKind::AllowAlways));
}
if allow_persistent_approval {
  options.push(PermissionOption::new("allow-always", "Allow and don't ask again", PermissionOptionKind::AllowAlways));
}

options.push(PermissionOption::new("cancel", "Cancel", PermissionOptionKind::RejectOnce));
```

**Notable**: codex-acp distinguishes "allow for this session" and "allow and don't ask again" via two `AllowAlways` options with different `optionId` values. The scope is encoded in the optionId, not in `PermissionOptionKind`. This is a workaround for ACP's missing scope dimension.

Bodhi-pi's milestone 090 has the same problem (session vs project vs global scope). Solutions:
1. Multiple `AllowAlways` options with semantic optionIds (`allow_session`, `allow_project`, `allow_global`)
2. Single `AllowAlways` option, scope chosen via secondary modal/prompt after click
3. Pass scope hint via `_meta` on the response (ACP spec allows arbitrary `_meta`)

**Recommendation**: option 1 (multiple optionIds) — matches codex-acp's proven pattern, no extra UI round-trip, host renders 5 buttons instead of 4 when persistent-allow is meaningful.

## Sandbox: pass-through, not replaced

`src/codex_agent.rs:82-85`: adapter passes Codex's `codex_linux_sandbox_exe` through. Codex's OS-level sandboxes (Seatbelt, Landlock) are kept. The adapter coordinates approval/mode but doesn't replace the OS isolation. **Codex retains full filesystem ownership.**

## Filesystem ownership: Codex (agent) owns it, NOT the ACP client

`src/codex_agent.rs:564-568` — adapter records session root for context, but no `fs/read_text_file`/`fs/write_text_file` proxying. Codex executes directly on the user's filesystem, with OS-level sandboxing.

**Same as bodhi-pi.** Codex-acp + bodhi-pi sit in the "agent owns filesystem" camp. cc-acp + Goose sit in the "client owns filesystem" camp.

## Permission persistence

Delegated to Codex's internal config (`Op::ResolveElicitation` with `meta` carrying the persist marker). Adapter doesn't write `.codex/config.toml` directly.

Bodhi-pi: own SettingsService writes directly. More direct because bodhi-pi has no sub-agent process to delegate to.

## Sub-agent / fork inheritance

Codex-acp doesn't explicitly handle sub-agent inheritance — its `SetSessionMode` flow mutates the parent's turn context. No analogue of Qwen's `resolveChildMode`. (Codex's own model has subagents in `thread_manager.rs:612-638` but the ACP-side just exposes the parent.)

Bodhi-pi's Qwen rule (milestone 070) is a step beyond what codex-acp does.

## Implication for bodhi-pi

| codex-acp pattern | Bodhi-pi adoption |
|---|---|
| Collapse multi-axis into ergonomic mode presets | Adopt: 4 modes (`ask/plan/edit/allow-all`) over preset table |
| Mode change is a multi-side-effect atomic operation | Adopt: PermissionService.setMode does all the side effects |
| Scope encoded in `optionId` (multiple `AllowAlways` entries) | **Adopt for milestone 090** — render session/project/global as 3 distinct allow_always options |
| OS-level sandbox retained at agent layer | Bodhi-pi doesn't have OS sandbox in core, but: host's Filesystem/Terminal adapter MAY wrap with OS sandbox (e.g. CLI host using Seatbelt). Document as host concern. |
| Filesystem owned by agent | **Already aligned** — bodhi-pi's core decision |
| Persistence via agent-internal storage (not via ACP client) | **Already aligned** — bodhi-pi uses SettingsService |
| Mode-driven "trust project" affordance | Skip for v1 — Codex's project-trust is OS-sandbox-specific; bodhi-pi can revisit if needed |
