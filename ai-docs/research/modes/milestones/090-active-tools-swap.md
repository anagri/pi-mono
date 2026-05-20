# Milestone 080 — Active-tools swap on mode change

> Prerequisites: 010–070 merged.

## Goal

Hide denied tools from the LLM. Two pieces:

1. New `ExtensionAPI.setActiveTools(sessionId, toolNames): Promise<string[]>` + `getActiveTools(sessionId): string[]` methods
2. `PermissionService.setMode` (and `buildSessionState`'s initial mode resolution) calls the equivalent internal rebuild whenever mode changes: tools whose category is `deny` for the new mode are removed from `piAgent.state.tools`

After this milestone:

- `plan` mode: LLM only sees `read`, `ls`, `find`, `grep`, `submit_plan` (not `write`/`edit`/`bash`/`run_script`/`subagent`/MCP tools)
- `ask`/`edit`: LLM sees all tools (no change from before)
- `allow-all`: LLM sees all tools

This addresses the "LLM cost + confusion" cost of the v1 approach where denied tools were still in the schema but rejected at call time. After 080, the LLM never tries to call denied tools (because they're not in its tool list).

## Why this lands AFTER the policy engine

The 030–070 engine works without 080 — denied tools still get rejected at call time, just less efficiently. Landing the policy engine first proves correctness; 080 is an optimisation.

Plannotator's pi-extension does exactly this (`pi.setActiveTools(...)`) — the API design follows the report's [11-plannotator notes](../notes/11-plannotator.md) recommendation.

## Implementation

### New `ExtensionAPI` methods

```ts
// src/extensions/types.ts (extend the interface)
export interface ExtensionAPI {
  // ... existing methods ...
  /**
   * Replace the LLM-visible tool list for this session. Returns the previous list
   * so extensions can restore on phase exit. Mode changes implicitly call this
   * with the new mode's allowed-tools.
   */
  setActiveTools(sessionId: string, toolNames: string[]): Promise<string[]>;
  getActiveTools(sessionId: string): string[];
}
```

Implementation in `src/extensions/runner.ts` (`ExtensionRunner` exposes this on its `pi` adapter):

```ts
async setActiveTools(sessionId, toolNames) {
  const session = this.sessions.get(sessionId);
  if (!session) throw new Error(`unknown session: ${sessionId}`);
  const previous = session.tools.map(t => t.name);
  const newTools = filterTools(session.tools, toolNames); // keep tools whose names are in toolNames
  session.tools = newTools;
  session.runtime.piAgent.state.tools = newTools;
  return previous;
}

getActiveTools(sessionId) {
  return this.sessions.get(sessionId)?.tools.map(t => t.name) ?? [];
}
```

Note: `session.tools` is the union of builtins + extension-registered + MCP-namespaced tools. `setActiveTools` filters this list; MCP tools added later via `_bodhi-pi/mcp/connect` join the active list normally (re-evaluated against the current mode's policy).

### Mode change → tool list rebuild

In `PermissionService.setMode`:

```ts
async setMode(sessionId, newMode, reason) {
  const session = this.sessions.get(sessionId);
  // ... existing mode-change handling ...
  const allowedNames = computeAllowedTools(session, newMode);
  await this.setActiveToolsInternal(sessionId, allowedNames);
}

private computeAllowedTools(session, mode): string[] {
  const preset = MODE_PRESETS[mode];
  return session.tools
    .filter(t => {
      const cat = toolKindFor(t.name);
      const decision = preset.policy.tools[t.name] ?? preset.policy.categories[cat] ?? "ask";
      return decision !== "deny";
    })
    .map(t => t.name);
}
```

`setActiveToolsInternal` is the private version of `setActiveTools` used by mode change (no external extension call needed).

### MCP tool handling

When `_bodhi-pi/mcp/connect` adds new MCP tools, the new tools must be filtered through the same compute. The `McpRegistry`'s tool-fanout point (currently `mergeTools(session.tools, registry.getVisibleTools(sessionId))`) calls into a hook that applies the active mode's filter. Document.

### Tool re-registration when a session toggles in/out of plan mode

Already handled in 050 (`submit_plan` toggle); 080 generalises. The 050 hand-rolled toggle should be removed and replaced with the general 080 mechanism in the same commit.

## Scope

### IN

| Change | File |
|---|---|
| `ExtensionAPI.setActiveTools` + `getActiveTools` | `src/extensions/types.ts`, `src/extensions/runner.ts` |
| `PermissionService.setMode` rebuilds active tools | `src/permissions/permission-service.ts` |
| Initial active-tool list in `buildSessionState` reflects starting mode | `src/sessions/session-bootstrap.ts` |
| MCP connect hook re-applies mode filter | `src/mcp/mcp-registry.ts` (or wherever the fanout lives) |
| Replace 050's hand-rolled `submit_plan` toggle with general mechanism | `src/permissions/permission-service.ts`, `src/tools/index.ts` |
| Update `modes.md` row 080 = ☑ + tool-swap section | Edit |
| Update `extensions-skills-commands.md` — add `setActiveTools`/`getActiveTools` to the ExtensionAPI table | Edit |

### OUT

- Extensions calling `setActiveTools` themselves to implement their own phases (like plannotator). The API is exposed; extensions can use it. Don't ship any first-party extension that uses it in this milestone.
- Per-tool-deny tool removal (already handled — denied tools are filtered).

## Tests

### `packages/bodhi-pi/test/permission-active-tools.test.ts` (new)

```ts
describe("active-tools swap on mode change", () => {
  it("plan mode removes edit/write/bash/run_script/subagent from active tools", async () => { ... });
  it("plan mode includes submit_plan in active tools", async () => { ... });
  it("ask/edit/allow-all keep all tools active", async () => { ... });
  it("setSessionMode triggers tool list update (piAgent.state.tools reflects)", async () => { ... });
  it("extension setActiveTools replaces the active list (caller-provided allowlist)", async () => { ... });
  it("getActiveTools returns current names", async () => { ... });
  it("MCP connect after plan mode adds the MCP tool only if mcp category is not deny", async () => { ... });
});
```

### 4-runtime parity

Test that in plan mode, the LLM-visible tool list (returned via `_bodhi-pi/session/config` or similar) shows only the plan-allowed tools. Faux provider can be used to verify the LLM payload doesn't include denied tools (use `before_provider_request` event recording).

Playwright: in plan mode, the tool dropdown / palette in the UI (if any) shows only allowed tools.

## Per-runtime impact

| Host | Change |
|---|---|
| All four | Tool list shown in UI (if any) reflects mode. No new wire; existing config endpoints already return active tools. |

## Commit message

```
bodhi-pi modes 080: hide denied tools from the LLM on mode change

Add ExtensionAPI.setActiveTools(sessionId, toolNames) + getActiveTools.
PermissionService.setMode rebuilds session.tools + piAgent.state.tools to
exclude tools whose category resolves to deny under the new mode preset.
Plan mode now hides write/edit/bash/run_script/subagent/MCP from the LLM
schema entirely; ask/edit/allow-all keep all tools visible. The 050 hand-
rolled submit_plan toggle is removed and replaced with this general
mechanism. MCP connect hook re-applies the active filter so new MCP tools
respect mode.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

## Interactions

- **Sub-agents**: child session's `piAgent.state.tools` is built from the child's profile + child's resolved mode. `SubagentService.spawn` already builds the child tool list; 080's tool computation applies.
- **Extensions**: extension-registered tools go through the same filter. If an extension's tool name isn't classified by `toolKindFor`, it falls in the `"other"` category — mode preset must define a default for `"other"`. Already in milestone 010's types (defaulted to `ask` in non-allow-all modes).
- **Skills with `allowed-tools`**: skills constrain the LLM to a subset of tools regardless of mode. The interaction is multiplicative — final visible tool set = mode_filter(skill_allowed_tools ∩ session.tools). Document in `extensions-skills-commands.md`.

## Risks

- **Risk**: `piAgent.state.tools` reassignment may interact poorly with pi-agent-core's internal caching. **Mitigation**: verify pi-agent-core re-reads `state.tools` each prompt round; if not, file an upstream bug or work around via a re-create.
- **Risk**: An LLM mid-prompt may have already committed to call a tool that just got hidden by a mode change. **Mitigation**: tool calls in flight still go through the policy gate; even if hidden, a call attempt is denied at call time (defence in depth from 030 still works).

## Definition of done

- [ ] `setActiveTools` + `getActiveTools` on `ExtensionAPI`
- [ ] `PermissionService.setMode` rebuilds tools
- [ ] Plan mode hides denied tools from LLM
- [ ] All tests pass (incl. 4-runtime + faux provider payload assertion)
- [ ] 050's hand-rolled toggle removed
- [ ] Specs updated
- [ ] Single commit
