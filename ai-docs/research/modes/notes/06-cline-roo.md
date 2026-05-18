# Cline + Roo Code — modes notes

## Cline: binary plan/act

Type: `Mode = "plan" | "act"`.

Persisted in `StateManager` global state under key `mode`. Siblings: `planActSeparateModelsSetting`, `strictPlanModeEnabled`, `yoloModeToggled`. Toggle RPC: `StateServiceClient.togglePlanActModeProto`.

**Defence-in-depth plan-mode enforcement** in `src/core/task/ToolExecutor.ts`:

```ts
if (
  stateManager.getGlobalSettingsKey("strictPlanModeEnabled") &&
  stateManager.getGlobalSettingsKey("mode") === "plan" &&
  block.name &&
  this.isPlanModeToolRestricted(block.name)
) { /* throw / reject */ }
```

Error to model: "Tool '[name]' is not available in PLAN MODE."

Restricted tools (minimum): `FILE_NEW`, `FILE_EDIT`, `NEW_RULE`, `APPLY_PATCH`.

System prompt regenerated per mode so only contextually-relevant tools are described.

`READ_ONLY_TOOLS = [list_files, read_file, search_files, list_code_definition_names, browser_action, ask_followup_question, web_search, web_fetch, use_skill, use_subagents]` — everything else is implicitly write-capable for plan-mode gating.

## Cline AutoApprovalSettings

8 per-capability booleans:
```ts
actions: {
  readFiles, readFilesExternally, editFiles, editFilesExternally,
  executeSafeCommands, executeAllCommands, useBrowser, useMcp,
}
maxRequests       // cap on consecutive auto-approved calls before re-prompt
enableNotifications
```

Defaults: only `readFiles + executeSafeCommands + useMcp` auto-approved. `executeSafeCommands` vs `executeAllCommands` splits a low-risk-shell allowlist from full shell.

## Roo Code: open mode system

`packages/types/src/mode.ts`:

```ts
const modeConfigSchema = z.object({
  slug: z.string().regex(/^[a-zA-Z0-9-]+$/),
  name: z.string().min(1),
  roleDefinition: z.string().min(1),
  whenToUse: z.string().optional(),
  description: z.string().optional(),
  customInstructions: z.string().optional(),
  groups: groupEntryArraySchema,
  source: z.enum(["global", "project"]).optional(),
})
```

Built-in `DEFAULT_MODES`:

| slug | name | groups |
|---|---|---|
| `architect` | 🏗️ Architect | `["read", ["edit", { fileRegex: "\\.md$", description: "Markdown files only" }], "mcp"]` |
| `code` | 💻 Code | `["read", "edit", "command", "mcp"]` |
| `ask` | ❓ Ask | `["read", "mcp"]` |
| `debug` | 🪲 Debug | `["read", "edit", "command", "mcp"]` |
| `orchestrator` | 🪃 Orchestrator | `[]` (delegates via `new_task`) |

## Roo Code tool groups

`src/shared/tools.ts`:

```ts
const TOOL_GROUPS: Record<ToolGroup, ToolGroupConfig> = {
  read:    { tools: ["read_file", "search_files", "list_files", "codebase_search"] },
  edit:    { tools: ["apply_diff", "write_to_file", "generate_image"],
             customTools: ["edit", "search_replace", "edit_file", "apply_patch"] },
  command: { tools: ["execute_command", "read_command_output"] },
  mcp:     { tools: ["use_mcp_tool", "access_mcp_resource"] },
  modes:   { tools: ["switch_mode", "new_task"], alwaysAvailable: true },
}

const ALWAYS_AVAILABLE_TOOLS: ToolName[] = [
  "ask_followup_question", "attempt_completion", "switch_mode",
  "new_task", "update_todo_list", "run_slash_command", "skill",
]
```

`GroupEntry = ToolGroup | [ToolGroup, { fileRegex, description }]`.

## File-regex enforcement

`src/core/tools/validateToolUse.ts`. Priority:
1. Tool-disabled guard
2. `ALWAYS_AVAILABLE_TOOLS` short-circuit
3. Custom/MCP tool resolution
4. Mode-group membership
5. Group-option constraints (regex)

When edit fails step 5:
```ts
throw new FileRestrictionError(mode, pattern, description, filePath, tool)
```

Special handling for `apply_patch`: parses file paths out of patch markers and individually regex-checks each.

`groupOptionsSchema` validates regex at config-load (`.refine(p => { try { new RegExp(p); return true; } catch { return false; }})`).

## Roo custom modes (YAML)

`.roomodes` (project) or `~/.roo/custom_modes.yaml` (global):

```yaml
customModes:
  - slug: docs-writer
    name: 📝 Documentation Writer
    description: A specialized mode for writing technical documentation.
    roleDefinition: You are a technical writer specializing in clear documentation.
    whenToUse: Use this mode for writing and editing documentation.
    customInstructions: Focus on clarity and completeness in documentation.
    groups:
      - read
      - - edit
        - fileRegex: \.(md|mdx)$
          description: Markdown files only
```

Precedence (whole-record override):
1. `.roomodes` (project)
2. `~/.roo/...` (global)
3. Built-in defaults

## Mode switching

Roo Code (5 entry points):
1. Dropdown to left of chat input
2. Slash commands: `/architect /ask /debug /code /orchestrator`
3. Keyboard: `⌘ .` / `Ctrl .` cycles
4. Roo emits inline suggestions
5. Agent self-switches via `switch_mode` tool (in always-available `modes` group)

Cline: Plan/Act toggle button in `ChatTextArea`. No slash, no agent-driven switch. YOLO escalates plan→act without user.

## Translating to bodhi-pi

**Pick Roo's group model, Cline's defence-in-depth, mastracode's orthogonal axes.** Concrete adoptions:

| Pattern | Bodhi-pi take |
|---|---|
| Roo `TOOL_GROUPS` (read/edit/command/mcp) | Map onto existing `toolKindFor` axes. Add `mcp` group for MCP tools. Add `subagent` group for the `subagent` tool. |
| Roo `GroupEntry = group \| [group, {fileRegex, description}]` | Adopt for v2. v1 can use simple group allowlist; file-regex restriction is a v2 nice-to-have. |
| Roo `ALWAYS_AVAILABLE_TOOLS` | Adopt: `ask_user` (if added later), `attempt_completion`, `switch_mode` (the mode-change tool, if exposed to LLM). Bodhi-pi's `subagent` tool sits in its own gate. |
| Cline `strictPlanModeEnabled` runtime guard | **Always-on**. Never trust LLM to honour plan-mode prompt-only restriction. `tool_call` event handler enforces. |
| Cline `READ_ONLY_TOOLS` explicit allowlist | Use it as the v1 `plan` mode's tool allowlist. |
| Roo open `ModeConfig` schema with project/global precedence | Defer. v1 ships 4 hard-coded modes (`ask/plan/edit/allow-all`). v3 can add YAML/markdown custom modes mirroring `SubagentProfile` discovery. |
| Roo `switch_mode` tool exposed to LLM | **Don't expose to LLM by default.** Mode change is a user-initiated event (slash command / wire method). LLM-initiated mode change is a self-elevation risk. |
| Cline AutoApprovalSettings 8 toggles | Too granular for a first cut. The category × action matrix in mastracode/opencode/cc covers the same ground with less surface. Bodhi-pi: per-category default + per-tool override (mastracode's resolution). |
| Roo `FileRestrictionError` structured | Adopt: deny errors carry `{mode, pattern, description?, filePath?, toolName}` so the LLM can adjust. |
| Roo `source: "global" \| "project"` provenance | Adopt for custom modes (v3): UI shows which file the mode came from. |
