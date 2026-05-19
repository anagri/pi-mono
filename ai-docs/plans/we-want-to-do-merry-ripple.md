# Sub-agent milestones: realign on LLM-parallel-tool-use

## Context

The bodhi-pi sub-agent feature originally shipped two LLM tools — `subagent` (single child) and `subagent_batch` (2–N concurrent children with `failFast` + a `BatchProgressAccumulator`). After surveying other agent harnesses (cc, MastraCode, OpenCode, Gemini CLI, Qwen Code), the team concluded that a dedicated batch primitive is the wrong abstraction: every surveyed harness gets parallelism for free from the LLM's own ability to emit multiple tool calls in a single assistant message, dispatched concurrently by the underlying agent loop's `Promise.all` executor.

Phase 2 of the cleanup (`ai-docs/plans/20260518-remove-subagent-batch.md`, completed 2026-05-19) deleted the entire `subagent_batch` surface from the codebase: the tool factory, the `BatchProgressAccumulator`, `SubagentService.spawnBatch`, `SubagentBatchEntry`, the `subagent_batch_start` / `subagent_batch_end` lifecycle events, the `SUBAGENT_DEFAULT_MAX_BATCH_CONCURRENCY` constant, the wire constants, and all associated tests. The replacement is implicit: the LLM emits multiple `subagent` tool calls; `pi-agent-core`'s `executeToolCallsParallel` (in `packages/agent/src/agent-loop.ts`) runs them through `Promise.all`. Concurrency is verified via overlapping `serverTime` windows on the per-child `subagent_start` / `subagent_end` events.

The milestone docs at `ai-docs/sub-agents/milestones/` were written before this cleanup landed in full. Three of them have already received external supersession-banner edits (040 file, 005 Decision 3, 080 historical note) that bolt the new stance on top of the old text. The user's request is to **scrub fully** — rewrite the docs as if `subagent_batch` had never shipped — and **delete the obsolete milestone file** entirely, so that future milestones read coherently against the new architecture.

The intended outcome:
- The current-state docs read as a clean single-tool architecture (one `subagent` tool, parallelism via LLM tool-use).
- The pending milestones (050, 060, 070, 080, 090, 100) carry no stale references to batch primitives.
- The milestone index in `000-overview.md` no longer advertises a "parallel batch" milestone.
- The architecture-decisions doc captures the **current** locked stance for the tool-shape axis without "this was superseded" framing.

## Files affected

### Delete

- `ai-docs/sub-agents/milestones/040-parallel-batch.md` — superseded entirely; no historical body is retained per the "scrub fully" choice.

### Rename

- `ai-docs/sub-agents/milestones/080-recursion-and-tool-consolidation.md` → `ai-docs/sub-agents/milestones/080-recursion-opt-in.md`
  - The "tool consolidation" half of this milestone was about folding `subagent_batch` into `subagent`. Under the new architecture there is no second tool to fold; the consolidation problem evaporates. The recursion half is the only remaining open knob, and the filename should reflect that.

### Modify

#### `ai-docs/sub-agents/milestones/000-overview.md`

| Section | Change |
|---|---|
| "What we shipped" list (the `subagent` / `subagent_batch` bullet near the top) | Replace the two-tool sentence with **one LLM tool: `subagent`** + a one-line note that **parallelism happens via LLM-emitted multiple tool calls in one assistant message, dispatched concurrently by pi-agent-core** |
| Lifecycle-events list ("Four lifecycle events on `BodhiPiEvent`") | Drop `subagent_batch_start` and `subagent_batch_end`. Becomes "**Two lifecycle events:** `subagent_start`, `subagent_end`" |
| Session-entry list ("Three session-entry types") | Drop `subagent_batch`. Becomes "**Two session-entry types:** `subagent_link`, `subagent_complete`" |
| Two-slash-commands list | No change (the host-side slashes are unaffected) |
| "Where we sit in the research spectrum" — Lifecycle row | Change "Foreground + parallel batch; background + resume deferred" → "**Foreground only**, with concurrent dispatch when the LLM emits multiple `subagent` calls in one turn; background + resume deferred to milestones 050/060" |
| "What we deferred" table | No batch-related rows to touch; verify nothing references batch |
| Milestone-sequence table | Delete the row for milestone 040 entirely. Renumber-in-text references if any. Note: keep the gap in numbering (040 stays unused) — re-numbering 050+ would break cross-references in 050/060/070/080/100 and in source-control history |
| "How AI assistants should consume this folder" | No change |

#### `ai-docs/sub-agents/milestones/005-architecture-decisions.md`

| Section | Change |
|---|---|
| TL;DR list (the seven-decisions bullet list near the top) | Rewrite the Decision 3 bullet from "**Two LLM tools, not one** — `subagent` (single) and `subagent_batch` (N≥2) are intentionally separate" to "**Single sub-agent tool with LLM-driven parallelism** — one `subagent` tool; concurrency emerges from the LLM emitting multiple tool calls in one assistant message" |
| Decision 3 full section (currently has a `⛔ Superseded` banner + the old historical content) | Replace the entire section with a fresh Decision 3 that captures the current stance, written as if it had always been the design. Structure: **the spectrum** (cc / Mastra / Gemini batch-as-array vs OpenCode / others use parallel tool-use), **what bodhi-pi does** (single `subagent` tool; pi-agent-core's `executeToolCallsParallel` handles concurrency via `Promise.all`), **why** (matches the majority pattern; no dedicated primitive needed; concurrency is a property of LLM behaviour + agent-loop, not a tool-schema concern), **what we give up** (no failFast/collect-all semantics surfaced at the tool boundary; reasoning models like gpt-5-mini serialize tool calls — concurrency is then an authoring/model-selection concern), **where the alternative still lives** (workflow-handoff graphs as a separate future feature; not a sub-agent concern) |
| "Cross-cutting invariants" table | Remove any rows that reference `subagent_batch` or `BatchProgressAccumulator`. Verify nothing else references the deleted surface |
| "Things explicitly NOT shipped" table | No change required (these are forward-looking, none reference batch) |

#### `ai-docs/sub-agents/milestones/010-foundation-and-fresh-context.md`

| Section | Change |
|---|---|
| OUT list (currently has "**Parallel batch tool** — shipped in P2b (milestone 040), retired in Phase 2 …") | Drop the entire bullet. Parallel dispatch is not a deferred V1 item — it works naturally via LLM tool-use with the V1 surface |
| Follow-ups list (currently has "Parallel sub-agent dispatch → LLM emits multiple `subagent` tool calls…") | Drop the entire bullet. Same reason |

#### `ai-docs/sub-agents/milestones/050-background-execution.md`

| Section | Change |
|---|---|
| Behaviour rules ("`SUBAGENT_DEFAULT_MAX_BATCH_CONCURRENCY` still applies — the cap on concurrent children…") | Delete the rule entirely. The constant no longer exists. If background mode needs a concurrent-children cap, that's a fresh service-level design decision for the implementing agent — not a continuation of the deleted batch cap. Replace, if needed, with a softer note: "concurrent-children cap is a service-level concern, not bound to any prior batch primitive" |
| Follow-ups list (currently has "**Background batches** — `subagent_batch { background: true }` or a `subagent_batch_background` tool?") | Delete the entire bullet. The framing assumed a batch tool that no longer exists. Background concurrency, if needed, is "LLM emits multiple background-flavour `subagent` calls in one turn" — same pattern as foreground parallelism, no separate batch tool required |
| Other batch references (scan for "concurrency", "BatchProgress") | Remove any remaining mentions |

#### `ai-docs/sub-agents/milestones/070-mcp-and-skill-inheritance.md`

| Section | Change |
|---|---|
| Scan for any batch references | None expected per the Phase 1 survey, but verify and remove if present |

#### `ai-docs/sub-agents/milestones/080-recursion-opt-in.md` (after rename)

| Section | Change |
|---|---|
| Title heading | Change from `# Milestone 080 — Recursion opt-in + tool consolidation` (or current text) to `# Milestone 080 — Recursion opt-in` |
| Status / prerequisite-reading block | Remove the "tool consolidation" framing. The current "Historical note" line that explains the consolidation was "shipped differently" gets deleted under scrub-fully |
| Goal section | Remove the second goal (tool consolidation). Keep only the recursion goal |
| Functional scope IN / OUT | Remove the "IN — tool consolidation" subsection. Keep only the recursion subsection |
| Critical interfaces | Remove the "Tool consolidation" subsection. Keep only the recursion shape |
| Tests / coverage | Remove the "Tool consolidation" subsection. Keep only the recursion tests |
| Follow-ups | Remove any consolidation-related bullets |

#### `ai-docs/sub-agents/milestones/090-worktree-isolation.md`

| Section | Change |
|---|---|
| Scan for any batch references | None expected per the Phase 1 survey, but verify and remove if present |

#### `ai-docs/sub-agents/milestones/100-advanced-slash-ux.md`

| Section | Change |
|---|---|
| Candidate slash commands list ("`/parallel <name1> <task1> ; <name2> <task2> ; …` — concrete trigger of `subagent_batch` from the slash side") | Reframe `/parallel` to describe what it would do under the new architecture: a host-side dispatch of multiple `_bodhi-pi/subagent/run` calls running in parallel, with a single consolidated wait. Or — if the command no longer feels useful — drop it. Recommend: keep it, reframe it. Operators want a one-line way to fire several agents at once |
| Ext-method dependencies list (currently mentions "`_bodhi-pi/subagent/batch` ext method (currently the batch path is LLM-tool-only)") | Replace the bullet with: "`/parallel` → repeated `_bodhi-pi/subagent/run` calls executed concurrently host-side". No new ext method needed |

### Cross-reference cleanup

After the file deletion and renames, every milestone file needs to be scanned for:

1. **Links to `040-parallel-batch.md`** — drop the link entirely (file no longer exists). Currently expected in: `005-architecture-decisions.md` (Decision 3 banner — being fully rewritten anyway), `010-foundation-and-fresh-context.md` (OUT list and Follow-ups — being dropped anyway), `100-advanced-slash-ux.md`. Sweep with a grep.
2. **Links to `080-recursion-and-tool-consolidation.md`** — update to `080-recursion-opt-in.md`. Currently expected in: `000-overview.md` milestone-sequence table, possibly `005-architecture-decisions.md`. Sweep with a grep.
3. **Mentions of the orphan plan name `we-want-to-merge-jiggly-meteor.md`** that appears in the existing 005 Decision 3 banner — gets removed when Decision 3 is rewritten.
4. **Mentions of `Decision 3` cross-referenced from other files** — since Decision 3 retains its slot number but with new content, these cross-references stay valid. Verify.

### Final grep gate

After edits, this should return zero hits anywhere under `ai-docs/sub-agents/milestones/`:

```
grep -rn -E 'subagent_batch|SubagentBatch|spawnBatch|BatchProgress|SUBAGENT_DEFAULT_MAX_BATCH|subagent_batch_start|subagent_batch_end|we-want-to-merge-jiggly-meteor' ai-docs/sub-agents/milestones/
```

If any hit remains, the scrub is incomplete.

## Wording the implementer should reuse for consistency

Reuse these phrasings across every file edited, to keep the message uniform:

- The locked stance, short form: **"one LLM-facing sub-agent tool (`subagent`); parallelism via LLM-emitted multiple tool calls in one assistant message"**
- The mechanism, short form: **"pi-agent-core's `executeToolCallsParallel` dispatches concurrent tool calls through `Promise.all`"**
- The model caveat: **"reasoning models (gpt-5-mini, o-series) tend to serialize tool calls one-per-turn; non-reasoning models (claude-haiku-4-5, gpt-4o-mini) emit parallel calls per turn. Concurrency behaviour is therefore an authoring/model-selection concern, not an architectural one"**
- The cross-harness rationale: **"matches the majority pattern across cc, OpenCode, Mastra, Gemini CLI, Qwen Code — none surface a batch primitive at the tool boundary"**

## Critical files referenced by this plan

- Removal plan (read-only reference): `ai-docs/plans/20260518-remove-subagent-batch.md`
- Companion research: `ai-docs/research/sub-agents/Sub-Agent Implementations in Popular Open-Source Agent Harnesses: Research Report for Bodhi-Pi.md`
- The seven-decisions canonical doc: `ai-docs/sub-agents/milestones/005-architecture-decisions.md`
- The status-index: `ai-docs/sub-agents/milestones/000-overview.md`
- Live source for verification of the deleted surface: `packages/bodhi-pi/src/subagents/`, `packages/bodhi-pi/src/tools/`, `packages/bodhi-pi/src/sessions/entries.ts`, `packages/bodhi-pi/src/events/types.ts`, `packages/bodhi-pi/src/wire/constants.ts`

## Verification

A docs-only change — no compile or runtime test will catch missing-batch-mention issues. Verification is by inspection + grep.

1. **`git status` after edits** — confirm only the eight expected paths changed (one delete, one rename, six modifies). No source files (`src/`, `test/`, `e2e/`, `e2e-ui/`) should appear.
2. **`grep -rn -E 'subagent_batch|SubagentBatch|spawnBatch|BatchProgress|SUBAGENT_DEFAULT_MAX_BATCH|subagent_batch_start|subagent_batch_end|we-want-to-merge-jiggly-meteor' ai-docs/sub-agents/milestones/`** — must return zero hits.
3. **`grep -rn '040-parallel-batch' ai-docs/`** — must return zero hits.
4. **`grep -rn '080-recursion-and-tool-consolidation' ai-docs/`** — must return zero hits.
5. **Read each modified file end-to-end** and verify:
   - It reads coherently as a single-tool architecture without dangling references to batch.
   - Cross-links to other milestone files still resolve (especially `080-recursion-opt-in.md` after the rename).
   - Decision 3 in `005-architecture-decisions.md` reads as a fresh decision, not as a "previously we did X, now we do Y" retrofit.
6. **`npm run check` from repo root** — should still pass; docs changes shouldn't affect anything, but run as a smoke gate.

## Scope explicitly NOT in this plan

- **No source-code changes.** The Phase 2 removal plan (`20260518-remove-subagent-batch.md`) already deleted all `subagent_batch` code from `src/`. This plan is documentation-only.
- **No new milestone added.** "LLM parallel tool dispatch" is not a milestone — it's a property of `pi-agent-core` + the existing `subagent` tool. It does not deserve its own slot in the milestone sequence.
- **No renumbering of milestones 050+.** Milestone 040 leaves a gap; cross-references in 050, 060, 070, 080, 100 use ordinal numbers, and renumbering would cause unnecessary churn in the git history of cross-links.
- **No update to `../pending.md`, `../roadmap.md`, `../design.md`, or the retrospectives.** Those are separate documents tracked under `ai-docs/sub-agents/`; this plan is scoped to the `milestones/` subfolder only. A follow-up could address them if needed.
- **No update to the supersession banners in any milestone file.** Under "scrub fully" the banners go away entirely (they're replaced by clean rewrites). No file retains a `⛔ Superseded` marker after this plan executes.
