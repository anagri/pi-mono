# Mastracode + Mastra core — modes & permissions notes

## Core insight: modes vs permissions are orthogonal axes

Mastracode is the cleanest separation of concerns I saw. Modes (`build/plan/fast`) drive **behaviour and model selection** (system prompt persona + default model). Permissions drive **tool gating**. YOLO is a separate global override on permissions. These three concepts compose without overlapping.

## Mode definitions

`mastracode/src/index.ts:372-395`:

```ts
const defaultModes: HarnessMode<...>[] = [
  { id: 'build', name: 'Build', default: true, defaultModelId: 'anthropic/claude-opus-4-6', agent: codeAgent },
  { id: 'plan',  name: 'Plan',                  defaultModelId: 'openai/gpt-5.2-codex',     agent: codeAgent },
  { id: 'fast',  name: 'Fast',                  defaultModelId: 'cerebras/zai-glm-4.7',     agent: codeAgent },
];
```

All three modes use the same `codeAgent`. The differentiator is `defaultModelId` and the runtime-injected `modeId` field on the agent context (which influences `getDynamicInstructions` → system prompt).

## Core harness mode type

`packages/core/src/harness/types.ts:43-67`:

```ts
export interface HarnessMode<TState> {
  id: string;
  name?: string;
  default?: boolean;
  defaultModelId?: string;
  color?: string;
  agent: Agent | ((state: TState) => Agent);
}
```

## Mode switching

`packages/core/src/harness/harness.ts:548-574`:

```ts
async switchMode({ modeId }: { modeId: string }): Promise<void> {
  const mode = this.config.modes.find(m => m.id === modeId);
  if (!mode) throw new Error(`Mode not found: ${modeId}`);
  this.currentModeId = modeId;
  await this.setThreadSetting({ key: 'currentModeId', value: modeId });
  const modeModelId = await this.loadModeModelId(modeId);
  if (modeModelId !== this.currentModelId) this.currentModelId = modeModelId;
  this.emit({ type: 'mode_changed', modeId, previousModeId });
}
```

Mode is **persisted per-thread**, not per-session. Switching threads restores the thread's last mode.

## Mode → behaviour

1. **System prompt**: `mastracode/src/agents/instructions.ts:11-34` — `getDynamicInstructions` reads `modeId` from harness context, passes to `buildFullPrompt(promptCtx)`. Mode-specific instructions.
2. **Model**: each mode has its own `defaultModelId`. Users override per-mode via `/models`.
3. **Tools**: NOT mode-filtered. All tools available in all modes; restrictions enforced through permissions, not modes.

## Plan mode: instructional, not enforced

**Plan mode does not disable edit/execute tools.** Plan-mode enforcement is entirely through:
- System prompt steering toward `submit_plan` tool
- The `submit_plan` tool itself, which suspends the agent loop until user approves

`packages/core/src/harness/tools.ts:133-199`:

```ts
export const submitPlanTool = createTool({
  id: 'submit_plan',
  inputSchema: z.object({ title: z.string().optional(), plan: z.string().min(1) }),
  execute: async ({ title, plan }, context) => {
    const harnessCtx = context?.requestContext?.get('harness');
    const planId = `plan_${++planCounter}_${Date.now()}`;
    const result = await new Promise(resolve => {
      harnessCtx.registerPlanApproval!({ planId, resolve });
      harnessCtx.emitEvent!({ type: 'plan_approval_required', planId, title, plan });
    });
    if (result.action === 'approved') {
      // harness auto-switches to build mode
      return { content: 'Plan approved. Proceed with implementation...', isError: false };
    }
    // else feedback for revision
  },
});
```

Approval UI inline (`tui/components/plan-approval-inline.ts`): Approve | Request Changes | Use as /goal.

## YOLO: per-session global override

`mastracode/src/schema.ts:27`: `yolo: z.boolean().default(false)` — persisted per-thread in state.

`mastracode/src/permissions.ts:112-118`:
```ts
export const YOLO_POLICIES: Record<ToolCategory, PermissionPolicy> = {
  read: 'allow', edit: 'allow', execute: 'allow', mcp: 'allow',
};
```

Ctrl+Y toggle (`tui/setup.ts:153-158`); persisted globally via `~/.mastracode/settings.json` preferences.

## Permission system

`mastracode/src/permissions.ts:15-110`:

```ts
type ToolCategory = 'read' | 'edit' | 'execute' | 'mcp';
type PermissionPolicy = 'allow' | 'ask' | 'deny';

interface PermissionRules {
  categories: Partial<Record<ToolCategory, PermissionPolicy>>;
  tools: Record<string, PermissionPolicy>;
}

const DEFAULT_POLICIES: Record<ToolCategory, PermissionPolicy> = {
  read: 'allow',      // safe — always allowed
  edit: 'ask',
  execute: 'ask',
  mcp: 'ask',
};

const ALWAYS_ALLOW_TOOLS = new Set([
  'ask_user', 'task_write', 'task_update', 'task_complete', 'task_check',
  'submit_plan', 'request_access',
]);
```

## Resolution priority

`mastracode/src/permissions.ts:177-199`:

```ts
function resolveApproval(toolName, rules, sessionGrants): ApprovalDecision {
  if (category === null) return 'allow';        // ALWAYS_ALLOW_TOOLS
  const toolPolicy = rules.tools[toolName];
  if (toolPolicy) return toolPolicy;             // 1. per-tool override
  if (sessionGrants.isGranted(toolName, category)) return 'allow';
                                                 // 2. session grants
  const categoryPolicy = rules.categories[category];
  if (categoryPolicy) return categoryPolicy;     // 3. category policy
  return DEFAULT_POLICIES[category] ?? 'ask';    // 4. defaults
}
```

**Priority: per-tool > session-grant > category > default.**

## Session grants (ephemeral)

`mastracode/src/permissions.ts:131-159`:

```ts
class SessionGrants {
  private grantedCategories = new Set<ToolCategory>();
  private grantedTools = new Set<string>();
  allowCategory(category): void { this.grantedCategories.add(category); }
  allowTool(toolName): void { this.grantedTools.add(toolName); }
  isGranted(toolName, category): boolean {
    return this.grantedTools.has(toolName) || this.grantedCategories.has(category);
  }
  reset(): void { this.grantedCategories.clear(); this.grantedTools.clear(); }
}
```

Cleared on thread switch; not persisted.

## Approval dialog

`tui/components/tool-approval-dialog.ts:17-21`:

```ts
type ApprovalAction =
  | { type: 'approve' }                       // y
  | { type: 'decline' }                       // n / Esc
  | { type: 'always_allow_category' }         // a — adds to SessionGrants
  | { type: 'yolo' };                         // Y — flips YOLO on
```

## Approval transport

`packages/core/src/harness/harness.ts:2354-2387` — `tool-call-approval` is an agent **stream chunk type**. Harness intercepts it:

```ts
case 'tool-call-approval': {
  const approval = await new Promise(resolve => {
    this.emit({ type: 'tool_approval_required', toolCallId, toolName, args });
    this.pendingApprovals.set(toolCallId, resolve);
  });
  if (approval.decision === 'approve') await this.handleToolApprove({ toolCallId, ... });
  else await this.handleToolDecline({ toolCallId, ... });
}
```

Stream-based approval is interesting — it means the agent itself emits "I want to call this tool, approve?" as part of its output stream, and the harness intercepts before letting the call run.

## Sub-agent inheritance

`mastracode/src/index.ts:370-487` — subagent type maps to a mode for **model selection**:
```ts
const subagentModeMap: Record<string, string> = {
  explore: 'fast', plan: 'plan', execute: 'build',
};
```

Per-subagent tool restrictions via `allowedWorkspaceTools`:
- `explore`: `[VIEW, SEARCH_CONTENT, FIND_FILES]` (read-only)
- `plan`: `[VIEW, SEARCH_CONTENT, FIND_FILES]` (read-only)
- `execute`: no restriction

Permissions/YOLO are **inherited from parent** by sharing the harness request context; subagent runs use the parent's permission rules and YOLO state directly.

## Goal mode

Separate from build/plan/fast — a "ralph loop" with a judge model evaluating progress. Goal mode does NOT auto-approve tools; it inherits whatever permission settings the user has.

## Hooks for project-specific restrictions

`mastracode/src/agents/tools.ts:18-49` — PreToolUse hook can block any tool execution at runtime, orthogonal to permissions. Lets projects add custom rules like "block write to /vendor" without modifying mastracode.

## Tool removal when denied

`mastracode/src/agents/tools.ts:104-112` — tools with `policy: 'deny'` are stripped from the tool set passed to the model:

```ts
if (permissionRules?.tools) {
  for (const [name, policy] of Object.entries(permissionRules.tools)) {
    if (policy === 'deny') delete tools[name];
  }
}
```

The model never sees denied tools.

## Translating to bodhi-pi

| mastracode | Bodhi-pi take |
|---|---|
| Three orthogonal axes (mode / permissions / YOLO) | Adopt. Strongest separation in the surveyed harnesses. Maps to Bodhi-pi's already-orthogonal `SubagentProfile.tools` + `model` + `appendSystemPrompt`. |
| Mode = `(id, name, defaultModelId, agent)` | Adopt. But bodhi-pi modes don't need to swap *agent*; the same `runPromptLoop` runs for every mode. So `Mode = (id, name, defaultModelId?, systemPromptSuffix?, permission overrides?)`. |
| Plan = instructional + submit_plan tool | Adopt. Bodhi-pi already has the `subagent` `planner` profile (read-only); plan-mode can use a similar tool flow with an approval over the wire. Match plannotator's `submit_plan` approach for the actual approval UI. |
| Tool categories `read/edit/execute/mcp` | Already exist as `toolKindFor` — just rename or alias. |
| `PermissionPolicy = 'allow' \| 'ask' \| 'deny'` | Adopt. Standard across cc, opencode, mastracode, gemini. |
| Resolution: per-tool > session-grant > category > default | Adopt verbatim. |
| Session grants cleared on thread switch | Adopt. Stored on `SessionState`, not persisted. |
| YOLO global override | Adopt. Can be a separate `permissionMode: "allow-all"` value, or a separate `yolo: boolean`. Recommend: collapse into mode enum (`mode: "allow-all"`) — keeps API tight. |
| Stream-chunk approval transport | bodhi-pi already streams `tool_call` (in-progress) and `tool_call_update` to ACP. Approval can ride a new `pending_approval` status + an out-of-band `_bodhi-pi/permission/request` ↔ `respond` pair. |
| Tool removal when denied | Adopt v2: rebuild active tool set when permission changes from `allow` → `deny`. v1 can just block at call-time. |
| Hooks as orthogonal blockers | Already exists via `ToolCallEventResult.block`. |
