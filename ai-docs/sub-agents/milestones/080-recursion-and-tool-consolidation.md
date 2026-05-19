# Milestone 080 — Recursion opt-in + tool consolidation

> **Status:** ☐ pending. Tracked in `../pending.md` as two open knobs ("Recursion opt-in" + "Consolidate tools"). Bundled here because both revisit locked decisions and should be evaluated together. Not yet started.
> **Prerequisite reading:** [`005-architecture-decisions.md`](005-architecture-decisions.md) (Decisions 3, 5 — both decisions this milestone revisits).

## Goal

Re-open two of the locked architectural decisions if and when product evidence justifies it:

1. **Opt-in recursion past the hard depth-cap-2** — let designated profiles spawn their own children, governed by a bounded but configurable cap. Closes the gap with Mastra.
2. **Fold `subagent_batch` into `subagent`** — drop `minItems: 2`, the model uses one tool for both single and N≥2 dispatches. Matches cc and Mastra.

**This milestone is a re-decision exercise, not a pure-implementation one.** Either change requires a new decision-doc that explicitly retires the relevant locked decision (Decision 5 for recursion; Decision 3 for tool consolidation) and replaces it with the new rule. The implementing agent's first deliverable is the updated decision-doc, not code.

## Functional scope

### IN — recursion opt-in (Decision 5 re-decision)

- **A per-profile `canSpawnChildren?: boolean` flag** (or richer policy — e.g. `maxChildDepth: number`).
- **A new bounded cap** (e.g. `SUBAGENT_MAX_DEPTH = 3` or `4`), still hard, still finite.
- **The child-tool-list-exclusion rule changes** — children with `canSpawnChildren: true` get the `subagent` / `subagent_batch` tools; others still don't.
- **Discovery + validation** for the new field.
- **Updated lifecycle events** record the spawning chain (already partially supported via `subagentDepth`).
- **An updated decision-doc** that retires Decision 5 and lays out the new rule.

### IN — tool consolidation (Decision 3 re-decision)

- **`subagent.tasks: Array` with `minItems: 1`** OR — alternative — **a `subagent` tool whose schema is `{ task } | { tasks: Array }`** (discriminated union). Implementing agent picks based on what reduces schema attractors.
- **`subagent_batch` is removed** from the tool list.
- **`SubagentService.spawnBatch` remains** as the implementation — the consolidation is at the LLM-facing schema, not the internal API.
- **`SubagentBatchEntry` remains** for replay compatibility; new spawns of either shape still use the appropriate entry type.
- **An updated decision-doc** that retires Decision 3 and lays out the new rule.

### OUT

- **Both changes shipped without prior evidence.** The implementing agent's first job is to assess whether real-world usage shows the current shape is causing model confusion or capability gaps. If not, this milestone may stay pending indefinitely — the locked decisions are correct until they're not.
- **Unbounded recursion** — even with opt-in, the cap stays finite (4 max recommended).
- **Per-call recursion override on the `subagent` tool** — the recursion permission is profile-bound (Decision 2 still holds).
- **Different consolidation shape per runtime.**

## Critical interfaces (recommendation-level)

### Recursion opt-in

The minimal viable shape is one optional profile field:
```
canSpawnChildren?: boolean  // default false
```
Richer alternative:
```
recursion?: { maxDepth?: number }  // default { maxDepth: 1 } meaning "this profile cannot spawn"
```

Recommendation: start with the boolean — it's the simplest expression of the opt-in. Add depth-per-profile later if needed.

### Tool consolidation

Option A — **drop `subagent_batch`**, change `subagent.tasks: Array<{ agent, task, model? }>` with `minItems: 1`, keep `failFast?: boolean`. Single-task case: `{ tasks: [{ agent, task }] }`.

Option B — **discriminated union schema**. `subagent.input: { agent, task, model? } | { tasks: Array<...>, failFast?: boolean }`. May be cleaner but adds schema complexity. Most LLMs handle discriminated unions less reliably than flat schemas — Option A probably wins.

Either way, the internal `SubagentService.spawnBatch` keeps its current contract — only the tool schema changes.

## Behaviour rules (invariants this milestone must preserve)

1. **Recursion still has a finite cap.** No "infinite descent" mode.
2. **All other locked decisions still apply** — in particular, Decision 2 (profile is source of truth) means recursion permission can't be a per-call flag.
3. **MCP-empty stance for children** still applies unless milestone 070 has shipped — these milestones are independent.
4. **The tool consolidation does not break replay** — old `subagent_batch` entries in `SessionStore` still load correctly.
5. **Tests for the existing surface** should be updated, not rewritten — the spawn behaviour is unchanged.

## Where this sits in the research spectrum

The current bodhi-pi position (no recursion, two tools) is **conservative** relative to the surveyed harnesses. Both changes would move bodhi-pi toward the "permissive defaults with safety knobs" position that Mastra and cc occupy.

The cost is more configuration surface and more rope for profile authors / LLMs to misuse. The benefit is expressiveness — chains like "planner → research-coordinator → specialist-explorer" become possible.

Whether the move is justified depends on **observed product evidence**:
- Are users authoring profiles that would benefit from recursion?
- Are LLMs reliably picking between `subagent` and `subagent_batch`, or confusing them?
- Are the bundled built-ins limited by depth-cap-2 in their useful behaviour?

The implementing agent should look at real usage before shipping either change.

## Tests / coverage (sketch)

### Recursion
- **Unit:** profile with `canSpawnChildren: true` → child's tool list contains `subagent`; child can spawn grandchild; grandchild without the flag cannot spawn.
- **Unit:** cap enforcement — at the new max depth, the deepest child has no sub-agent tools regardless of its own profile.
- **e2e:** gpt-4o-mini parent spawns child that spawns grandchild; verify the chain completes and returns the grandchild's result up through the layers.

### Tool consolidation
- **Unit:** `subagent { tasks: [{...}] }` (single-task) behaves identically to the old `subagent { agent, task }`.
- **Unit:** `subagent { tasks: [{...}, {...}] }` (batch) behaves identically to the old `subagent_batch`.
- **Unit:** `failFast` semantics preserved.
- **e2e (gpt-4o-mini):** LLM correctly picks single vs multi based on task description.

## Per-runtime impact

| Runtime | Considerations |
|---|---|
| **cli, http, browser, chrome-ext** | Both changes are internal to the tool schema + service. No per-runtime divergence expected. |

## Follow-ups / open knobs

- **A `subagent_chain` workflow primitive** — letting a parent declare a sequential pipeline (A → B → C). Cleaner than recursion for chain-style use cases. Not in scope here; would be a separate workflow-handoff feature, distinct from sub-agents.
- **Per-profile recursion budget** (max number of grandchildren, not just depth) — if recursion ships, fan-out caps may follow.
- **A `--legacy-batch-tool` host config flag** during the consolidation transition — keeps `subagent_batch` registered for one release while users migrate. Designer's call.
- **Re-decision should be a `006-recursion-rethink.md` or `007-tool-consolidation.md` decision-doc** that explicitly retires the relevant entry in 005 with a "Superseded by" pointer. Mirror the modes folder's 005-supersedes-000 pattern.
