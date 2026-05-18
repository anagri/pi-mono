# Plannotator — per-harness plan-mode hooks notes

## What it is

Plannotator is a multi-harness companion that adds visual plan-review UI on top of several coding harnesses. It ships per-harness apps under `apps/`:

- `apps/codex/` — README only (integration via Codex hooks/config)
- `apps/copilot/` — Copilot integration
- `apps/gemini/` — `commands/` + `hooks/` for gemini-cli
- `apps/opencode-plugin/` — opencode plugin (full impl)
- `apps/pi-extension/` — Pi/pi-coding-agent extension (full impl, ~1300 LOC `index.ts`)

This makes plannotator a **natural Rosetta Stone** for how each harness exposes plan-mode-style hooks externally.

## The pi-extension implementation — most relevant for bodhi-pi

`apps/pi-extension/index.ts` (1293 LOC) builds plan-mode entirely on the pi-coding-agent extension API. Two phases: `idle | planning | executing`.

### Mechanism
1. **CLI flag**: `pi.registerFlag("plan", { type: "boolean" })` — `pi --plan` starts in planning phase.
2. **Slash + shortcut**: `pi.registerCommand("plannotator", ...)` + `pi.registerShortcut(Key.ctrlAlt("p"), ...)`.
3. **Tool-set swap on phase change**: `pi.setActiveTools(...)` swaps the active tool list when entering/exiting planning. Captures `savedState` (tools, model, thinking) on entry; restores on exit.
4. **Write gate** (the most relevant bit for bodhi-pi):
   ```ts
   pi.on("tool_call", async (event, ctx) => {
     if (phase !== "planning") return;
     if (event.toolName !== "write" && event.toolName !== "edit") return;
     const inputPath = event.input.path as string;
     if (!isPlanWritePathAllowed(inputPath, ctx.cwd)) {
       return { block: true, reason: "Plannotator: during planning, writes are limited to markdown files (.md, .mdx) inside the working directory. Blocked: " + inputPath };
     }
   });
   ```
   This is the **same `ToolCallEventResult.block` primitive bodhi-pi already exposes.** A plan-mode equivalent can ship as a bodhi-pi extension today with zero core changes — provided the extension can also swap active tools.

5. **System-prompt injection** via `before_agent_start`:
   - Planning phase → heavy planner persona prompt with checklist conventions, plan-file recipe, exit flow.
   - Executing phase → "execute the plan" prompt with remaining steps + `[DONE:n]` tracking.

6. **`plannotator_submit_plan` tool** that:
   - Validates plan file path (markdown extension + inside cwd)
   - Reads plan content
   - Opens browser UI for visual review
   - Returns `{ approved: bool, feedback?: string }`
   - On approve → swap phase to executing, restore full tool access

7. **Phase persistence**:
   - `pi.appendEntry("plannotator", { phase, lastSubmittedPath, savedState })` — phase + saved state stored as session custom entry
   - `pi.on("session_start", ...)` rehydrates phase from last entry, rebuilds `checklistItems` by scanning messages after the last `plannotator-execute` marker for `[DONE:n]`

### Mode-related Pi extension APIs (NOT in bodhi-pi)

| Pi API | Bodhi-pi status | Mode-relevance |
|---|---|---|
| `pi.registerFlag(name, def)` | **Absent** — bodhi-pi is wire-based, not CLI-based | Replace with settings-key + wire method (`_bodhi-pi/mode/set`) |
| `pi.setActiveTools(names)` / `pi.getActiveTools()` | **Absent** — tool list fixed at session bootstrap | **GAP**. Needed if bodhi-pi wants prompt-cost-aware tool-set swap. v1 alternative: rely solely on `tool_call.block`. v2: add this. |
| `pi.registerShortcut(key, handler)` | **Absent** by design (no TUI in bodhi-pi) | Hosts implement key bindings themselves; mode change is a wire-level event |
| `pi.setModel(model)` / `pi.setThinkingLevel(level)` | **Absent** — model is per-session config, not runtime override | Mode-driven model swap (`plan` mode → reasoning model) needs a new API or extension can use `_bodhi-pi/session/settings/set` for `currentModelId` |
| `ctx.ui.notify(msg, severity)` | **Absent** — bodhi-pi has no `ctx.ui.*` | Hosts render notifications themselves from lifecycle events |
| `ctx.ui.setStatus("plannotator", text)` | **Absent** | Hosts render mode badge themselves |
| `ctx.ui.setWidget(name, lines)` | **Absent** | Hosts render checklist themselves |
| `pi.sendUserMessage(content)` | Exists as `pi.sendMessage(sessionId, content)` (ExtensionAPI) | OK |
| `pi.appendEntry(sessionId, entry)` | Same name | OK |
| `pi.on("tool_call")` → `{ block, reason }` | Same shape (`ToolCallEventResult`) | OK |
| `pi.on("before_agent_start")` → `{ systemPrompt, userPrompt }` | Same shape | OK |
| `pi.on("agent_end")`, `pi.on("turn_end")` | Same names | OK |
| `pi.on("session_start")` | Same name | OK |

### What this tells us about bodhi-pi's plan-mode roadmap

- **80% of plannotator's plan-mode logic can run as a bodhi-pi extension TODAY** using `ToolCallEventResult.block` + `before_agent_start` + `appendEntry`/`sendMessage`.
- **Missing piece for tool-cost-aware plan mode**: `setActiveTools` / `getActiveTools`. Without it, the LLM still sees write/edit tool schemas in plan mode; the block-on-call just rejects them after the model has spent tokens generating the call. The remedy is either:
  - Add `ExtensionAPI.setActiveTools(names)` to bodhi-pi core, OR
  - Make `tool_call.block` cause the active tool registry to filter at the next turn (auto-disable a denied tool for the rest of the turn). Less standard.
- **The host-rendered status surface** is the right architecture for bodhi-pi: emit `mode_change` lifecycle event, host UI subscribes and renders badge/notification.

## opencode-plugin integration (lighter reference)

`apps/opencode-plugin/plan-mode.ts`:

```ts
export function normalizeEditPermission(
  edit: string | Record<string, string> | undefined,
): Record<string, string> {
  if (typeof edit === "string") return { "*": edit };
  return edit ?? {};
}
```

The plugin tweaks opencode's `permission.edit` policy when entering plan mode. Confirms opencode's `Permission` schema is the integration surface — there's no separate "mode hook"; plan-mode is just a permission override.

Also strips conflicting system-prompt lines (`stripConflictingPlanModeRules`) — defensive against opencode's built-in plan-mode prompt fighting plannotator's.

## codex + gemini integrations

`apps/codex/README.md` only — codex integration is through Codex's `~/.codex/config.toml` `[hooks]` table and slash commands rather than a plugin API.

`apps/gemini/commands/` + `apps/gemini/hooks/` — gemini-cli integration via:
- `~/.gemini/commands/<name>.toml` for slash commands
- Hooks injected via TOML config

These are external-config integrations, not extension-API integrations. Both Codex and gemini-cli prefer config-file integration over plugin API.

## Cross-harness takeaway

Plan-mode integration approaches across harnesses (in order from most integrated to most external):

1. **pi-extension** — full extension API; event subscriptions, tool registration, tool-set swap, system-prompt injection, custom session entries. Highest fidelity.
2. **opencode-plugin** — plugin API + permission ruleset override. Mid-fidelity; relies on opencode's existing permission system.
3. **gemini-cli** — slash commands + TOML hooks. Lower fidelity; mostly orchestration glue.
4. **codex** — config-file hooks + slash commands. Lowest fidelity.

For bodhi-pi, the takeaway: an **extension-API-first integration story** (path 1) is the most powerful for third parties like plannotator. Bodhi-pi already provides most of the needed primitives — closing the `setActiveTools` gap unlocks the full plannotator pattern.
