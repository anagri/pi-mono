# Kickoff: bodhi-pi sub-agents P2a — forked context (parent history clone into child)

**Output**: an exploratory plan written to `ai-docs/plans/YYYY-MM-DD-bodhi-pi-sub-agents-p2a-forked-context.md` AFTER you've grilled the user on the open questions below. Read code first, batch decision points via `AskUserQuestion` (each option marked with your recommended answer), get plan approval before any code edits. Same shape as v2's kickoff workflow.

## Status going in

V1 landed 2026-05-18 (`f7d7d421` → `532ee5fc` → `c8e06bf1` → `62486bfa`). V2 landed 2026-05-18 across eight commits:

- `4d07c27b` — kickoff plan
- `9b67f7b4` — C0: drop `context` attractor from `subagent` LLM tool schema + LLM-invocation regression test
- `e2a3e93d` — C1: bundled built-ins (`explore` + `planner`) + `disabled?`/`source` schema + 2-arity merger
- `cea50e87` — C2: `ExtensionAPI.registerSubagentProfile` + 3-arity merger
- `ea70a10e` — refresh `subagents-list.e2e.ts` for merged-list semantics
- `121ba066` — C3a: cancellation regression test
- `d2a2fc51` — C3b: `SessionState.runtime.subagentDepth` cached (replaces O(n) entry walk)
- `d963a049` — C3c: `SubagentService.spawn` `evictChild` lifecycle per-status (foreground always evicts; background-future will gate the completed branch)
- `2756e5eb` — C4: e2e + e2e-ui coverage for built-in profiles (slash + LLM-invocation paths)
- `bf4d5937` — C5: retrospective + roadmap refinement

V2 surface today:

- 497 unit/integration tests; e2e specs across `in-memory` / `cli` / `http` / `ws` projects; Playwright across `browser` + `chrome-ext`.
- Profiles flow from three sources merged at session bootstrap (project markdown > extension-registered > bundled built-in) with `disabled:true` drop semantics.
- `SubagentProfile.context: "fresh"` is the ONLY accepted value; v1 and v2 both throw on anything else. The field is typed at `src/subagents/types.ts:5` to keep the future API stable.
- `buildChildSessionState` always builds the child with `messages: []` (`src/subagents/build-child-state.ts:49`). The child sees nothing of the parent transcript.
- `_bodhi-pi/session/fork` exists as a sibling concept (full session clone via `SessionGraphService`) — distinct from sub-agent forking but they share semantic territory; the plan must clarify the relationship.
- Recursion is hard-capped at depth 2 via `parent.runtime.subagentDepth + 1` (now O(1) after C3b).
- The `subagent` LLM tool surface is `{agent, task, model?}` only — `additionalProperties: false`. After P2a, a forked variant needs a non-attractor parameter name (e.g. `mode`/`isolation`) per the C0-driven reviewer rule.

**Read first** (in this order):

1. [`ai-docs/sub-agents/v2-retrospective.md`](../sub-agents/v2-retrospective.md) — what landed in v2, what carried forward, the C0 LLM-attractor lesson.
2. [`ai-docs/sub-agents/retrospective.md`](../sub-agents/retrospective.md) — v1 retrospective; surprises that still matter for P2a.
3. [`ai-docs/sub-agents/design.md`](../sub-agents/design.md) — original architecture rationale; the "fresh vs fork" framing.
4. [`ai-docs/sub-agents/roadmap.md`](../sub-agents/roadmap.md) — P2a description (next recommended), P2b/P3a deferred ordering.
5. [`ai-docs/sub-agents/pending.md`](../sub-agents/pending.md) — status of every deferred item; P2a row.
6. [`ai-docs/specs/bodhi-pi/subagents.md`](../specs/bodhi-pi/subagents.md) — current spec; needs amendments for the new context mode + tool surface.
7. [`ai-docs/specs/bodhi-pi/acp.md`](../specs/bodhi-pi/acp.md) — `_bodhi-pi/subagent/run` params + `_bodhi-pi/session/fork` sibling for cross-referencing semantics.
8. [`ai-docs/plans/2026-05-18-bodhi-pi-sub-agents-v2.md`](../plans/2026-05-18-bodhi-pi-sub-agents-v2.md) — v2 plan; especially the "Risk register" entry #8 (LLM-attractor rule) and risk #1 (cross-runtime bundling).
9. Source: `packages/bodhi-pi/src/subagents/subagent-service.ts` (the spawn flow, depth check, signal wiring), `packages/bodhi-pi/src/subagents/build-child-state.ts` (the `messages: []` site and the `messages` arg that already exists in `createPiAgent`), `packages/bodhi-pi/src/subagents/types.ts` (the `context: "fresh"` literal), `packages/bodhi-pi/src/sessions/session-graph-service.ts` (the existing `_bodhi-pi/session/fork` for relationship discussion), `packages/bodhi-pi/src/tools/subagent.ts` (the LLM tool schema — adding a parameter needs the C0 attractor-rule treatment).
10. Upstream research (already cloned for v1, intentionally not committed but the report is at `ai-docs/research/sub-agents/`): how cc / Mastra / pi-subagents implement forked subagents — `cc:forkSubagent.ts`, `Mastra:tools.ts:893-989`, `pi-subagents:fork` flow. Inspect the slice-selection logic and the recursion-blocking-via-boilerplate trick.

## Goal

Enable a child sub-agent to inherit a slice of the parent's conversation so the child can see prior context that the task description alone can't carry. Specific use cases the user calls out:

- "Review this diff" — child has seen the diff content via parent's `read` tool result; doesn't need it re-fetched in the task body.
- "Continue this investigation" — child picks up where parent's explore stopped, including the file paths parent already walked.
- "Verify the plan against the spec" — child sees parent's plan + the spec excerpts parent loaded.

Concretely, P2a lands:

1. **`context: "fork"`** as a valid `SubagentFrontmatter`/`SubagentProfile` value (replaces the v1 throw).
2. **Slice-selection mechanism** on `SubagentService.spawn` — how much of the parent transcript ends up in `messages: [...]` passed to `buildChildSessionState` (currently empty per `build-child-state.ts:49`).
3. **Tool surface for the LLM-invoked path** — the `subagent` tool gains a way to request fork mode without re-introducing an attractor field. Per the C0 reviewer rule, any new optional parameter constrained to a single literal value is forbidden; this MUST be a real enum of ≥2 values or absent from the schema.
4. **Recursion-blocking under fork** — Mastra/cc both inject a fork-boilerplate marker into the child's prompt so they can detect "this is already a forked turn, do not fork again". Decide whether bodhi-pi adopts the same trick or relies on the existing depth-2 cap.
5. **Relationship with `_bodhi-pi/session/fork`** — clarify in the spec whether sub-agent fork mode and session fork are sibling features sharing implementation (e.g. a shared `cloneTranscriptSlice` helper) or independent paths.

## What still exists (don't reimplement)

- `loadProjectArtifacts` + `mergeSubagentProfiles(project, extension, builtin)` in `src/extensions/merge.ts` — the contribution-source pipeline. P2a does NOT touch this; it adds a new *mode* per profile, not a new contribution source.
- `validateAndNormalizeProfile` in `src/subagents/_validate.ts` — the shared validation helper. Extending the `context` enum lands here.
- `SubagentService.spawn` in `src/subagents/subagent-service.ts:139` — the foreground spawn flow. P2a adds a `messages` building step before `buildChildSessionState(...)` is called.
- `buildChildSessionState` in `src/subagents/build-child-state.ts:9` — accepts the `parentSessionState` and already has the `createPiAgent({..., messages: [...]})` wiring (`session-bootstrap.ts:281`). The `messages: []` constant at line 49 becomes the slice arg.
- `_bodhi-pi/session/fork` + `SessionGraphService` in `src/sessions/session-graph-service.ts` — sibling concept. Quote the existing slice-selection logic if any is reusable.
- The C0 LLM-attractor rule (`feedback_bodhi_pi_tool_schema_llm_attractors` memory). MUST be applied to any new LLM-facing tool parameter.
- The 6-step workflow + runtime-neutrality rule in `packages/bodhi-pi/CLAUDE.md`.
- The depth-cap mechanism in `SubagentService.spawn` (`parent.runtime.subagentDepth + 1 > 2`) — works as-is; fork doesn't change the depth math.

## Open exploration questions to resolve before designing

Resolve these by reading source first, then `AskUserQuestion` (with your recommended answer per question) before writing the plan. Batched per area:

### Slice selection — what gets cloned

- **Full parent transcript vs last-N-messages vs to-last-user-prompt vs explicit `slice` arg** — full transcript is closest to "child sees what parent sees" but bloats context; last-N is fast but loses semantic boundaries; to-last-user-prompt matches the cc/Mastra fork pattern (clone everything up to and including the most recent user turn). **Recommend** to-last-user-prompt as the default with no per-call override in P2a; per-call `slice: {...}` lands in a future phase if needed. Validate by reading what Mastra/cc actually slice.
- **Snapshot vs continuous mirror** — snapshot at spawn time means the child has a frozen view; continuous would require keeping a live link between parent and child entry logs. **Recommend** snapshot — matches the in-process, foreground-only model and avoids designing the link semantics now.
- **What does the child see as "the task"?** — the child's first message is currently `[{type:"text", text: input.task}]` (`subagent-service.ts:218`). Under fork, is the task appended to the cloned transcript as a new user turn, OR is the cloned transcript treated as system context with the task as the only user turn? **Recommend** appended-as-new-user-turn so the LLM treats it like a continuation; matches cc's `appendDirective` pattern.

### Tool surface for the LLM-invoked path

- **How does the LLM request fork mode?** Options: (a) new `mode: "fresh" | "fork"` parameter on the `subagent` tool with a real enum of ≥2 values (per C0 reviewer rule); (b) a separate `subagent_fork` tool registered alongside `subagent`; (c) decided entirely by the profile (no LLM-facing knob — if the profile says `context: fork` the LLM always gets fork). **Recommend** (c): keep the LLM tool surface unchanged; the profile decides. The LLM doesn't have enough information about parent context to choose modes correctly; this is a profile-design decision. Reconsider only if a real use case for runtime override surfaces.
- **If (a) is chosen** — name the parameter to avoid the `context` attractor trap. Candidates: `mode`, `isolation`, `inherit`. Pair with `subagents-llm-invocation.test.ts`-style coverage per the C0 reviewer rule.
- **Ext-method `_bodhi-pi/subagent/run` params** — currently `{sessionId, agent, task, model?}`. Even if the LLM tool stays unchanged, does the ext-method gain a runtime override for tests + Host UIs? **Recommend** no — keep the ext-method narrow; the profile is the source of truth. Tests that need fork-mode coverage seed a `context: fork` profile fixture.

### Recursion-blocking under fork

- **Fork-boilerplate detection vs depth-cap only** — cc and Mastra both inject a sentinel into the child's prompt and detect it on recursive entry to short-circuit "you are already forked". bodhi-pi's depth-cap-2 already prevents infinite recursion; the boilerplate trick is mostly for prompt-cache stability (don't re-fork into the same boilerplate). **Recommend** depth-cap only for P2a. v2 deliberately excluded `subagent` from the child tool set (`build-child-state.ts:31`), so children can't spawn at all, so the recursion concern is currently moot. Re-evaluate when recursion opt-in lands (P3d).

### Profile schema extension

- **`context` enum widening** — `SubagentProfile.context` becomes `"fresh" | "fork"`. The frontmatter parser already passes the field through. `validateAndNormalizeProfile` currently hardcodes `context: "fresh"` (`_validate.ts:38`) ignoring the frontmatter value. P2a updates this to validate against the enum. **Recommend** strict enum with default `"fresh"` when frontmatter is omitted; reject unknown values at parse time (drop profile, like other validation failures).
- **Per-profile slice config (future)** — `context: fork` + `slice: {strategy: "last-user-prompt" | "last-n", n?: number}` is the natural extension. **Recommend** NOT in P2a; ship with the single default slice strategy. The schema stays clean; future profiles can opt into custom slicing without breaking existing fork profiles.

### Interaction with `_bodhi-pi/session/fork`

- **Shared helper vs independent paths** — `SessionGraphService` already has session-fork logic that clones an entry log. **Recommend** read it first; if its slice-selection matches what P2a wants, extract a shared `cloneTranscriptSlice(record, strategy)` helper used by both. If they diverge meaningfully (session-fork is a full clone, sub-agent fork is a transcript-only inheritance into a different child shape), document the divergence in `subagents.md` and `acp.md` and keep them independent.
- **Spec wording** — `subagents.md` must explicitly state that "sub-agent fork" and "session fork" are sibling concepts (both produce a child SessionRecord with `parentSessionId` set, but session-fork preserves the full session shape including tools/skills/MCP, sub-agent fork is profile-constrained).

### Tests + Playwright

- **Faux-provider integration test** — `test/subagents-fork.test.ts` seeds a `context: fork` profile, runs the parent through 2-3 turns to build a transcript, spawns the fork child, asserts the child's first prompt-loop call receives `messages: [...]` containing the parent slice. Use the captured-messages pattern from the existing tool tests (`faux.setResponses([(ctx) => { capturedMessages = ctx.messages; ... }])`).
- **e2e (real gpt-4o-mini)** — seed `<cwd>/diff.md` with a known change; parent reads it via the `read` tool; parent then spawns the fork child with task "review the diff for issues"; assert the child's response references a specific fact from the diff WITHOUT the task body re-stating it. The "without re-stating" is the proof that the child actually saw the parent's tool result.
- **Playwright** — mirror the e2e scenario through `/subagent <forking-profile> review the diff`. Assert the child summary references the parent's read output.
- **Refresh existing tests** — `subagents-discovery.test.ts` currently asserts `context: "fresh"` on every profile; widen to accept either value. `subagents-llm-invocation.test.ts` (C0) asserts `subagent` tool params schema. If the LLM tool surface changes (option a from above), add the matching attractor-rule test per `feedback_bodhi_pi_tool_schema_llm_attractors`.

## Locked scope decisions (user-confirmed)

> Empty — fill in via the AskUserQuestion batch. Recommended defaults are the **Recommend** markers above.

## Process — iterative TDD across the matrix

Per `feedback_e2e_coverage_keeps_feature` and `packages/bodhi-pi/CLAUDE.md` 6-step workflow: a variant is "done" only when it has at least one of `{e2e, cli-headless, Playwright}` per supported runtime.

Recommended cadence (depth-first per runtime per `feedback_phasing_depth_first`):

1. **Integration first**. `packages/bodhi-pi/test/subagents-fork.test.ts` — write the failing test that asserts the child's first prompt-loop call receives a non-empty `messages: [...]` containing the parent's last user turn + assistant response. Implement the slice + wire to make it pass.
2. **Schema test**. Update `subagents-discovery.test.ts` to assert `context: "fork"` is accepted and stored verbatim. Update `_validate.ts` to widen the enum.
3. **LLM-invocation test refresh**. If the LLM tool surface changes, extend `subagents-llm-invocation.test.ts` per the C0 attractor-rule.
4. **e2e direct-ACP** (in-memory + cli + http + ws). `subagents-fork.e2e.ts` asserts the gpt-4o-mini round-trip — child references a parent-only fact.
5. **e2e-ui Playwright** across browser + chrome-ext (+ http variant if matrix runs there). Mirror the e2e scenario.

Each commit ends green on `npm run check` + relevant test slices. Each Host runtime gets its own validation gate before moving on.

## Gate-check + commit cadence

Suggested commit shape (NOT prescriptive — slice however makes commits bisectable):

- C1: schema widening (`context: "fork"` accepted) + `cloneTranscriptSlice` helper + integration test + spec updates (`subagents.md` profile frontmatter + new "Fork mode" section).
- C2: `SubagentService.spawn` fork branch — picks the slice, passes `messages: [...]` to `buildChildSessionState`. Integration test asserts the wire shape.
- C3 (only if LLM tool surface changes): tool schema update + `subagents-llm-invocation.test.ts` extension + spec update (`subagents.md` LLM tool section + `acp.md` table).
- C4: e2e + e2e-ui across all four runtimes (fork scenario).
- C5: retrospective + roadmap refinement (`p2a-retrospective.md` or fold into a single `phase-2-retrospective.md` once P2b lands).

Each runtime gated through CLAUDE.md 6-step. After all commits land green, write the retrospective.

## Plan structure (mandatory sections)

When you write the plan after grilling the user, include:

1. **Goal restatement** — quote the user-facing use cases (review-diff, continue-investigation, verify-plan).
2. **Locked-scope summary** — table: decision → user-locked answer → file:line where it lands.
3. **Open-question resolutions** — table: question → recommended answer → user-answer (filled during planning session).
4. **File-level inventory** — new files, touched files, spec docs amended. Per file: one-line purpose.
5. **Per-commit slice** — propose commits + validation gate per commit (npm run check + which test files + which e2e/e2e-ui specs).
6. **Verification matrix** — per runtime: which npm/vitest/playwright command to run after each commit lands.
7. **Risk register** — slice-selection bugs that under-include or over-include parent context (especially around tool_call/tool_result pairing — never include a `tool_call` without its matching `tool_result`); fork + `_bodhi-pi/session/fork` semantic confusion; LLM-attractor regression on any new tool parameter; pre-existing `subagent_link` entry shape doesn't carry slice metadata (does it need to?).
8. **Out of scope** — explicitly: per-call `slice: {...}` override, parallel batch (P2b), background runs (P3a), MCP/extension/skill inheritance for child (P3c/P3d), worktree (P4a), recursion opt-in (P3d), workflow-handoff mode (P4c).

## Anti-patterns to avoid

- Don't reintroduce a `context` attractor field on the `subagent` LLM tool schema. The C0 lesson is in the memory at `feedback_bodhi_pi_tool_schema_llm_attractors`. If a runtime knob IS needed, name it `mode`/`isolation` and supply a real enum of ≥2 values + a matching `subagents-llm-invocation.test.ts` case.
- Don't reimplement the merge/discovery pipeline — `context: fork` is a per-profile flag; the contribution-source pipeline doesn't change.
- Don't conflate sub-agent fork with `_bodhi-pi/session/fork`. They share a parent-child SessionRecord shape but the user-facing semantics + profile constraints differ. Spec wording must distinguish them explicitly.
- Don't add a per-call `slice` parameter in P2a. Ship with the default strategy; future phases can extend.
- Don't break `tool_call`/`tool_result` pairing when slicing. A slice that ends mid-tool-call (cut between `tool_call` and `tool_result`) corrupts the child's message history. The slice helper must enforce pair completeness.
- Don't add source comments. WHY goes in commit message bodies per the `feedback_no_low_value_comments` memory.
- Don't add `node:*` imports under `src/subagents/` — runtime-neutrality rule from `packages/bodhi-pi/CLAUDE.md`.
- Don't expand the open-question list beyond what's actionable for P2a — defer parallel/background/skill-inheritance to their own kickoffs.

## References

- V1 commits: `f7d7d421` (C1), `532ee5fc` (C2), `c8e06bf1` (C3), `62486bfa` (retrospective+roadmap).
- V2 commits: `4d07c27b` (plan), `9b67f7b4` (C0), `e2a3e93d` (C1), `cea50e87` (C2), `ea70a10e` (e2e refresh), `121ba066` (C3a), `d2a2fc51` (C3b), `d963a049` (C3c), `2756e5eb` (C4), `bf4d5937` (C5).
- V1 plan: `ai-docs/plans/20260518-subagents-v1.md`. V2 plan: `ai-docs/plans/2026-05-18-bodhi-pi-sub-agents-v2.md`.
- V1 + V2 design / retrospectives / roadmap / pending: under `ai-docs/sub-agents/`.
- Upstream research: `ai-docs/research/sub-agents/` — `cc:forkSubagent.ts`, `Mastra:tools.ts:893-989`, `pi-subagents:fork`.
- Specs to amend: `ai-docs/specs/bodhi-pi/subagents.md` (frontmatter table + new "Fork mode" section), `ai-docs/specs/bodhi-pi/acp.md` (only if `_bodhi-pi/subagent/run` params change).
- Sibling concept: `src/sessions/session-graph-service.ts` (the `_bodhi-pi/session/fork` handler).
- Memory: `feedback_bodhi_pi_tool_schema_llm_attractors` (LLM-attractor reviewer rule from C0), `feedback_no_low_value_comments` (zero comments), `feedback_bodhi_pi_e2e_strategy` (gpt-4o-mini for e2e), `feedback_phasing_depth_first` (depth-first per runtime).

## When done

Print: the plan path, the count of open questions resolved during the session, and the proposed commit subjects in order. Do not start executing the plan in this round — the plan IS the deliverable. Implementation runs in a separate session, ideally guided by `superpowers:executing-plans` or `superpowers:subagent-driven-development`.
