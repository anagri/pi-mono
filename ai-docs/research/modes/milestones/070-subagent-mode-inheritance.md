# Milestone 070 — Sub-agent mode inheritance (Qwen rule)

> Prerequisites: 010–060 merged.

## Goal

Three additions:

1. Add `mode?: AgentMode` field to `SubagentProfile` (frontmatter + extension-registered)
2. Implement `resolveChildMode(parent, profile, capabilities)` per the Qwen Code rule (locked in [000-overview.md](000-overview.md) §10) and call it in `SubagentService.spawn` to set the child's runtime mode
3. Update built-in `explore` and `planner` profiles to declare `mode: "plan"`
4. Bubble child approval requests to the parent's session UI (single `conn` shared, so this works trivially — but verify the UI labels the child clearly: "explore (sub-agent) wants to run `bash:rm node_modules`")

## `resolveChildMode`

```ts
// src/permissions/subagent-mode-resolver.ts (new)
import type { AgentMode, ModeRuntimeCapabilities } from "./types.js";
import type { SubagentProfile } from "@/subagents/types.js";

export function resolveChildMode(
  parent: AgentMode,
  profile: SubagentProfile,
  capabilities: ModeRuntimeCapabilities,
): AgentMode {
  if (parent === "allow-all" || parent === "edit") return parent;
  if (profile.mode) {
    if (profile.mode === "allow-all" && !capabilities.allowsAllowAllMode) return parent;
    return profile.mode;
  }
  if (parent === "plan") return "plan";
  return parent;
}
```

Plus tests verifying every cell of the parent × profile matrix:

| Parent ↓ \ Profile → | unset | `plan` | `ask` | `edit` | `allow-all` (no cap) | `allow-all` (cap) |
|---|---|---|---|---|---|---|
| `plan` | plan | plan | plan | plan | plan | plan |
| `ask` | ask | plan | ask | edit | ask | allow-all |
| `edit` | edit | edit | edit | edit | edit | edit |
| `allow-all` | allow-all | allow-all | allow-all | allow-all | allow-all | allow-all |

(Permissive parent wins: edit/allow-all parents cannot be downgraded by a profile. plan parent sticks downward. allow-all requires capability.)

## `SubagentProfile.mode` field

Extend the discovery markdown frontmatter and extension-registered shape:

```yaml
# .bodhi-pi/agents/scout.md
---
name: scout
description: read-only investigator
mode: plan
tools: [read, ls, find, grep]
---
You are a scout. Investigate without modifying...
```

Validation lives in `src/subagents/_validate.ts` (existing). Add a check: `mode` must be one of `ALL_AGENT_MODES`. Reject unknown values with the same error pattern other frontmatter validators use.

## Built-in profile updates

`src/subagents/profiles/explore.ts` and `src/subagents/profiles/planner.ts` — add `mode: "plan"` to their definitions. The PARITY.md / subagents spec already labels them as read-only; this milestone formalises the enforcement (until now they relied on the `tools` allowlist; now they get the additional mode-level guard).

## Approval bubbling

When a child sub-agent's tool call asks for approval, the agent calls `conn.requestPermission` with the SAME `conn` as the parent (the agent has one ACP connection per agent instance). The request's `sessionId` is the child's. Update the `requestPermission` UI in each host to:

- Identify the request as a sub-agent's by checking if `sessionId` is a child of the active session (parent UI receives the request because parent has the same conn; child sessions are owned by the parent UI)
- Add a label "(sub-agent: <profileName>)" to the modal title / CLI prompt

CLI: `"Allow [explore sub-agent] bash:ls? [y/n/A/N]"`
Browser modal: title "explore (sub-agent) requests: bash"

## Scope

### IN

| Change | File |
|---|---|
| `mode?: AgentMode` on `SubagentProfile` and `ExtensionSubagentProfileDef` | `src/subagents/types.ts`, `src/extensions/types.ts` |
| Frontmatter parse + validation for `mode` | `src/subagents/_validate.ts`, `src/subagents/discovery.ts` |
| `resolveChildMode` function | `src/permissions/subagent-mode-resolver.ts` (new) |
| `SubagentService.spawn` calls `resolveChildMode` and writes a `mode_change` entry on the child session if resolved mode differs from default | `src/subagents/subagent-service.ts` |
| Built-in `explore` + `planner` get `mode: "plan"` | `src/subagents/profiles/{explore,planner}.ts` |
| Host UI labels approval as sub-agent's | Each `test-apps/<host>/src/client/...` |
| Update `modes.md` row 070 = ☑ + Qwen-rule matrix + sub-agent section | Edit |
| Update `subagents.md` — add the `mode` frontmatter field + inheritance rule | Edit |

### OUT

- Removing the existing `tools` allowlist enforcement on built-in profiles (keep both — defence in depth)
- Allow-all sub-agents auto-promoting parent's mode (no; promote-up is unsafe)

## Tests

### `packages/bodhi-pi/test/permission-subagent-inheritance.test.ts` (new)

For each cell of the matrix above, spawn a parent session with the given parent mode, spawn a child with the given profile, assert the child's `session.runtime.mode`. ~10-15 cases.

### Approval-bubble tests

```ts
it("sub-agent edit triggers approval on the parent's conn", async () => {
  // parent in ask mode; spawn 'scout' (mode: ask in this hypothetical) child;
  // child queues an edit tool call; expect requestPermission call with toolCall.toolCallId from child
  // verify the harness's approval callback received an entry labelled as sub-agent
});

it("explore profile is plan mode regardless of parent ask/edit/allow-all", async () => {
  // for each parent mode, spawn explore; verify child mode is "plan"
  // verify a write tool inside explore is denied
});

it("registered extension sub-agent with mode: allow-all is demoted to parent when capability is false", async () => {
  // register ext sub-agent with mode: allow-all; allowsAllowAllMode false
  // spawn child; verify child mode === parent's mode (not allow-all)
});
```

### 4-runtime parity

Each Host runs at least one test where:
- Set `/mode ask`
- LLM (faux or real) calls `subagent` with `explore` profile
- Child does some reads (auto-allowed in plan), then tries an edit (denied with clear "in plan mode")
- Test verifies approval UI was NOT triggered (read auto) and edit was rejected at policy time

## Per-runtime impact

| Host | Change |
|---|---|
| All four | Approval-request UI rendering must label sub-agent source. Tiny change (one line in the modal title / CLI prompt). |

## Commit message

```
bodhi-pi modes 070: sub-agent mode inheritance (Qwen rule) + plan-mode built-ins

Add SubagentProfile.mode? + extension equivalent. Implement resolveChildMode
per Qwen Code's rule: permissive parent wins; plan parent sticks downward;
profile mode applies otherwise; allow-all requires capability or demote.
SubagentService.spawn calls resolveChildMode and writes a mode_change entry
on the child if the resolved mode differs from default. Built-in explore +
planner profiles declare mode: plan — now formally guarded by policy on
top of the existing tools allowlist. Approval requests from sub-agent
children are labelled in the host UI ("explore (sub-agent) requests …").

Tests cover the full parent × profile × capability matrix and assert
explore/planner are plan regardless of parent.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

## Interactions

- **Sub-agent batch (`subagent_batch`)**: Each child in a batch gets `resolveChildMode` applied independently. Verify in tests.
- **Forked sub-agents (`context: "fork"`)**: forked profiles still get the resolver applied; mode is independent of context shape.
- **Plan-mode parent spawning a sub-agent**: with `subagent` category being `deny` in plan preset, the SPAWN itself is blocked. This is by design — you don't get to delegate writes while you're in plan mode. Confirm in a test.
- **Recursion**: subagent depth is already capped at `SUBAGENT_MAX_DEPTH = 2`. Mode resolution at depth 2 still works (grandparent's mode floors the chain).

## Risks

- **Risk**: Built-in profile mode change may break existing tests that spawned `explore` or `planner` and tried an edit. **Mitigation**: those profiles already denied edits via `tools` allowlist; the additional mode-level guard is a stricter version of the same guarantee. Existing tests should still pass.
- **Risk**: Host UI for sub-agent labelling forgotten in one Host. **Mitigation**: Playwright tests assert the label.

## Definition of done

- [ ] `SubagentProfile.mode` field + frontmatter validation
- [ ] `resolveChildMode` function + matrix tests
- [ ] Built-in `explore` and `planner` profiles updated
- [ ] Approval UI labels sub-agent source
- [ ] All tests pass (incl. 4-runtime)
- [ ] `modes.md` + `subagents.md` updated
- [ ] Single commit
