# Goose + Qwen Code — modes notes

## Goose (`block/goose`, Rust)

`crates/goose/src/config/goose_mode.rs` — `GooseMode`:

| Variant | Wire | Behavior |
|---|---|---|
| `Auto` | `auto` | All tools execute without confirmation. Default for headless. |
| `Approve` | `approve` | Every tool call requires confirmation. Ignores LLM cache. |
| `SmartApprove` | `smart_approve` | Read-only auto-approved; mutating prompts. LLM-classifier with cache. |
| `Chat` | `chat` | Tools NOT executed; agent replies conversationally only. |

Per-tool override (`PermissionLevel`):
- `AlwaysAllow` — bypass confirmation even in Approve/SmartApprove
- `AskBefore` — always prompt regardless of mode
- `NeverAllow` — block

User-reply enum (`Permission`, paired with `PrincipalType: Extension | Tool`):
- `AlwaysAllow`, `AllowOnce`, `Cancel`, `DenyOnce`, `AlwaysDeny`

Enforcement: `permission_inspector.rs` dispatches on mode:
```
Chat        → continue (never executes)
Auto        → InspectionAction::Allow (unconditional)
Approve     → user permissions > read-only annotation > require approval (no cache)
SmartApprove → user perms > read-only annotation OR cached LLM judgement > extension-mgmt special-case > defer to LLM > require approval
```

LLM classifier (`permission_judge.rs`): builds synthetic `create_read_only_tool()`, asks model which tool names are read-only, returns `PermissionCheckResult { approved, needs_approval, denied }`. Cached in `permission_store.rs` (`ToolPermissionStore` keyed by tool-name + context-hash + expiry).

**Sub-agent inheritance: NONE.** `subagent_handler.rs` builds `SubagentRunParams` with independently-constructed `AgentConfig`; no parent `GooseMode` is copied. `subagent_task_config.rs` confirms: provider, session id, workdir, extensions are forwarded; `max_turns` from `GOOSE_SUBAGENT_MAX_TURNS`. **Mode/permissions absent from inherited surface.**

## Qwen Code (`QwenLM/qwen-code`, TS, gemini-cli fork)

`packages/core/src/config/config.ts` — `ApprovalMode` (extends gemini-cli's):
```ts
export enum ApprovalMode { PLAN, DEFAULT, AUTO_EDIT, YOLO }
```

`setApprovalMode()` enforces folder-trust gate: only `DEFAULT`/`PLAN` permitted in untrusted folder. Switching to `PLAN` snapshots `prePlanMode` for restore.

Parallel `PermissionMode` enum used internally by hook bus/subagent layer; bridged via `approvalModeToPermissionMode()`.

### The mode-resolution function (THE PATTERN)

`packages/core/src/tools/agent/agent.ts:162-194` — `resolveSubagentApprovalMode`:

```ts
// 1. Permissive parent wins unconditionally
if (parent === YOLO || parent === AUTO_EDIT) return parent;

// 2. Agent-defined mode applies, but privileged modes need trusted folder
if (agentApprovalMode) {
  const resolved = approvalModeToPermissionMode(agentApprovalMode);
  if (!isTrustedFolder && (resolved === Yolo || resolved === AutoEdit))
    return parent;   // demote
  return resolved;
}

// 3. Defaults
if (parent === PLAN)   return Plan;          // PLAN sticks downward
if (isTrustedFolder)   return AutoEdit;
return parent;
```

**Hierarchy: permissive parent > agent frontmatter > trusted-folder default > parent.** Critical features:
- **`YOLO`/`AUTO_EDIT` parent floors the child** (you can't downgrade a permissive parent into a restrictive child)
- **`PLAN` parent is sticky** — analyze-only session can never mutate via child
- **Privileged modes quarantined to trusted folders**

### Config isolation

`createApprovalModeOverride` (lines 245-255):
```ts
const override = Object.create(base);              // prototype-delegated clone
override.getApprovalMode = () => mode;
await rebuildToolRegistryOnOverride(override, base);
return override;
```

Why it matters:
1. **FileReadCache isolation** — child has own `ReadFile` history so parent's `prior_read` cannot satisfy a write-gate on a path the child never read.
2. **Tool registry rebind** — re-runs `createToolRegistry({skipDiscovery, forSubAgent: true})` so core tools bind their `Config` to child, not parent. `TOOL_REGISTRY_REBUILT` symbol guards against wrapper-on-wrapper rebuilds.

### Subagent frontmatter

`packages/core/src/subagents/subagent-manager.ts` reads YAML frontmatter: `approvalMode`, `tools` (allowlist), `disallowedTools` (blocklist, supports `mcp__server` glob to block whole MCP servers), `model`. Validates `approvalMode` against `APPROVAL_MODES`.

Allowlist applied first, then blocklist subtracts.

### Fork mode

`fork-subagent.ts` — implicit fork (LLM omits `subagent_type`); inherits parent's full conversation; uses `AsyncLocalStorage` markers to **reject nested fork-from-fork**.

Background/headless: `getShouldAvoidPermissionPrompts()` auto-denies any prompt (no UI to answer).

## Side-by-side

| | Goose | Qwen Code |
|---|---|---|
| Modes | auto/smart_approve/approve/chat | yolo/auto-edit/default/plan |
| Smart classifier | Yes (LLM-judged + cached) | No (binary trust check + per-tool annotation) |
| Plan mode | No | Yes (with prePlanMode snapshot) |
| Subagent inheritance | None | Explicit `resolveSubagentApprovalMode` (parent permissive wins) |
| Config isolation | N/A | `Object.create(base)` + tool-registry rebind + read-cache reset |
| Nested-subagent guard | N/A | `AsyncLocalStorage` rejects fork-from-fork |

## Translating to bodhi-pi

| Pattern | Bodhi-pi take |
|---|---|
| Goose `SmartApprove` LLM classifier | **Skip for v1**: requires extra LLM round-trip + cache infra. Bodhi-pi's `toolKindFor` + manual `read`/`edit`/`execute` category covers the same UX with no classifier. Revisit only if a clear user demand emerges. |
| Goose `chat` mode (no tool execution) | Adopt: in bodhi-pi this is just `ask` mode with all tools' policy set to `deny`. Don't need a separate enum value. |
| Goose `PermissionLevel` (per-tool always/ask/never) | Adopt: mastracode's per-tool override map covers this. |
| Goose: subagent inherits nothing | **Reject.** Bodhi-pi's `SubagentProfile` should explicitly inherit parent mode with conservative downgrade. Goose's "no inheritance" is fragile and recipe-author dependent. |
| Qwen `resolveSubagentApprovalMode` (permissive parent wins) | **Adopt verbatim** as the bodhi-pi sub-agent rule. Pseudo: `child.mode = max_permissive(parent.mode, profile.mode constrained-to-trusted)`. The "PLAN parent sticks downward" property is especially important — bodhi-pi `planner` profile would be useless if a YOLO child could escape it. |
| Qwen trusted-folder gate | Adopt for `allow-all`: bodhi-pi requires explicit `allowsAllowAllMode: true` host capability AND project setting `dangerouslyAllowAllowAllMode: true` to enable mode. Browser/Chrome-ext default deny. |
| Qwen `Object.create(base)` + tool-registry rebind | bodhi-pi's `SubagentService.spawn` already builds a separate child `piAgent` with its own tool list (`SubagentProfile.tools`). The state-isolation property is already met. Worth auditing whether parent's `read` cache could leak to child via shared `Filesystem` adapter — if so, add per-session cache scope. |
| Qwen nested-fork rejection (`AsyncLocalStorage`) | Bodhi-pi already has `SUBAGENT_MAX_DEPTH = 2` cap. Equivalent guarantee. |
| Qwen frontmatter `approvalMode`/`tools`/`disallowedTools` | bodhi-pi `SubagentProfile.tools` already exists as allowlist. Add `disallowedTools` (with `mcp__server` glob) in v2; add per-profile `mode?` override in v2. |
| Qwen `PLAN` mode with `prePlanMode` snapshot | Adopt: switching to `plan` saves previous mode; `/exit-plan` or `submit_plan` approval restores. |
