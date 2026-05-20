# Milestone 040 — `edit` mode preset

> Prerequisites: 010, 020, 030 merged. Engine is in place from 030; this milestone adds one preset.

## Goal

Add the `edit` mode preset to `MODE_PRESETS`:

```ts
EDIT_PRESET: ModePreset = {
  mode: "edit",
  description: "Auto-allow file edits in workspace; prompt for shell/MCP/subagent",
  policy: {
    categories: { read: "allow", search: "allow", edit: "allow", execute: "ask", mcp: "ask", subagent: "ask", other: "ask" },
    tools: {},
    alwaysAllow: [],
    alwaysDeny: [],
  },
};
```

That's it. The 030 engine already does the right thing for any preset — adding to the map is enough.

## Out-of-workspace narrowing (Continue-style)

Add one small refinement: `evaluateToolCall` checks if the edit target path is inside `session.cwd`. If not, narrow `allow` → `ask` regardless of mode. This is a single helper:

```ts
function narrowOutOfWorkspaceEditToAsk(decision: PermissionDecision, toolName, args, cwd): PermissionDecision {
  if (decision !== "allow") return decision;
  if (!isEditTool(toolName)) return decision;
  const path = extractPath(toolName, args);
  if (path && isWithinWorkspace(path, cwd)) return decision;
  return "ask";
}
```

Adopt from Continue's `core/tools/policies/fileAccess.ts:evaluateFileAccessPolicy`. Applies to `edit`/`write` only (not `read`, since read is read-only and a path-traversal read isn't dangerous enough to ask). Adopt the existing path resolution from `src/tools/index.ts::resolvePath`.

## Scope

### IN

| Change | File |
|---|---|
| Add `EDIT_PRESET` to `MODE_PRESETS` | `src/permissions/presets.ts` |
| Out-of-workspace edit narrowing | `src/permissions/permission-service.ts` |
| Update `ai-docs/specs/bodhi-pi/modes.md` row 040 = ☑ + edit-preset section + workspace-narrowing rule | Edit |

### OUT

- `respectsEditMode` per-tool annotation system from the report — defer. The category-based preset is sufficient for v1; per-tool finer control via `tools[name]` override is already supported.
- `plan` / `allow-all` presets

## Tests

### `packages/bodhi-pi/test/permission-edit-mode.test.ts` (new)

```ts
describe("edit mode", () => {
  it("auto-allows edit/write inside cwd; no requestPermission call", async () => { ... });
  it("auto-allows read/search/ls", async () => { ... });
  it("asks for bash (execute category)", async () => { ... });
  it("asks for an edit target OUTSIDE cwd (out-of-workspace narrowing)", async () => {
    // cwd = /workspace; tool tries to edit /etc/foo
    // expect requestPermission call
  });
  it("asks for MCP tool", async () => { ... });
});
```

### 4-runtime parity

CLI / browser / chrome-ext / HTTP playwright + integration tests:

```ts
test("user sets /mode edit; edit auto-runs; bash asks", async ({ page }) => { ... });
test("edit mode out-of-workspace path prompts approval", async ({ page }) => { ... });
```

(Smaller test surface than 030 since the UI plumbing is the same.)

## Per-runtime impact

| Host | Change |
|---|---|
| All four | Mode dropdown / `/mode` slash now offers `edit` (already does from 020); behaviour gates differently. No new UI. |

## Commit message

```
bodhi-pi modes 040: edit mode preset + out-of-workspace edit narrowing

Add EDIT_PRESET to MODE_PRESETS: read/search/edit auto-allowed in workspace;
execute/mcp/subagent ask. Out-of-workspace edit/write paths narrow to ask
regardless of mode (Continue-style). Single-preset addition; the 030 engine
already does the right thing.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

## Interactions

- **Plan mode** comes in 050 with a tighter version (deny edit entirely).
- **Sub-agents**: edit-mode parent that spawns an `explore` profile child (which gets `mode: plan` in 070) — Qwen rule means child still gets plan-mode (more restrictive child OK; permissive child would be downgraded).

## Definition of done

- [ ] EDIT_PRESET in `presets.ts`
- [ ] Out-of-workspace narrowing in `permission-service.ts`
- [ ] New integration tests pass
- [ ] 4-runtime parity tests pass
- [ ] `modes.md` row 040 = ☑
- [ ] Single commit
