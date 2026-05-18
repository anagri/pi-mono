# Codex — modes & permissions notes

## The orthogonal-axes decomposition (the headline)

Codex separates **two independent axes**: **`AskForApproval`** (who decides) and **`SandboxPolicy`** (what's confined). This decomposition is the strongest design idea in any of the surveyed harnesses.

## `AskForApproval`

`codex-rs/protocol/src/protocol.rs:900-931`:

```rust
pub enum AskForApproval {
    #[serde(rename = "untrusted")]
    UnlessTrusted,           // only known-safe read-only commands auto-approved

    OnFailure,               // DEPRECATED — auto-approve everything; sandbox decides; escalate on failure

    #[default]
    OnRequest,               // model decides when to ask

    #[strum(serialize = "granular")]
    Granular(GranularApprovalConfig),

    Never,                   // never ask; failures returned to model
}

pub struct GranularApprovalConfig {
    pub sandbox_approval: bool,
    pub rules: bool,
    pub skill_approval: bool,
    pub request_permissions: bool,
    pub mcp_elicitations: bool,
}
```

## `SandboxPolicy`

`codex-rs/protocol/src/protocol.rs:991-1042`:

```rust
pub enum SandboxPolicy {
    #[serde(rename = "danger-full-access")]
    DangerFullAccess,

    #[serde(rename = "read-only")]
    ReadOnly { network_access: bool },

    #[serde(rename = "external-sandbox")]
    ExternalSandbox { network_access: NetworkAccess },

    #[serde(rename = "workspace-write")]
    WorkspaceWrite {
        writable_roots: Vec<AbsolutePathBuf>,
        network_access: bool,
        exclude_tmpdir_env_var: bool,
        exclude_slash_tmp: bool,
    },
}
```

## OS sandbox enforcement

| OS | Mechanism | Binary | Notes |
|---|---|---|---|
| macOS | Seatbelt (`sandbox-exec(1)`) | `/usr/bin/sandbox-exec` | base policy `seatbelt_base_policy.sbpl` augmented with read-write roots, network rules, unix-socket allowlist |
| Linux | Landlock + seccomp | `codex-linux-sandbox` | child inherits Landlock ruleset before exec |
| Windows | none | — | ReadOnly **not enforced**; treated as unrestricted; safety falls back to ApprovalPolicy |

## CLI

```
codex --ask-for-approval <untrusted|on-failure|on-request|never|granular-...>
codex --sandbox <read-only|workspace-write|danger-full-access|external-sandbox>
codex --dangerously-bypass-approvals-and-sandbox   # = approval=Never + sandbox=DangerFullAccess
```

`config.toml`:
```toml
approval_policy = "on-request"
sandbox_mode = "workspace-write"
```

Conflict detection: `--dangerously-bypass-approvals-and-sandbox` conflicts with `--ask-for-approval`.

## Decision combinator

`exec_policy.rs:272-379`:

```rust
let evaluation = exec_policy.check_multiple_with_options(commands, fallback_fn);
match evaluation.decision {
  Forbidden => Forbidden { reason },
  Prompt    => match prompt_is_rejected_by_policy(approval_policy, prompt_is_rule) {
                 Some(reason) => Forbidden { reason },
                 None         => NeedsApproval { reason, amendment },
               },
  Allow     => Skip { bypass_sandbox, amendment },
}
```

When no rule matches: heuristic on command (dangerous: `python -c`, `bash`, `sudo` → `Prompt` unless `Never`; safe: `ls`, `cat` → `Allow`).

## Sub-agent inheritance

`core/src/thread_manager.rs:612-638` — `spawn_subagent` forks parent thread, child **inherits parent's full `Config`** including `approval_policy` and `sandbox_mode`. **No per-child isolation** — there's no separate approval/sandbox context per child.

## MCP elicitation gating

`core/src/mcp_tool_call.rs:168, 211, 627-634`:

```rust
match approval_policy {
  Never                                                              => return result, // auto-deny
  Granular(cfg) if !cfg.allows_mcp_elicitations()                    => return result, // auto-deny
  OnFailure | OnRequest | UnlessTrusted | Granular(_)                => /* proceed */
}
```

## Network as separate axis

`core/src/tools/network_approval.rs:42-84`:

```rust
enum NetworkApprovalMode { Immediate, Deferred }
```

Network has its own approval/sandbox layer atop the exec axes.

## TUI

Approval-mode shows in status line but **cannot be changed mid-session**. Policies are locked at startup.

## Translating to bodhi-pi

| Codex idea | Bodhi-pi take |
|---|---|
| **Orthogonal `AskForApproval` × `SandboxPolicy`** | **Adopt the spirit, simplify the surface.** Bodhi-pi gets one user-facing `mode` enum (`ask/plan/edit/allow-all`); under it, the policy table is structured: `{ approval: ..., toolPolicy: ... }`. Don't expose sandbox as a separate user-facing axis — bodhi-pi can't enforce OS sandboxing in browser/Chrome-ext anyway. |
| `Granular(GranularApprovalConfig)` | Useful but heavy; defer to v2+. v1 only ships the four headline modes. |
| OS sandbox shims | **Skip in core.** Hosts can wrap their `Filesystem` and `Terminal` adapters to enforce path scoping / command allowlists; bodhi-pi declares the *intent* via mode + `sandbox.allowedPaths` setting, host enforces. Document Node-CLI hosts can layer Codex-style Seatbelt/Landlock on top if they wish. |
| `--dangerously-bypass-approvals-and-sandbox` | Adopt: `_bodhi-pi/mode/set { mode: "allow-all" }` only succeeds when host-injected `allowsAllowAllMode: true` capability is set on init. Browser/Chrome-ext default false. |
| Sub-agent inheritance: parent Config inherited as-is | Bodhi-pi: parent mode is *the floor* — child profile may NARROW (e.g. `explore` profile is always read-only) but cannot ESCALATE above parent. Codex's "inherit parent verbatim" is too permissive given bodhi-pi's profile system. |
| Mid-session change disabled | **Differ.** Bodhi-pi needs mid-session mode change because it runs in long-lived ACP sessions across CLI/HTTP/browser. Emit `mode_change` lifecycle event so all UI surfaces refresh. |
| Network as a separate axis | Adopt for v2: per-tool `webfetch`/`websearch`/MCP-network policy distinct from `bash`. |
| Status-line mode display | Adopt: hosts read `_bodhi-pi/session/config` or subscribe to `mode_change` to render the badge. |
