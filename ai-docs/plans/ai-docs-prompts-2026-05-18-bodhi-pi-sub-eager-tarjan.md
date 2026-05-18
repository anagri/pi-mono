# bodhi-pi sub-agents P2a — forked context plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan commit-by-commit. Trunk-based — each commit must be green on its own.
>
> **Naming note:** plan-mode forced the file path here; on approval, rename/move to `ai-docs/plans/2026-05-18-bodhi-pi-sub-agents-p2a-forked-context.md`.

## Context

V2 (`bf4d5937`) shipped bundled built-ins, extension-registered profiles, and the v1 carry-forward triplet. `SubagentProfile.context` is typed `"fresh" | "fork"` in the future-stable schema but `validateAndNormalizeProfile` hardcodes `"fresh"` (`src/subagents/_validate.ts:38`) and `SubagentService.spawn` always builds the child with `messages: []` (`src/subagents/build-child-state.ts:49`). P2a fills in the missing `fork` mode so children can see a slice of the parent's conversation.

The user-facing motivation: "review this diff" / "continue this investigation" / "verify the plan against the spec" — tasks where the parent has already loaded relevant tool results that the child shouldn't have to re-fetch. The existing `_bodhi-pi/session/fork` (full session clone via `SessionGraphService` + `sessionStore.forkRecord`) is a sibling concept; P2a shares the slice-selection primitive with it via a new `cloneTranscriptSlice` helper but stays distinct in spec because the user-facing semantics differ (session-fork preserves full session shape; sub-agent fork is profile-constrained and drops session-management entry types).

## Goal

Enable `context: "fork"` profile mode end-to-end across the four reference Hosts:

- `SubagentProfile.context` and `SubagentFrontmatter.context` accept `"fresh" | "fork"`; `_validate.ts` enforces the enum at parse with `"fresh"` as the default when omitted.
- `SubagentService.spawn` branches on the profile's `context`: when `"fork"`, calls the new `cloneTranscriptSlice` helper to extract the parent's chronological transcript (filtered for session-management noise), converts it to `AgentMessage[]`, and passes it as `messages: [...]` to `buildChildSessionState`.
- The LLM-facing `subagent` tool schema is **unchanged** — the profile is the source of truth. No `mode`/`isolation` parameter. (cc reference shows no LLM-facing fork toggle; the user's "drop it if cc doesn't have it" decision holds.)
- The `subagent_link` SessionEntry and `subagent_start` / `subagent_end` lifecycle events carry `contextMode: "fresh" | "fork"` so inspection/UI can render lineage.
- Existing `sessionStore.forkRecord` implementations (in-memory + Node SQLite single/multi-tenant) refactor to call `cloneTranscriptSlice` with no entry-type filter — behavior preserved.

## Architecture

- **Shared slice helper** in `src/sessions/clone-slice.ts`:
  ```
  cloneTranscriptSlice(entries, { leafOrFromEntryId?, excludeTargetEntry?, excludeEntryTypes? })
    → SessionEntry[]
  ```
  Composes `walkPath(entries, leafOrFromEntryId)` + optional `slice(0, -1)` for "before" semantics + optional entry-type filter. Pure, runtime-neutral.
- **Entries → AgentMessage[] conversion** for sub-agent fork reuses `buildSessionContext({entries: cloned, leafId: null})` from `src/sessions/build-context.ts:78` and takes only `.messages`. No new converter needed; `buildSessionContext` already handles `compaction` collapse, `branch_summary` / `custom_message` wrapping, etc. The other fields it returns (`currentModelId`, `currentThinkingLevel`, `mcpInclusion`) are intentionally discarded — the child's model/thinking/MCP come from the profile, not parent state.
- **`SubagentService.spawn` branch** at the existing `messages: []` site: read `input.profile.context`; if `"fork"`, load `parentRecord = await sessionStore.load(parent.parentSessionId-or-current)` (actually we already have `parent: SessionState` — use `sessionStore.load(input.parentSessionId)` to get the persisted entries since `SessionState` doesn't carry them), call `cloneTranscriptSlice(parentRecord.entries, { leafOrFromEntryId: parentRecord.leafId, excludeEntryTypes: SUBAGENT_FORK_FILTER })`, run through `buildSessionContext`, pass `.messages` to `buildChildSessionState`.
- **Filter constant** in `src/subagents/_clone-slice-filter.ts` (or co-located): `SUBAGENT_FORK_FILTER = new Set(["mcp_inclusion_set", "extension", "subagent_link", "subagent_complete"])`. These are session-management entries that don't belong in a sub-agent child's "what the parent was doing" view.
- **Tool/result pair completeness**: NOT enforced (user-locked: inherit the existing `_bodhi-pi/session/fork` gap). Risk register documents this; behavior matches the v1 fork sibling so users get one consistent semantic across both fork features.
- **Recursion-blocking**: depth-cap-2 only. Children still don't get the `subagent` tool (`build-child-state.ts:31`), so recursion is moot. No fork-boilerplate detection. Re-evaluate at P3d (recursion opt-in).
- **`subagent_link` entry** widens to include `contextMode: "fresh" | "fork"`. `subagent_start` and `subagent_end` lifecycle events same. Both rails wired (in-process `pi.on(...)` + wire `LIFECYCLE_EVENT_METHOD` forwarding) per `packages/bodhi-pi/CLAUDE.md` "Major components expose lifecycle events on both rails" rule.

## Tech Stack

- TypeScript strict, ESM, **no `node:*` in `src/`**.
- Vitest for unit/integration; Playwright for e2e-ui across all 4 reference Hosts.
- Faux provider for integration; gpt-4o-mini for e2e per `feedback_bodhi_pi_e2e_strategy`.
- Trunk-based development per `packages/bodhi-pi/CLAUDE.md` — each commit individually green.

---

## Locked-scope summary

| Decision | User-locked answer | Lands at |
|---|---|---|
| Slice strategy | Full parent transcript, filtered (drop `mcp_inclusion_set`, `extension`, `subagent_link`, `subagent_complete`) | `src/sessions/clone-slice.ts` + `src/subagents/_clone-slice-filter.ts` |
| Pair-completeness enforcement | Inherit existing gap (no enforcement) — matches v1 `_bodhi-pi/session/fork` behavior | risk register only |
| LLM-facing fork knob | None — profile decides via `context: fresh\|fork`. cc has no per-call toggle; we drop it. | `src/tools/subagent.ts` unchanged |
| Shared slice helper | Extract `cloneTranscriptSlice` and refactor `sessionStore.forkRecord` (3 impls) to use it | `src/sessions/clone-slice.ts` + 3 store impls |
| Recursion blocking | Depth-cap only (children don't get `subagent` tool) | existing `SubagentService.spawn` depth check |
| Task placement under fork | Appended as new user turn after cloned slice (cc/Gemini pattern) | `SubagentService.spawn` already appends `input.task` as the first prompt — no change needed |
| Lineage on events + link entry | `contextMode: "fresh" \| "fork"` on `subagent_link` SessionEntry, `subagent_start` event, `subagent_end` event | `src/sessions/entries.ts`, `src/events/types.ts`, `src/subagents/subagent-service.ts` |

## Open-question resolutions

| Question | Resolution |
|---|---|
| Slice strategy — full filtered vs last-user-prompt vs full unfiltered | **Full parent transcript, filtered** |
| Pair-completeness handling | **Inherit existing gap** (match v1 fork behavior) |
| LLM-facing fork mode toggle | **None — profile decides** (cc analysis confirms no equivalent) |
| Shared helper with `_bodhi-pi/session/fork` | **Extract** `cloneTranscriptSlice` and refactor v1 fork to use it |

---

## File inventory

### New files

| Path | Purpose |
|---|---|
| `packages/bodhi-pi/src/sessions/clone-slice.ts` | `cloneTranscriptSlice(entries, opts): SessionEntry[]` — composes `walkPath` + optional slice-before + optional entry-type filter. Pure function; runtime-neutral. |
| `packages/bodhi-pi/src/subagents/_clone-slice-filter.ts` | `SUBAGENT_FORK_FILTER` — the set of entry types the sub-agent fork drops. Co-located with the subagent domain so the filter is one grep away from `SubagentService.spawn`. |
| `packages/bodhi-pi/test/clone-slice.test.ts` | Unit tests for the helper: walks-from-leaf, walks-from-arbitrary-entry, `excludeTargetEntry: true` drops the target, `excludeEntryTypes` filters, empty entries → `[]`, missing leafId falls back to last entry. |
| `packages/bodhi-pi/test/subagents-fork.test.ts` | Integration: faux provider captures `ctx.messages` to verify the child receives the parent's filtered transcript; covers (a) parent message + assistant + user-task; (b) `subagent_link` carries `contextMode: "fork"`; (c) `subagent_start` event payload; (d) entry-type filter drops `mcp_inclusion_set`. |
| `packages/bodhi-pi/test/subagents-fork-schema.test.ts` | Profile-schema tests: frontmatter `context: fork` accepted; frontmatter `context: invalid` rejected (profile dropped); frontmatter omitted defaults to `"fresh"`. |
| `packages/bodhi-pi/test/subagents-fork-lifecycle.test.ts` | Wire-level: captures `harness.extNotifications` and asserts `subagent_start.contextMode === "fork"`, `subagent_end.contextMode === "fork"` — gates the both-rails rule. |
| `packages/bodhi-pi/e2e/shared/subagents-fork.e2e.ts` | gpt-4o-mini: seed `<cwd>/diff.md`; parent reads it via the `read` tool; parent spawns a `context: fork` profile with task "review the diff for issues"; assert the child's summary references a specific fact from the diff WITHOUT the task body re-stating it (proves the child saw the parent's tool result). Three scenarios shared across in-memory / cli / http / ws. |
| `packages/bodhi-pi/e2e/data/subagents-fork/diff.md` | Seed fixture with a known content fact (e.g. "renamed `oldName` to `BLUE_FORK_42`"). |
| `packages/bodhi-pi/e2e/data/subagents-fork/.bodhi-pi/agents/reviewer.md` | Project profile fixture with `context: fork` for the e2e to spawn. |
| `packages/bodhi-pi/e2e-ui/shared/subagents-fork.spec.ts` | Playwright mirror: slash-dispatch path (`/subagent reviewer review the diff`) + natural-language path. Shared across `browser` + `chrome-ext` projects. |
| `packages/bodhi-pi/e2e-ui/data/subagents-fork/diff.md` | Mirror seed for Playwright. |
| `packages/bodhi-pi/e2e-ui/data/subagents-fork/.bodhi-pi/agents/reviewer.md` | Mirror profile fixture. |
| `ai-docs/sub-agents/p2a-retrospective.md` | C5 retrospective. |

### Touched files

| Path | Change |
|---|---|
| `src/subagents/types.ts` | Widen `SubagentProfile.context` from `"fresh"` to `"fresh" \| "fork"`. Same in `SubagentFrontmatter` + `SubagentProfileSummary`. |
| `src/subagents/_validate.ts:38` | Replace hardcoded `context: "fresh"` with enum validation: accept `frontmatter.context === "fresh" \| "fork"`, default `"fresh"` when omitted, reject unknown values (return `null` → drop profile like other validation failures). |
| `src/subagents/subagent-service.ts:139-279` | Inside `spawn()`: after the depth check + child SessionRecord creation, branch on `input.profile.context`. If `"fork"`, load parent record (already loaded for depth in v1; v2 dropped that load — restore a single fresh `sessionStore.load(input.parentSessionId)`), call `cloneTranscriptSlice` + `buildSessionContext`, pass `.messages` to `buildChildSessionState`. If `"fresh"`, pass `[]` (current behavior). Also add `contextMode: input.profile.context` to the `subagent_link` entry payload and to `subagent_start` / `subagent_end` emits. |
| `src/subagents/build-child-state.ts:9-91` | `BuildChildSessionStateArgs` gains optional `messages?: AgentMessage[]` (default `[]`). Pass through to `createPiAgent({..., messages: args.messages ?? []})` — the wiring at `session-bootstrap.ts:281` already accepts it; just thread the value. |
| `src/sessions/entries.ts` | `SubagentLinkEntry` gains `contextMode: "fresh" \| "fork"`. Update the `SessionEntry` discriminated union; consumers narrow as needed. Per the CLAUDE.md rule, update `ai-docs/specs/bodhi-pi/lifecycle.md` SessionEntry table in the same commit. |
| `src/events/types.ts` | `SubagentStartEvent` + `SubagentEndEvent` gain `contextMode: "fresh" \| "fork"`. |
| `src/acp/event-wiring.ts` | If the wire forwarder destructures the event payload, add `contextMode` to the wire shape. Per the CLAUDE.md "both rails" rule, gated by `test/subagents-fork-lifecycle.test.ts`. |
| `src/sessions/in-memory-session-store.ts:59-79` | Refactor `forkRecord` to call `cloneTranscriptSlice(source.entries, { leafOrFromEntryId: fromEntryId, excludeTargetEntry: position === "before" })`. Behavior identical; just moves the `walkPath + slice` lines into the helper. No filter — v1 fork still copies all entry types. |
| `packages/bodhi-pi/test-apps/node-adapters/sessions/single-tenant/store.ts:173` | Same refactor. |
| `packages/bodhi-pi/test-apps/node-adapters/sessions/multi-tenant/store.ts:221` | Same refactor. |
| `src/tools/subagent.ts:17-29` | Refresh the tool description text: drop "Default context is fresh — the sub-agent does NOT see the parent conversation" line; replace with "Context behavior depends on the profile: `context: fresh` (default) starts the child with no parent history; `context: fork` clones the parent's transcript so the child can see prior context like read tool results." Schema unchanged. |
| `ai-docs/specs/bodhi-pi/subagents.md` | Frontmatter table: `context` enum widened to `"fresh" \| "fork"` with example bodies. New "Fork mode" sub-section: slice strategy (full filtered), filter list, pair-completeness note ("inherits the v1 `_bodhi-pi/session/fork` gap — slicing mid tool_call/tool_result pair may corrupt the child's history; future phase to harden"), sibling-relationship note with `_bodhi-pi/session/fork`. Per CLAUDE.md spec-drift rule, same-commit with C2. |
| `ai-docs/specs/bodhi-pi/lifecycle.md` | `SubagentLinkEntry` row gains `contextMode` column. |
| `ai-docs/specs/bodhi-pi/acp.md` | `LIFECYCLE_EVENT_METHOD notifications` section: `subagent_start` / `subagent_end` payloads gain `contextMode`. |
| `ai-docs/sub-agents/roadmap.md` | Mark P2a landed; promote next candidate. |
| `ai-docs/sub-agents/pending.md` | Update fork-mode row (now in P2a). |
| `ai-docs/sub-agents/v2-retrospective.md` | Add a one-line note that fork-mode landed in P2a follow-up. |

---

## Per-commit slice

### C1 — Shared `cloneTranscriptSlice` helper + 3-store refactor (behavior-preserving)

**Scope:** extract the slice primitive; refactor `sessionStore.forkRecord` to call it. Pure restructure — no fork-mode added yet.

**Files:** create `src/sessions/clone-slice.ts`, `test/clone-slice.test.ts`; modify `src/sessions/in-memory-session-store.ts`, `test-apps/node-adapters/sessions/single-tenant/store.ts`, `test-apps/node-adapters/sessions/multi-tenant/store.ts`.

**Steps:**
1. Write failing `test/clone-slice.test.ts` covering: walks-from-leaf, walks-from-arbitrary-entry, `excludeTargetEntry: true` drops the target, `excludeEntryTypes` filters, empty entries → `[]`, missing `leafOrFromEntryId` falls back to last entry.
2. Run → expect FAIL on import (helper doesn't exist).
3. Implement `cloneTranscriptSlice(entries, opts)` using `walkPath` from `build-context.ts`.
4. Refactor `in-memory-session-store.ts:59-79` to call the helper. Existing fork tests under `test/sessions-*.test.ts` + `bodhi-pi-http/test/integration/session-fork-clone.test.ts` should stay green (behavior preserved).
5. Refactor the two Node SQLite store impls. Run `npm test --workspaces` to gate.
6. Run `npm run check` → green.
7. Commit: `bodhi-pi sub-agents P2a: C1 — shared cloneTranscriptSlice helper + v1 fork refactor (behavior-preserving)`.

### C2 — Profile schema widening (`context: "fork"` accepted)

**Scope:** widen the enum at validation; widen all derived types. No spawn-flow changes yet.

**Files:** modify `src/subagents/types.ts`, `src/subagents/_validate.ts`; create `test/subagents-fork-schema.test.ts`; modify `ai-docs/specs/bodhi-pi/subagents.md` (frontmatter table).

**Steps:**
1. Write failing `test/subagents-fork-schema.test.ts`: assert `loadProjectSubagents` accepts `context: fork`; rejects `context: invalid`; defaults `"fresh"` when omitted.
2. Run → expect FAIL on validation.
3. Update `_validate.ts:38` to validate the enum.
4. Widen `SubagentProfile.context`, `SubagentFrontmatter.context`, `SubagentProfileSummary.context` in `types.ts` to `"fresh" \| "fork"`.
5. Update `ai-docs/specs/bodhi-pi/subagents.md` frontmatter table; add a stub "Fork mode" section noting "spawn-flow wiring lands in C3".
6. Verify existing `subagents-discovery.test.ts` + `subagents-builtin.test.ts` + `subagents-extension-profile.test.ts` still green.
7. Run `npm run check` → green.
8. Commit: `bodhi-pi sub-agents P2a: C2 — accept context: fork in profile schema`.

### C3 — Spawn-flow fork branch + entry/event widening + LLM tool description refresh

**Scope:** the load-bearing commit. `SubagentService.spawn` actually uses the slice; lifecycle events + `subagent_link` carry `contextMode`; tool description updated.

**Files:** modify `src/subagents/subagent-service.ts`, `src/subagents/build-child-state.ts`, `src/subagents/_clone-slice-filter.ts` (new), `src/sessions/entries.ts`, `src/events/types.ts`, `src/acp/event-wiring.ts`, `src/tools/subagent.ts`; create `test/subagents-fork.test.ts`, `test/subagents-fork-lifecycle.test.ts`; update `ai-docs/specs/bodhi-pi/subagents.md` (fill in "Fork mode" section), `ai-docs/specs/bodhi-pi/lifecycle.md` (SubagentLinkEntry row), `ai-docs/specs/bodhi-pi/acp.md` (LIFECYCLE_EVENT_METHOD payloads).

**Steps:**
1. Write failing `test/subagents-fork.test.ts` covering: (a) parent runs N turns (read tool + text); spawn a `context: fork` profile; the faux provider for the child captures `ctx.messages` and the test asserts the captured messages contain the parent's prior user turns + assistant + tool_result blocks; (b) `subagent_link` SessionEntry on the child carries `contextMode: "fork"`; (c) `mcp_inclusion_set` and `extension` entries seeded on the parent are NOT in the child's messages.
2. Write failing `test/subagents-fork-lifecycle.test.ts`: capture `harness.extNotifications`; assert the `subagent_start` and `subagent_end` wire payloads carry `contextMode: "fork"`. This gates the both-rails rule.
3. Run both → expect FAIL.
4. Create `src/subagents/_clone-slice-filter.ts` exporting `SUBAGENT_FORK_FILTER`.
5. Modify `SubagentLinkEntry` in `src/sessions/entries.ts` to add required `contextMode: "fresh" \| "fork"` (required, not optional — every new spawn writes it; pre-v2 records won't be read for spawning so no migration needed, same logic as the C3b subagentDepth decision from v2).
6. Modify `SubagentStartEvent` + `SubagentEndEvent` in `src/events/types.ts` to add `contextMode`.
7. Modify `src/acp/event-wiring.ts` to forward `contextMode` if the wire forwarder explicitly destructures fields.
8. Modify `src/subagents/build-child-state.ts:9-91` to accept optional `messages?: AgentMessage[]` (default `[]`) on `BuildChildSessionStateArgs`; pass through to `createPiAgent`.
9. Modify `src/subagents/subagent-service.ts:139-279`:
   - After the depth-check + child-record-create, compute `let messages: AgentMessage[] = []`.
   - If `input.profile.context === "fork"`: `const parentRecord = await this.sessionStore.load(input.parentSessionId)`; call `cloneTranscriptSlice(parentRecord!.entries, { leafOrFromEntryId: parentRecord!.leafId, excludeEntryTypes: SUBAGENT_FORK_FILTER })`; pass the sliced entries through `buildSessionContext({entries: cloned, leafId: null})`; assign `messages = ctx.messages`.
   - Pass `messages` into `buildChildSessionState({...args, messages})`.
   - Add `contextMode: input.profile.context` to the `subagent_link` entry construction.
   - Add `contextMode: input.profile.context` to both `events.emit({type: "subagent_start", ...})` and the `subagent_end` emit.
10. Refresh `src/tools/subagent.ts` tool description text (line 17-29 area) to describe per-profile context behavior.
11. Update specs: `subagents.md` "Fork mode" section (slice strategy, filter list, pair-completeness note, sibling relationship); `lifecycle.md` SubagentLinkEntry row; `acp.md` LIFECYCLE_EVENT_METHOD payloads.
12. Run focused tests: `npx vitest run test/subagents-fork.test.ts test/subagents-fork-lifecycle.test.ts test/subagents-fork-schema.test.ts test/subagents-spawn.test.ts test/subagents-builtin.test.ts test/subagents-cancellation.test.ts test/subagents-depth-cache.test.ts test/subagents-llm-invocation.test.ts test/subagents-discovery.test.ts test/subagents-list-extmethod.test.ts test/subagents-extension-profile.test.ts test/clone-slice.test.ts test/sessions-subagent-filter.test.ts` — all green.
13. Run full `npx vitest run` and `npm run check` → green.
14. Commit: `bodhi-pi sub-agents P2a: C3 — context: fork spawn flow + lineage on entry/events`.

### C4 — e2e + e2e-ui across all four runtimes

**Scope:** prove the fork path reaches a real LLM and a real UI on every Host.

**Files:** create `e2e/shared/subagents-fork.e2e.ts`, `e2e/data/subagents-fork/{diff.md, .bodhi-pi/agents/reviewer.md}`, `e2e-ui/shared/subagents-fork.spec.ts`, `e2e-ui/data/subagents-fork/{diff.md, .bodhi-pi/agents/reviewer.md}`.

**Steps:**
1. Author the `reviewer.md` profile fixture: `context: fork`, `tools: [read]`, body says "you are a code reviewer; review the diff the parent just showed you and report any issues — do not re-read files the parent already loaded."
2. Author `diff.md` with a clear, citable fact (e.g. a removed function name `oldLegacyHelper` + added function `BLUE_FORK_42_handler` — the assertion checks the child mentions `BLUE_FORK_42_handler` after the parent reads the file).
3. `e2e/shared/subagents-fork.e2e.ts`: parent prompt "use the `read` tool to fetch `${h.cwd}/diff.md`, then ask the reviewer sub-agent to review it"; assert the parent's final response mentions `BLUE_FORK_42_handler` (proxy for the child having seen the parent's read output without the task body re-stating it).
4. `e2e-ui/shared/subagents-fork.spec.ts`: (a) slash-dispatch path — seed fixture, send `/subagent reviewer review the diff I just read`, assert the result text contains `BLUE_FORK_42_handler`; (b) natural-language path — free-text prompt to trigger LLM-invocation of the subagent tool, same assertion.
5. Run `just test-e2e` + `just test-e2e-ui` (gated on `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` in CI).
6. Commit: `bodhi-pi sub-agents P2a: C4 — e2e + e2e-ui coverage for fork mode (slash + LLM-invocation paths)`.

### C5 — Retrospective + roadmap refinement

**Files:** create `ai-docs/sub-agents/p2a-retrospective.md`; modify `ai-docs/sub-agents/roadmap.md`, `ai-docs/sub-agents/pending.md`, `ai-docs/sub-agents/v2-retrospective.md`.

**Steps:**
1. Write `p2a-retrospective.md` (mirror v2 shape): what shipped, surprises, what to carry forward.
2. Update `roadmap.md`: mark P2a landed; promote P2b (parallel batch) as next candidate per existing order.
3. Update `pending.md`: cross out fork-mode entries; add any new deferred items.
4. Add a one-line "P2a landed YYYY-MM-DD — see p2a-retrospective.md" note to `v2-retrospective.md`'s "Items for v3 / future" section.
5. Commit: `bodhi-pi sub-agents P2a: C5 — retrospective + roadmap refinement`.

---

## Verification matrix

Run after each commit; final commit additionally runs the full e2e juicers.

| Slice | Per-Host command |
|---|---|
| C1 | `npx vitest run test/clone-slice.test.ts test/sessions-*.test.ts` + `npm test -w @bodhiapp/bodhi-pi-test-app-node-adapters` + `npm test -w @bodhiapp/bodhi-pi-http` (covers session-fork-clone integration) + `npm run check` |
| C2 | `npx vitest run test/subagents-fork-schema.test.ts test/subagents-discovery.test.ts test/subagents-builtin.test.ts test/subagents-extension-profile.test.ts` + `npm run check` |
| C3 | `npx vitest run` (full bodhi-pi suite) + `npm run check` |
| C4 direct-ACP + cli e2e | `just test-e2e` (filter `subagents-fork`) |
| C4 Playwright | `just test-e2e-ui` (browser + chrome-ext + http projects) |
| Final gate | `npm run check` + `npm test` (all workspaces) + `just test-e2e` + `just test-e2e-ui` |

---

## Risk register

1. **Mid-pair tool_call slicing** — per the user-locked decision, we inherit the existing `_bodhi-pi/session/fork` gap: a slice that ends mid-pair (tool_call without matching tool_result) can corrupt the child's message history when pi-agent-core hydrates. Mitigation: parent's typical fork-spawn timing is at end-of-turn (LLM emits the `subagent` tool_use; all prior tool_call/result pairs are complete by then). Documented in `subagents.md` "Fork mode" section as a known limitation; future phase to harden if it bites.
2. **Pre-v2 child SessionRecord rehydration loses `contextMode`** — same trade-off as the C3b `subagentDepth` decision: no production yet, so no backfill. A pre-P2a child rehydrated post-P2a reads `contextMode` as `undefined`; the type narrowing makes this a compile error if relied on, so the runtime accepts the gap. Documented in the C3 commit body.
3. **`buildSessionContext` returns model/thinking/mcpInclusion that we discard** — intentional; the child's profile is the source of truth for those. Risk: if a future change makes `buildSessionContext` mandatory for those fields, we'd need to revisit. Mitigation: explicit destructuring in `SubagentService.spawn` makes the discard visible.
4. **Tool-list mismatch between parent and child under fork** — parent's history may reference tools the child's profile doesn't allowlist (e.g. parent used `write` but fork profile is read-only). The LLM sees the prior tool_call/result as text and understands them; it just can't re-invoke them. Acceptable. Documented in spec.
5. **The 3-store refactor in C1 risks regressing v1 `_bodhi-pi/session/fork`** — mitigation: existing `bodhi-pi-http/test/integration/session-fork-clone.test.ts` + `e2e/shared/fork-clone.e2e.ts` cover this. Both gate C1.
6. **`SubagentLinkEntry.contextMode` becoming required (not optional) on the entry schema** — pre-P2a entries lack the field. The narrowing makes consumer code break loudly. Per the v2 precedent (subagentDepth) and the user's "no migration / no backfill / no production" stance, this is acceptable. If the developer has pre-P2a children in local SQLite, wipe-and-reseed is the workaround.
7. **Spec drift** — per `packages/bodhi-pi/CLAUDE.md`, ACP-surface / lifecycle / SessionEntry changes need same-commit spec updates. C2 and C3 both touch specs; verify in commit-staging.

---

## Out of scope

Explicitly deferred to later phases:

- **Per-call `slice: {...}` override** — ship with a single default slice strategy (full filtered).
- **Pair-completeness hardening** (`buildFunctionResponseParts`-style placeholder injection) — future phase if the gap bites.
- **Selected-transcript-slice context mode** (`context: "slice"` with explicit entry-id range) — future, no current phase.
- **P2b parallel batch** — separate kickoff.
- **P3a background runs** — separate kickoff.
- **P3c MCP allow/deny for children**, **P3d skill inheritance** — child schema unchanged.
- **P4a worktree isolation**, **P4c workflow handoff** — out of phase 2.
- **Workflow-handoff mode** (named-specialist routing within one session, conceptually distinct from sub-agent fork).
- **`scriptSubagentRun` test helper**, **`ChatPanelPage.systemMessageWithEvent` Playwright helper** — still deferred from v1 retrospective.

---

## When done

Print: the plan path, the count of resolved open questions (4), and the proposed commit subjects in order:

1. `bodhi-pi sub-agents P2a: C1 — shared cloneTranscriptSlice helper + v1 fork refactor (behavior-preserving)`
2. `bodhi-pi sub-agents P2a: C2 — accept context: fork in profile schema`
3. `bodhi-pi sub-agents P2a: C3 — context: fork spawn flow + lineage on entry/events`
4. `bodhi-pi sub-agents P2a: C4 — e2e + e2e-ui coverage for fork mode (slash + LLM-invocation paths)`
5. `bodhi-pi sub-agents P2a: C5 — retrospective + roadmap refinement`

Plan IS the deliverable. Implementation runs in a separate session, ideally guided by `superpowers:executing-plans` or `superpowers:subagent-driven-development`.
