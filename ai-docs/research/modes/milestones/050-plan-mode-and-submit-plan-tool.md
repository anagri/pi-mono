# Milestone 050 — `plan` mode + `submit_plan` tool

> Prerequisites: 010, 020, 030, 040 merged.

## Goal

Three additions:

1. Add `PLAN_PRESET` to `MODE_PRESETS`: read+search allowed; edit/execute/mcp/subagent denied
2. Add `systemPromptSuffix` to plan preset (planner persona; instructs the LLM to plan first and call `submit_plan`)
3. Add built-in `submit_plan` tool — registered ONLY when `session.runtime.mode === "plan"`. On approval, auto-transitions to `edit` mode and re-registers tools.

## `PLAN_PRESET`

```ts
PLAN_PRESET: ModePreset = {
  mode: "plan",
  description: "Analyze and design without modifying state",
  policy: {
    categories: {
      read: "allow",
      search: "allow",
      edit: "deny",
      execute: "deny",
      mcp: "deny",
      subagent: "deny",
      other: "deny",
    },
    tools: {},
    alwaysAllow: [],
    alwaysDeny: [],
  },
  systemPromptSuffix: `

## Plan mode

You are in PLAN mode. You can only read the workspace and search — you cannot edit, execute, run commands, call MCP tools, or spawn sub-agents.

Use this turn to investigate the codebase, ask the user clarifying questions, and produce a numbered implementation plan. When the plan is ready, call \`submit_plan\` with a markdown body. The user will review and either approve (auto-switch to edit mode for execution) or send feedback for revision.

Do NOT attempt to call edit/write/bash/run_script — they are blocked in this mode and will return a deny error. If you find yourself needing to modify the workspace, finish the plan and call \`submit_plan\` first.
`,
};
```

## `submit_plan` tool

Lives at `src/tools/submit-plan.ts`. Registered by `createBuiltinTools` ONLY when `session.runtime.mode === "plan"`. Tool definition:

```ts
{
  name: "submit_plan",
  description: "Submit a finished plan for the user to review. The user approves (you proceed in edit mode), denies (revise the plan), or supplies feedback (incorporate and resubmit). MUST be called only after exploring the workspace and producing a numbered markdown plan.",
  parameters: Type.Object({
    title: Type.Optional(Type.String({ description: "Short title (≤80 chars)." })),
    plan: Type.String({ description: "Plan body in markdown. Use numbered headings and checkboxes." }),
  }),
  execute: async (toolCallId, params, signal, onUpdate, ctx) => {
    // ctx provides sessionId; access to PermissionService via dep injection
    const result = await permissionService.requestPlanApproval(ctx.sessionId, params.title, params.plan);
    if (result.outcome === "approved") {
      await permissionService.setMode(ctx.sessionId, "edit", "submit_plan_approved");
      return { content: [{ type: "text", text: "Plan approved. Mode switched to edit. Proceed with implementation per the plan." + (result.feedback ? `\n\nUser notes: ${result.feedback}` : "") }] };
    }
    if (result.outcome === "denied") {
      return { content: [{ type: "text", text: `Plan denied. Revise per user feedback and call submit_plan again.\n\nFeedback: ${result.feedback ?? "(none provided)"}` }], isError: false };
    }
    if (result.outcome === "feedback") {
      return { content: [{ type: "text", text: `User wants revisions. Address feedback and call submit_plan again.\n\nFeedback: ${result.feedback}` }] };
    }
    return { content: [{ type: "text", text: "Plan submission cancelled." }], isError: true };
  },
};
```

### Plan approval round-trip — reuse the requestPermission shape

Reuse `conn.requestPermission` with custom `PermissionOption` entries:

```ts
options: [
  { optionId: "approve",   name: "Approve plan",   kind: "allow_once" },
  { optionId: "feedback",  name: "Approve with notes", kind: "allow_always" /* used to mean "add notes" */ },
  { optionId: "deny",      name: "Revise plan",    kind: "reject_once" },
],
toolCall: { toolCallId, status: "pending", title: params.title ?? "Implementation plan" /* ... */, content: [{ type: "text", text: params.plan }] }
```

Hosts already implement `requestPermission` UI from 030. For plan approval the modal renders the plan markdown + 3 buttons. Approve / Approve with notes / Revise. The "Approve with notes" path prompts for free-text feedback in the same modal.

> **Alternative**: introduce a new ACP request method for plan approval. Reject this — staying with `requestPermission` keeps the wire surface tight and the hosts have nothing new to wire.

### Mode-aware tool registration

When `session.runtime.mode === "plan"`, `createBuiltinTools(...)` includes `submit_plan` and excludes nothing (the policy engine handles denials). When mode is NOT plan, `submit_plan` is NOT in the tool list (LLM doesn't see it).

This requires `buildSessionState` and `setMode` to **rebuild the tool list** when mode changes. The full active-tools-swap on mode change is a 080 concern (it covers ALL modes' tool list rebuild); for 050, we just need to handle `submit_plan` specifically — register/unregister when mode toggles in/out of `plan`. Implementer choice: either (a) hand-roll the toggle in 050 with a small hack in `PermissionService.setMode`, or (b) preview 080's `setActiveTools` API just enough to make this work. Recommendation: (a) for 050 — keep scope tight; 080 generalises.

## Scope

### IN

| Change | File |
|---|---|
| `PLAN_PRESET` in `MODE_PRESETS` | `src/permissions/presets.ts` |
| Plan systemPromptSuffix appended in `composeSystemPrompt` based on mode | `src/sessions/session-bootstrap.ts` |
| `submit_plan` built-in tool | `src/tools/submit-plan.ts` (new) |
| Conditional registration of `submit_plan` in `createBuiltinTools` based on mode | `src/tools/index.ts` |
| `PermissionService.requestPlanApproval` (wraps `conn.requestPermission` with plan-specific options) | `src/permissions/permission-service.ts` |
| `setMode` re-registers tool list when toggling in/out of plan | `src/permissions/permission-service.ts` |
| `submit_plan_approved` reason added to `mode_change` event | `src/events/types.ts` (the enum was added in 010 already) |
| Update `modes.md` row 050 = ☑ + plan-mode section + submit_plan sequence diagram | Edit |
| Update `acp.md` to note plan-approval uses requestPermission with custom options | Edit |
| Update `extensions-skills-commands.md`: `submit_plan` is a built-in tool only in plan mode | Edit |
| Update `lifecycle.md`: no new SessionEntry types (submit_plan is just a tool call) | Verify; possibly no change |

### OUT

- Persisting the plan to disk (Mastracode-style `plans/<resourceId>/<timestamp>-<slug>.md`). Defer — plan stays in the message log only. A follow-up plan extension can persist if needed.
- Plannotator-style external review UI. Out of scope; hosts ship their own approve/revise UI via the requestPermission modal.
- `getNextPermissionMode`-style cycling through modes from the LLM side. Modes are user-initiated.

## Tests

### `packages/bodhi-pi/test/permission-plan-mode.test.ts` (new)

```ts
describe("plan mode", () => {
  it("denies edit/write/bash with a clear redirect message", async () => {
    // setSessionMode plan; queue a faux tool call that calls write
    // expect tool_call_update with status:"failed" + reason mentions "plan mode"
  });

  it("allows read/search", async () => { ... });

  it("LLM sees the planner system prompt suffix (composed at session boot)", async () => {
    // setSessionMode plan; assert system prompt includes "Plan mode" section
  });

  it("submit_plan tool is registered only when mode is plan", async () => {
    // get tool list at default mode (ask) — submit_plan NOT present
    // setSessionMode plan; get tool list — submit_plan PRESENT
    // setSessionMode edit; submit_plan absent again
  });

  it("submit_plan invokes requestPermission with 3 plan-specific options", async () => { ... });

  it("approving the plan transitions session to edit mode", async () => {
    // setSessionMode plan; LLM calls submit_plan; client approves
    // assert session.runtime.mode === "edit"
    // assert a mode_change SessionEntry with reason: "submit_plan_approved"
  });

  it("denying the plan keeps session in plan mode; tool result carries feedback", async () => { ... });
  it("approve-with-notes carries feedback into the next assistant turn", async () => { ... });
});
```

### e2e: `packages/bodhi-pi/e2e/plan-mode.e2e.ts`

Real `gpt-4o-mini` in plan mode is given a simple task ("plan adding a hello function"). Assert that the LLM calls `submit_plan`. Approve programmatically. Assert mode transitions to `edit`.

### 4-runtime tests

CLI: `/mode plan`, prompt, LLM responds with submit_plan call, CLI surfaces the plan + approve prompt, user approves → mode badge shows `edit`.

Playwright (browser + chrome-ext): mode dropdown → plan; chat asks; modal renders the plan markdown with approve/revise buttons.

HTTP integration: per-turn rebuild after a plan approval — the next request finds mode=edit.

## Per-runtime impact

| Host | Change |
|---|---|
| All four | Plan-approval modal/prompt is a special variant of the existing requestPermission UI. Render plan markdown in the modal body (not just the tool name). |

## Commit message

```
bodhi-pi modes 050: plan mode + submit_plan built-in tool + planner system prompt

Add PLAN_PRESET (read+search allow; edit/execute/mcp/subagent deny) with a
systemPromptSuffix that teaches the LLM the plan-mode workflow. Add
submit_plan built-in tool registered only when session.runtime.mode is plan;
PermissionService toggles tool registration on mode change. submit_plan calls
conn.requestPermission with 3 plan-specific options (approve / approve with
notes / revise). Approval auto-transitions session to edit mode with a
mode_change SessionEntry reason: "submit_plan_approved".

Tests verify deny behaviour, prompt-suffix presence, tool registration
toggle, all three approval outcomes, and the auto mode transition across
the four reference Hosts.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

## Interactions

- **Sub-agents**: `planner` built-in profile (already exists) — milestone 070 gives it `mode: "plan"`. Today it just runs in whatever the parent's mode is; in 070 a planner-profile child always runs in plan mode regardless of parent. The `submit_plan` tool inside a planner child auto-transitions the CHILD's mode but the child's session ends shortly anyway — verify behaviour.
- **Compaction**: compaction calls bypass policy (per 030 decision). Plan-mode compaction still works.
- **Skills with `allowed-tools`**: skills loaded in plan mode that include tools like `write` — calling those tools while in plan mode triggers deny. Document.

## Risks

- **Risk**: LLMs may ignore the planner prompt and try to call write anyway. **Mitigation**: defence-in-depth — policy denies them at call time with a clear redirect ("you're in plan mode; finish the plan and call submit_plan"). Tested. 080's setActiveTools makes this less likely (LLM doesn't see write tools at all in plan mode).
- **Risk**: `submit_plan` registration toggle might race with an in-flight prompt. **Mitigation**: registration happens at `setMode` synchronously; if a prompt is in flight, the tool change applies to the next turn (which is the right semantic).

## Definition of done

- [ ] PLAN_PRESET in `presets.ts`
- [ ] `submit_plan` tool in `src/tools/submit-plan.ts`
- [ ] Conditional registration in `createBuiltinTools`
- [ ] systemPromptSuffix wired in `composeSystemPrompt`
- [ ] All tests pass (incl. 4-runtime)
- [ ] `modes.md` row 050 = ☑
- [ ] Single commit
