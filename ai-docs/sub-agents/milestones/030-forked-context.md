# Milestone 030 — Forked context (P2a)

> **Status:** ☑ shipped (P2a phase, 2026-05-18 — five commits: `87ab9b2e` → `50c3ca45`).
> **Prerequisite reading:** [`005-architecture-decisions.md`](005-architecture-decisions.md) (Decisions 2, 4, 7), `../p2a-retrospective.md`.

## Goal

Add a second context mode to sub-agents — `fork` — that gives the child a filtered clone of the parent's conversation transcript instead of starting from a clean slate. Profile authors opt in per-profile by setting `context: "fork"` in the markdown frontmatter or extension definition; the LLM never sees a per-call override.

This is the first time a child is bootstrapped with non-empty message history, and the first time the parent's session-entry stream is read (not just appended to) by the sub-agent system.

## Functional scope

### IN

- **`context: "fresh" | "fork"` on `SubagentProfile`** — declared in V1 but only `"fresh"` was exercised. P2a wires the `"fork"` branch end-to-end.
- **Shared transcript-clone helper** — `cloneTranscriptSlice(parentSession)` produces a filtered copy of the parent's entries suitable for use as a child's initial history. Lives in `src/sessions/clone-slice.ts`. Reused by the existing `_bodhi-pi/session/fork` ext method.
- **`SUBAGENT_FORK_FILTER`** — a `Set<SessionEntry["type"]>` of entry types that are excluded from a forked child's view. Current contents: `mcp_inclusion_set`, `extension`, `subagent_link`, `subagent_complete`, `subagent_batch`. Lives in `src/subagents/_clone-slice-filter.ts`.
- **Spawn-flow fork branch** — `SubagentService.spawn` reads `profile.context`; if `"fork"`, builds the child's initial state with the cloned + filtered transcript. The child's `runPromptLoop` sees this as its starting message history.
- **`contextMode` field on `SubagentLinkEntry`** — records which mode was used, so replay / inspection can tell fresh vs fork spawns apart.
- **`contextMode` on lifecycle events** — `subagent_start` and `subagent_end` events carry the mode for extensions / UIs that want to render differently.
- **Discovery validation** — `_validate.ts` accepts `context` only with the two literal values; unknown values trigger a discovery warning and the profile is dropped (consistent with the rest of the validation pipeline).

### OUT

- **Per-call slice override on the `subagent` tool.** Researched and explicitly rejected (Decision 2 — attractor). The `subagent` tool's parameter set is unchanged.
- **Curated-summary fork mode** (e.g. "last 5 turns only"). Rejected by Decision 7.
- **Mid-pair-completeness hardening** — if the parent forks mid-`tool_call`/`tool_result` pair, the child inherits the same gap behaviour as `_bodhi-pi/session/fork`. Hardening is deferred — see `../pending.md`. In practice the spawn happens at end-of-turn, so the gap is rare.
- **Pretty-print of fork lineage in the parent UI.** Currently a forked spawn renders identically to a fresh spawn in the host UI; deeper diff visibility is not scoped.
- **Token-budget accounting for the cloned slice.** The full filtered transcript is passed regardless of size; long parent sessions can generate expensive child spawns.

## Critical interfaces

### `cloneTranscriptSlice(parentSession): SessionEntry[]`
Shared with the existing `_bodhi-pi/session/fork` ext method. Recommendation: keep the helper pure — input is the parent's session record + the filter; output is a new array of entries that can be appended to a fresh `SessionState`'s entry list before its first turn.

### `SUBAGENT_FORK_FILTER`
A `Set` of session-entry `type` strings excluded from a forked child's view. The current contents (`mcp_inclusion_set`, `extension`, `subagent_link`, `subagent_complete`, `subagent_batch`) reflect two rules:
1. Drop entries that describe the parent's *runtime configuration*, not its *conversation* (mcp_inclusion_set, extension).
2. Drop entries that describe *prior sub-agent activity* — a forked child shouldn't see other children's link/complete records, both because they're not conversational and because they could trick the LLM into trying to spawn its own children (and the depth-cap-2 prevents that anyway).

### `SubagentService.spawn` (extended)
The fork branch path: load the parent's session, run `cloneTranscriptSlice`, build the child's initial `SessionState` with those entries pre-loaded, then proceed identically to the fresh path (same prompt-loop, same return-protocol, same lifecycle events with `contextMode: "fork"` set on the link entry and the events).

### Updated session-entry / event shapes
- `SubagentLinkEntry.contextMode: "fresh" | "fork"`.
- `BodhiPiEvent` variants `subagent_start` / `subagent_end` gain a `contextMode` field.

## Behaviour rules (invariants)

1. **`profile.context` is the only knob.** No per-call override.
2. **The filter is identical for every fork spawn.** No per-profile filter customisation.
3. **Fresh profiles get an empty initial entry list.** Their `runPromptLoop` starts with system prompt + user task only.
4. **Fork profiles get the full filtered transcript as their initial entry list**, regardless of length. No truncation, no summarisation.
5. **A forked child does not see prior subagent-related entries** (its own ancestors' link/complete records).
6. **Lifecycle events distinguish modes** — extensions can subscribe and render fresh vs fork distinctly if needed.
7. **The depth-cap-2 invariant still holds.** A forked child is still depth ≥ 1 and still cannot spawn its own children.
8. **The MCP-empty invariant still holds.** Forking the *conversation* does not fork the parent's MCP tool list — the child still gets zero MCP tools (Decision 6).

## Where this sits in the research spectrum

Milestone 030 commits bodhi-pi to two more of the locked decisions:
- **Decision 4 (fresh-default).** Fork is opt-in per profile; built-ins (`explore`, `planner`) stay fresh.
- **Decision 7 (full-transcript fork).** No curated slice mode. Filtering is structural (drop non-conversational entries), not size-based.

Relative to the spectrum:
- **Context isolation axis:** bodhi-pi now occupies the full-fork position (cc, Gemini CLI) and the task-only position (OpenCode, fresh default) simultaneously — the profile picks.
- The harnesses that offer multiple fork modes per-call (Mastra) are deliberately *not* mirrored. The decision-doc rationale (Decision 2 attractor argument) wins.

## Tests / coverage

- Unit: `subagents-fork.test.ts` (fork-mode spawn end-to-end), `subagents-fork-schema.test.ts` (profile validation accepts `context: "fork"`, rejects unknown values).
- e2e: `subagents-fork.e2e.ts` — verifies a forked child observably uses the parent's prior context in its reply via gpt-4o-mini.
- e2e-ui (Playwright): `subagents-fork.spec.ts` — verifies the forked spawn renders correctly in the browser/chrome-ext/http hosts.
- Discovery: extended tests for the validator's handling of `context` frontmatter values.

## Per-runtime impact

| Runtime | What changed |
|---|---|
| **cli** | A profile with `context: "fork"` works identically to fresh from the user's POV — same `/subagent` command, same result rendering. |
| **http** | Per-turn-rebuild has to be careful with the parent's session: `cloneTranscriptSlice` reads the parent's current entry list before mutating it with `subagent_link`. The implementation handles this; new contributors should be aware. |
| **browser** | Web Worker handles the clone in-process; no IPC overhead. |
| **chrome-ext** | Same as browser. |

No per-runtime divergence in `src/subagents/` or `src/sessions/clone-slice.ts` — fully runtime-neutral.

## Follow-ups / open knobs

- **Per-call slice override** — researched in P2a, dropped. Would re-open Decision 2; not in any pending milestone.
- **Curated-summary fork mode** — researched, dropped. Would re-open Decision 7; not in any pending milestone.
- **Mid-pair-completeness hardening** — see `../pending.md`. Shared problem with `_bodhi-pi/session/fork`; would land as a `clone-slice.ts` improvement and benefit both code paths.
- **Token-budget caps on the cloned slice** — not in any pending milestone. If long-running sessions become expensive, a per-profile `maxForkTokens` could land here, but adds another profile knob.
- **A built-in `planner-fork` variant** — would let `planner` use fork-by-default while keeping the fresh `planner` for cheap cases. Not scoped; profile authors can ship a project-level override today.
