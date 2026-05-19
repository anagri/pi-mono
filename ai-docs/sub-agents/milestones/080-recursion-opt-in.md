# Milestone 080 — Recursion opt-in

> **Status:** ☐ pending. Tracked in `../pending.md` as the "Recursion opt-in" open knob. Not yet started.
> **Prerequisite reading:** [`005-architecture-decisions.md`](005-architecture-decisions.md) (Decision 5 — recursion).
> **Historical note:** this milestone originally also covered "tool consolidation" (fold `subagent_batch` into `subagent`). That half was shipped differently — Phase 2 (2026-05-19) deleted the entire batch surface rather than merging it. Decision 3 is Superseded. The recursion half (below) is the only remaining open knob.

## Goal

Re-open the locked Decision 5 (hard depth-cap-2) if and when product evidence justifies it: let designated profiles spawn their own children, governed by a bounded but configurable cap. Closes the gap with Mastra.

**This milestone is a re-decision exercise, not a pure-implementation one.** The change requires a new decision-doc that explicitly retires Decision 5 and replaces it with the new rule. The implementing agent's first deliverable is the updated decision-doc, not code.

## Functional scope

### IN

- **A per-profile `canSpawnChildren?: boolean` flag** (or richer policy — e.g. `maxChildDepth: number`).
- **A new bounded cap** (e.g. `SUBAGENT_MAX_DEPTH = 3` or `4`), still hard, still finite.
- **The child-tool-list-exclusion rule changes** — children with `canSpawnChildren: true` get the `subagent` tool; others still don't.
- **Discovery + validation** for the new field.
- **Updated lifecycle events** record the spawning chain (already partially supported via `subagentDepth`).
- **An updated decision-doc** that retires Decision 5 and lays out the new rule.

### OUT

- **Shipped without prior evidence.** The implementing agent's first job is to assess whether real-world usage shows the current depth-cap is causing capability gaps. If not, this milestone may stay pending indefinitely — Decision 5 is correct until it isn't.
- **Unbounded recursion** — even with opt-in, the cap stays finite (4 max recommended).
- **Per-call recursion override on the `subagent` tool** — the recursion permission is profile-bound (Decision 2 still holds).

## Critical interfaces (recommendation-level)

The minimal viable shape is one optional profile field:
```
canSpawnChildren?: boolean  // default false
```
Richer alternative:
```
recursion?: { maxDepth?: number }  // default { maxDepth: 1 } meaning "this profile cannot spawn"
```

Recommendation: start with the boolean — it's the simplest expression of the opt-in. Add depth-per-profile later if needed.

## Behaviour rules (invariants this milestone must preserve)

1. **Recursion still has a finite cap.** No "infinite descent" mode.
2. **All other locked decisions still apply** — in particular, Decision 2 (profile is source of truth) means recursion permission can't be a per-call flag.
3. **MCP-empty stance for children** still applies unless milestone 070 has shipped — these milestones are independent.

## Where this sits in the research spectrum

The current bodhi-pi position (no recursion) is **conservative** relative to the surveyed harnesses. The change would move bodhi-pi toward the "permissive defaults with safety knobs" position that Mastra and cc occupy.

The cost is more configuration surface and more rope for profile authors / LLMs to misuse. The benefit is expressiveness — chains like "planner → research-coordinator → specialist-explorer" become possible.

Whether the move is justified depends on **observed product evidence**:
- Are users authoring profiles that would benefit from recursion?
- Are the bundled built-ins limited by depth-cap-2 in their useful behaviour?

The implementing agent should look at real usage before shipping.

## Tests / coverage (sketch)

- **Unit:** profile with `canSpawnChildren: true` → child's tool list contains `subagent`; child can spawn grandchild; grandchild without the flag cannot spawn.
- **Unit:** cap enforcement — at the new max depth, the deepest child has no sub-agent tools regardless of its own profile.
- **e2e:** real-LLM parent spawns child that spawns grandchild; verify the chain completes and returns the grandchild's result up through the layers.

## Per-runtime impact

| Runtime | Considerations |
|---|---|
| **cli, http, browser, chrome-ext** | The change is internal to the tool schema + service. No per-runtime divergence expected. |

## Follow-ups / open knobs

- **A `subagent_chain` workflow primitive** — letting a parent declare a sequential pipeline (A → B → C). Cleaner than recursion for chain-style use cases. Not in scope here; would be a separate workflow-handoff feature, distinct from sub-agents.
- **Per-profile recursion budget** (max number of grandchildren, not just depth) — if recursion ships, fan-out caps may follow.
- **Re-decision should be a `007-recursion-rethink.md` decision-doc** that explicitly retires Decision 5 in 005 with a "Superseded by" pointer.
