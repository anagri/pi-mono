# cc (claude code) — modes & permissions deep-dive notes

## Mode union

`src/types/permissions.ts:16-38`

```
EXTERNAL_PERMISSION_MODES = [acceptEdits, bypassPermissions, default, dontAsk, plan]
INTERNAL_PERMISSION_MODES adds: auto  (ant-only, TRANSCRIPT_CLASSIFIER feature flag)
type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' | 'dontAsk' | 'auto'
```

`src/utils/permissions/PermissionMode.ts:42-91` — per-mode title/shortTitle/symbol/color metadata for the status bar.

## Enforcement pipeline

`src/utils/permissions/permissions.ts:473-1319`. The `hasPermissionsToUseTool` → `hasPermissionsToUseToolInner` chain runs **in this order**:

1. **Deny rules** (1171) — explicit deny rules in any source layer
2. **Ask rules** (1184) — rules that force a prompt
3. **Tool-specific checks** (1214-1259) — `tool.checkPermissions()`, safety paths (`.git/`, `.claude/`, shell configs)
4. **Mode bypass** (1268-1281):
   ```ts
   const shouldBypassPermissions =
     ctx.mode === 'bypassPermissions' ||
     (ctx.mode === 'plan' && ctx.isBypassPermissionsModeAvailable)
   if (shouldBypassPermissions) return { behavior: 'allow', ... }
   ```
5. **Rule allow** (1284-1297) — tool is in an always-allow list
6. **Convert passthrough → ask** (1300-1310)
7. **`auto` classifier** (520-927) — AI classifier instead of prompt
8. **`dontAsk`** (508-517) — convert ask → deny
9. **Async-agent path** (932-952) — headless agents auto-deny or run `PermissionRequest` hooks

**Bypass-immune steps**: deny rules (1a), explicit ask rules (1b), and safety paths (1g) survive `bypassPermissions`.

## Per-tool rules

`src/utils/permissions/permissions.ts:122-302`. Rule shape:

```ts
type PermissionRule = {
  source: 'userSettings' | 'projectSettings' | 'localSettings' | 'cliArg' | 'session' | 'policySettings'
  ruleBehavior: 'allow' | 'deny' | 'ask'
  ruleValue: { toolName: string; ruleContent?: string }
}
```

Patterns: whole-tool (`Bash`), content-prefix (`Bash(prefix:npm install)`, `Edit(/some/path)`), MCP server-level (`mcp__server1`), MCP-tool wildcard (`mcp__server1__*`).

Helpers: `toolAlwaysAllowedRule`, `getDenyRuleForTool`, `getAskRuleForTool`, `getRuleByContentsForTool`.

## `plan` mode

Tools: `EnterPlanModeTool` (`src/tools/EnterPlanModeTool/EnterPlanModeTool.ts:77-102`) + `ExitPlanModeV2Tool` (`src/tools/EnterPlanModeTool/ExitPlanModeV2Tool.ts:243-403`).

Enter calls `applyPermissionUpdate({type:'setMode', mode:'plan'})`. Plan mode restricts to read-only tools (Explore/Plan agents declare `permissionMode: 'plan'`), but Write/Edit/Bash still pass through to approval (not auto-blocked, just no auto-allow).

Exit (`ExitPlanModeV2Tool`) requires user interaction (`requiresUserInteraction() → true`), shows approval dialog. Teammate-agent variant uses `plan_approval_request` over mailbox to team lead (264-313). Mode restoration to `prePlanMode` (357-403); falls back to `default` if auto-mode gate flipped mid-session.

## `acceptEdits`

`permissions.ts:607-620`. Within the auto-mode classifier hot-path, cc **simulates `acceptEdits`** to short-circuit expensive classifier calls when the simulated mode would already allow:

```ts
const result = await tool.checkPermissions(parsedInput, {
  ...context,
  getAppState: () => ({ ...state, toolPermissionContext: { ...state.toolPermissionContext, mode: 'acceptEdits' }})
})
if (result.behavior === 'allow') return { behavior: 'allow', ... }
```

`acceptEdits` itself auto-allows Edit/Write within cwd; Bash/destructive operations still prompt.

## `bypassPermissions` / `--dangerously-skip-permissions`

`src/main.tsx:976` (CLI flag) + `src/setup.ts:334-437` (safety gates):
- Reject root/sudo
- Only inside sandboxed containers (Docker, Bubblewrap, `IS_SANDBOX=1`) with no internet (verified at startup)
- Two flags: `--dangerously-skip-permissions` (enable + activate); `--allow-dangerously-skip-permissions` (enable mode availability without setting it)

`src/utils/permissions/bypassPermissionsKillswitch.ts` — Statsig circuit-breaker disables mode mid-session if the gate flips.

## Approval persistence

`src/utils/permissions/permissionsLoader.ts` + `PermissionUpdate.ts`. User approves → `applyPermissionUpdate()` adds to `alwaysAllowRules[destination]` → `persistPermissionUpdates()` writes to disk (skipping `session`/`cliArg` scopes). Sources: `~/.claude/settings.json`, `<project>/.claude/settings.json`, `.claude/settings.local.json` (gitignored), in-memory session, CLI args.

`syncPermissionRulesFromDisk()` rehydrates `ToolPermissionContext` on new session.

## Sub-agent mode inheritance

`src/tools/AgentTool/runAgent.ts:415-479`. **Not blind inheritance**:

1. `agentDefinition.permissionMode` proposes a child mode (per-agent profile)
2. **Parent mode overrides** if parent is in `bypassPermissions`, `acceptEdits`, or `auto` — child gets that mode regardless of profile
3. Async agents get `shouldAvoidPermissionPrompts: true` (auto-deny prompts, run hooks)
4. Background async: `awaitAutomatedChecksBeforeDialog: true` (classifier/hooks first, UI only if needed)
5. Tool allowlisting (469-479): child's `allowedTools` replaces parent session rules but preserves CLI-arg rules

`spawnMultiAgent.ts:220-230` — child spawn translates mode to a CLI flag for the subprocess (`--dangerously-skip-permissions`, `--permission-mode acceptEdits`, `--permission-mode auto`).

## CLI flags

```
--dangerously-skip-permissions
--allow-dangerously-skip-permissions
--permission-mode <default|acceptEdits|plan|bypassPermissions|dontAsk|auto>
--permission-prompt-tool         # MCP tool for assistant-facing semantic approval prompts
```

## UI

Shift+Tab cycles modes via `cyclePermissionMode()` → `getNextPermissionMode()` (`src/utils/permissions/getNextPermissionMode.ts:34-101`).

User cycle: `default → acceptEdits → plan → bypassPermissions? → auto? → default`
Ant-only cycle: `default → bypassPermissions? → auto? → default` (skips acceptEdits & plan).

Gates: `bypassPermissions` only cyclable if `isBypassPermissionsModeAvailable: true` (CLI-flag-set); `auto` only if feature-flagged + gate-enabled.

Bash tool re-reads appState after Shift+Tab so mid-execution mode changes apply (`permissions.ts:2227,2405`).

## Translating to bodhi-pi

| cc mechanism | Bodhi-pi analogue | Notes |
|---|---|---|
| `EXTERNAL_PERMISSION_MODES` union | `AgentMode = "ask" \| "plan" \| "edit" \| "allow-all"` | Add `auto` (LLM-as-classifier) only if there's a clear use; ant-only is org-specific |
| Per-tool rules with sources | Settings layers (`global/project/session`) × per-tool decision | Reuse `EXT_SESSION_SETTINGS_*` |
| Plan mode = `setMode` + read-only profile | Same: mode change emits lifecycle event, planner system-prompt suffix, narrowed tool list | `EnterPlanMode`/`ExitPlanMode` cc-style tools optional; bodhi-pi can do a slash command + wire method |
| Bypass safety gate (root/sandbox check) | Host-injected `Filesystem`/`Terminal` — host owns the sandbox; agent declares intent | bodhi-pi runs in browser worker too — no OS sandbox path |
| Shift+Tab cycle | Wire method `_bodhi-pi/mode/set` + status surface via lifecycle event | Hosts implement key bindings themselves |
| AgentTool inheritance with parent-mode-overrides | `SubagentProfile.mode?` + downgrade matrix | Lean conservative: parent in `allow-all` → child in `ask` unless explicit |
| `dontAsk` mode (convert ask → deny) | Combine with `ask` decision: a deny-only policy is already expressible via per-tool `deny` | Skip — too obscure |
| `auto` (LLM classifier) | Defer to v2+; needs second-LLM-as-judge wiring | Out of scope for v1 |
