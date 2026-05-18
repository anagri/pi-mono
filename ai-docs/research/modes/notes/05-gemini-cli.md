# gemini-cli — modes & permissions notes

## Approval mode union

`packages/core/src/policy/types.ts:48-65`:

```ts
export enum ApprovalMode {
  DEFAULT  = 'default',
  AUTO_EDIT = 'autoEdit',
  YOLO      = 'yolo',
  PLAN      = 'plan',
}
export const MODES_BY_PERMISSIVENESS = [
  ApprovalMode.PLAN, ApprovalMode.DEFAULT, ApprovalMode.AUTO_EDIT, ApprovalMode.YOLO,
];
```

Permissiveness lattice declared explicitly: tools allowed at PLAN < DEFAULT < AUTO_EDIT < YOLO.

## Tool kinds

`packages/core/src/tools/tools.ts:1104-1118`:

```ts
export enum Kind {
  Read, Edit, Delete, Move, Search, Execute, Think, Agent, Fetch,
  Communicate, Plan, SwitchMode, Other,
}
```

Bodhi-pi's `toolKindFor` covers a subset: `read | edit | search | execute | other`.

## Confirmation outcome enum

`packages/core/src/tools/tools.ts:1094-1102`:

```ts
export enum ToolConfirmationOutcome {
  ProceedOnce            = 'proceed_once',
  ProceedAlways          = 'proceed_always',
  ProceedAlwaysAndSave   = 'proceed_always_and_save',   // persist allow
  ProceedAlwaysServer    = 'proceed_always_server',     // MCP server-level
  ProceedAlwaysTool      = 'proceed_always_tool',
  ModifyWithEditor       = 'modify_with_editor',        // edit before approving
  Cancel                 = 'cancel',
}
```

Note `ModifyWithEditor` — user can change the tool input before approving. Useful for Bash and Edit.

## Confirmation flow via MessageBus

`tools.ts:277-371`. Tool posts a `ToolConfirmationRequest{correlationId, toolCall, serverName, ...}` on MessageBus; awaits `ToolConfirmationResponse` with 30s timeout. Bus decouples policy from TUI.

```ts
async shouldConfirmExecute(abortSignal, forcedDecision?) {
  if (this.respectsAutoEdit && this.getApprovalMode() === ApprovalMode.AUTO_EDIT && forcedDecision !== 'ask_user') {
    return false;  // bypass for edit tools in AUTO_EDIT
  }
  const decision = forcedDecision ?? await this.getMessageBusDecision(abortSignal);
  if (decision === 'allow') return false;
  if (decision === 'deny') throw new Error(`Tool execution for "${name}" denied by policy.`);
  return this.getConfirmationDetails(abortSignal);
}
```

## Per-tool `respectsAutoEdit`

Tools declare via constructor flag `respectsAutoEdit: boolean`. AUTO_EDIT mode auto-approves only those marked true. Write/Edit/Move/Delete typically set it; Bash/Execute do not.

## Policy engine

Rule shape (interface in policy types):

```ts
interface PolicyRule {
  name?: string;
  toolName: string;
  subagent?: string;
  mcpName?: string;
  argsPattern?: RegExp;
  toolAnnotations?: Record<string, unknown>;
  decision: PolicyDecision;       // 'allow' | 'deny' | 'ask_user'
  priority?: number;
  modes?: ApprovalMode[];          // rule applies only in these modes
  interactive?: boolean;
  allowRedirection?: boolean;
  source?: string;
  denyMessage?: string;
}

// YOLO mode adds:
const YOLO_RULE = { toolName: '*', decision: 'allow', priority: 998 }; // PRIORITY_YOLO_ALLOW_ALL
```

Rules can be scoped to mode list — clean way to express "this rule only matters in DEFAULT".

## CLI flags

```
gemini --yolo            # = --approval-mode=yolo (mutually exclusive with --approval-mode)
gemini -y                # alias for --yolo
gemini --approval-mode=<default|auto_edit|yolo|plan>
gemini --policy <file>   # additional policy rules
gemini --admin-policy <file>  # admin (locked) policy
gemini --allowed-mcp-server-names server1,server2
gemini --sandbox <auto|podman|docker|none>
```

CLI parsing rejects `--yolo` + `--approval-mode` simultaneously (`config.ts:256-257`).

## Settings file

`~/.gemini/settings.json`:
```json
{
  "general": { "defaultApprovalMode": "default|auto_edit|plan" },
  "security": { "disableYoloMode": false, "disallowAlwaysAllow": false }
}
```

Note: `yolo` is **not settable in config** — CLI-only. Workspace settings (`.gemini/settings.json`) only apply if workspace is trusted.

## Sandbox

`packages/core/src/services/sandboxManager.ts:32-99`:

```ts
interface SandboxModeConfig {
  readonly?: boolean;
  network?: boolean;
  approvedTools?: string[];
  allowOverrides?: boolean;
  yolo?: boolean;
}
```

Platform impl:
- macOS: `sandbox-exec(1)` Seatbelt
- Linux: Docker/Podman containers
- Windows: Job objects

Sandbox resolves writable paths from: workspace, globalIncludes, policy allow rules, current command's policy.

## Subagent inheritance

`packages/core/src/agents/local-executor.ts:120-146`:

```ts
private get executionContext(): AgentLoopContext {
  return {
    config: this.context.config,
    promptId: this.agentId,
    parentSessionId: this.context.parentSessionId || this.context.promptId,
    geminiClient: this.context.geminiClient,
    sandboxManager: this.context.sandboxManager,    // ★ same sandbox
    toolRegistry: this.toolRegistry,                // ★ child-isolated registry
    promptRegistry: this.promptRegistry,
    resourceRegistry: this.resourceRegistry,
    messageBus: this.toolRegistry.getMessageBus(),  // ★ confirmations go to parent UI
  };
}
```

**Inherited**: approval mode (via parent context), sandbox, MessageBus.
**Child-isolated**: tool registry (restricted set).

## Remote agent (A2A) — sovereign approval

`packages/core/src/agents/remote-invocation.ts:42-86`. Parent shows confirmation for "invoke remote agent X"; remote runs with **its own** approval mode + policy. Approval decisions don't cross the A2A boundary. Useful pattern: trust boundary at the network edge.

## Translating to bodhi-pi

| gemini-cli | Bodhi-pi take |
|---|---|
| 4 modes with explicit permissiveness lattice | Adopt 4-mode union: `ask \| plan \| edit \| allow-all` (rename `default`→`ask`, `auto_edit`→`edit`, `yolo`→`allow-all`). Document lattice for code review. |
| `respectsAutoEdit` per tool | Adopt. Built-in tools `write`/`edit` mark `respectsEditMode: true`; `bash`/`run_script` do not. |
| 7-value confirmation outcome | Bodhi-pi: trim to `once \| always \| always_tool \| once_modified \| deny`. `modify_with_editor` is host-specific (TUI editor) — represent as `once_modified` with new input payload. |
| Policy rules with optional `modes: [...]` filter | Adopt for v2. v1 can have a flat per-tool/per-category policy. |
| MessageBus + correlationId + timeout | Bodhi-pi: lifecycle event `tool_approval_request{correlationId}` + wire method `_bodhi-pi/permission/respond{correlationId, decision}`. 30s default timeout configurable. |
| Sandbox as platform shim | **Skip** for bodhi-pi core. Browser/Chrome-ext can't sandbox-exec. Document as "host's responsibility to wrap Filesystem/Terminal adapters for path scoping". Add settings key `sandbox.allowedPaths: string[]` that hosts can read and enforce in their Filesystem adapter. |
| Local executor inherits sandbox+messagebus, isolates tool registry | Bodhi-pi already isolates child tool registry via `SubagentProfile.tools`. Approval-request bus inheritance: child requests routed to parent session ID (UI sees them all). |
| Remote agent = sovereign policy | Apply same lens to MCP server tools — bodhi-pi already separates global MCP connection from per-session inclusion. MCP server tools should follow parent session's mode by default, but expose a config knob for "treat MCP as sovereign (require explicit allow)". |
| `--yolo` not in settings file | Adopt: `allow-all` mode is wire-only (`_bodhi-pi/mode/set`), never persisted at project/global scope unless `--allow-allow-all-mode` is set. Mirrors cc's `--allow-dangerously-skip-permissions` two-step. |
