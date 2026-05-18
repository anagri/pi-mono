# bodhi-pi sub-agents P2a — forked context

> Plan-mode forced this file path. On approval, rename to
> `ai-docs/plans/2026-05-18-bodhi-pi-sub-agents-p2a-forked-context.md` (per repo convention; see `ai-docs/plans/`).
>
> Trunk-based per `packages/bodhi-pi/CLAUDE.md`: each commit lands directly on `main` and must be individually green. No PRs.
>
> Refined remotely via Ultraplan (session `session_011V77TU1SMCGaq3VrpwgN13`) and approved by the user.

## Context

V2 shipped bundled built-ins, extension-registered profiles, and the v1 carry-forward triplet (see `ai-docs/sub-agents/v2-retrospective.md`). The `SubagentProfile.context` field is typed `"fresh"` only, hardcoded by `validateAndNormalizeProfile` (`src/subagents/_validate.ts:43`), and `SubagentService.spawn` builds the child with `messages: []` (`src/subagents/build-child-state.ts:50`).

P2a fills in the missing `fork` mode so a sub-agent can see a slice of the parent's transcript. Motivating use cases: "review this diff", "continue this investigation", "verify the plan against the spec" — tasks where the parent already loaded relevant tool results (e.g. file reads) the child shouldn't have to re-fetch.

The existing `_bodhi-pi/session/fork` (`SessionGraphService.handleSessionFork` → `sessionStore.forkRecord`) is a sibling concept: same shape (walk the parent's parentId chain, take a slice), different user-facing semantics (session-fork preserves the full session shape; subagent-fork is profile-constrained and drops session-management entries).

## Locked decisions

| Decision | Resolution |
|---|---|
| Slice strategy | Full parent transcript (path from root to parent's current leaf), filtered to drop session-management noise |
| Filter | `SUBAGENT_FORK_FILTER = {mcp_inclusion_set, extension, subagent_link, subagent_complete}` |
| Mid-pair `tool_call`/`tool_result` enforcement | Inherit existing `_bodhi-pi/session/fork` gap (no enforcement) |
| LLM-facing fork toggle | None — profile decides. `subagent` tool schema unchanged |
| Recursion blocking | Depth-cap only (children still don't get the `subagent` tool, see `build-child-state.ts:32`) |
| Task placement | Existing append-as-new-user-prompt (`subagent-service.ts:218`) — no change |
| Lineage on entry + events | `contextMode: "fresh" \| "fork"` on `SubagentLinkEntry`, `SubagentStartEvent`, `SubagentEndEvent` |
| Spec drift | C2 and C3 each carry same-commit spec updates per CLAUDE.md rule |

## Refinements from Ultraplan exploration (deltas from the draft)

1. **SQLite store refactor dropped.** `test-apps/node-adapters/sessions/{single,multi}-tenant/store.ts` walks `{row, entry}` tuple chains so it can re-insert the raw DB `payload` column. A `cloneTranscriptSlice(entries) → SessionEntry[]` doesn't fit without re-serializing. Refactor only the in-memory store in C1; leave SQLite stores' inline walk alone. The in-memory + SQLite walking remain behavior-equivalent; flag the duplication in the risk register.
2. **`event-wiring.ts` needs no edit.** `appendHandlers("subagent_start", [(e) => notifyLifecycle(e as unknown as Record<string, unknown>)])` (`src/acp/event-wiring.ts:63-64`) forwards the entire event object. Adding `contextMode` to `SubagentStartEvent`/`SubagentEndEvent` flows automatically.
3. **Wire test piggy-backs on existing file.** `test/subagents-wire-events.test.ts` already asserts the wire shape. Extend that file with a `contextMode` assertion rather than creating `subagents-fork-lifecycle.test.ts`.
4. **`buildSessionContext` return.** Confirmed: returns `{messages, currentModelId, currentThinkingLevel, name, mcpInclusion}` (`src/sessions/build-context.ts:7-14`). Take `.messages` only.
5. **Parent record load.** `SubagentService.spawn` already has `parent: SessionState` but that doesn't carry entries — must call `sessionStore.load(input.parentSessionId)` once when `context === "fork"`.
6. **No built-in profile file changes.** `EXPLORE_PROFILE`/`PLANNER_PROFILE` declare `context: "fresh"` as const-literals; widening the type to `"fresh" | "fork"` keeps them valid.
7. **Playwright lives under `e2e-ui/shared/`.** No `test-apps/<host>/e2e/` dirs — Playwright specs go in `packages/bodhi-pi/e2e-ui/shared/*.spec.ts` and run across the browser + chrome-ext + http projects via Playwright's project matrix.

## Shape of the change

```
                   ┌───────────────────────────────────────────────────────────┐
                   │ Profile loader (markdown + extension + builtin)           │
                   │   validateAndNormalizeProfile reads frontmatter.context   │
                   │   enum: "fresh" | "fork"  (default "fresh", reject other) │
                   └────────────────────────────┬──────────────────────────────┘
                                                │ SubagentProfile.context
                                                ▼
SubagentService.spawn(input)                                 ◀── input.profile.context drives the branch
  │
  ├── if "fresh": messages = []                              (existing path)
  │
  └── if "fork":
        ├── sessionStore.load(input.parentSessionId)         → SessionRecord
        ├── cloneTranscriptSlice(record.entries, {           ◀── new helper, src/sessions/clone-slice.ts
        │     leafOrFromEntryId: record.leafId,              │   pure; also called by in-memory store's forkRecord
        │     excludeEntryTypes: SUBAGENT_FORK_FILTER,       │   filter co-located in src/subagents/_clone-slice-filter.ts
        │   })                                                │
        ├── buildSessionContext({entries: sliced, leafId:null}) → {messages, ...discarded}
        └── messages = ctx.messages
  │
  ▼
buildChildSessionState(..., {messages})                       ◀── new optional arg, defaults to []
  │
  ▼
createPiAgent({..., messages})                                (already accepts AgentMessage[])

Lineage:
  SubagentLinkEntry.contextMode = input.profile.context     (written when the entry is created in spawn)
  SubagentStartEvent.contextMode = input.profile.context    (emit before promptLoop)
  SubagentEndEvent.contextMode = input.profile.context      (emit after promptLoop)
  event-wiring forwards both untouched → LIFECYCLE_EVENT_METHOD wire payload
```

## File inventory

### New

| Path | Purpose |
|---|---|
| `packages/bodhi-pi/src/sessions/clone-slice.ts` | `cloneTranscriptSlice(entries: SessionEntry[], opts): SessionEntry[]` — composes `walkPath` + optional `slice(0, -1)` for "before" + optional entry-type filter. Pure. |
| `packages/bodhi-pi/src/subagents/_clone-slice-filter.ts` | `SUBAGENT_FORK_FILTER: Set<SessionEntry["type"]>` — the four types subagent fork drops. |
| `packages/bodhi-pi/test/clone-slice.test.ts` | Unit: walk-from-leaf, walk-from-arbitrary-entry, `excludeTargetEntry`, `excludeEntryTypes`, empty entries, missing `leafOrFromEntryId` falls back to last entry. |
| `packages/bodhi-pi/test/subagents-fork.test.ts` | Integration: faux provider captures `state.messages` on the child agent and verifies (a) parent transcript reached the child, (b) `subagent_link.contextMode = "fork"`, (c) seeded `mcp_inclusion_set`/`extension` entries are filtered out. |
| `packages/bodhi-pi/test/subagents-fork-schema.test.ts` | Profile-schema: frontmatter `context: fork` accepted; `context: invalid` dropped; omitted defaults to `"fresh"`. |
| `packages/bodhi-pi/e2e/shared/subagents-fork.e2e.ts` | gpt-4o-mini: seed a `diff.md` with sentinel `BLUE_FORK_42`; parent uses `read`; spawns a `context: fork` profile; assert the parent's final response mentions the sentinel (proves the child saw the parent's tool_result). |
| `packages/bodhi-pi/e2e/data/subagents-fork/diff.md` | Seed fixture with the sentinel fact. |
| `packages/bodhi-pi/e2e/data/subagents-fork/.bodhi-pi/agents/reviewer.md` | Project profile fixture with `context: fork`, `tools: [read]`. |
| `packages/bodhi-pi/e2e-ui/shared/subagents-fork.spec.ts` | Playwright mirror: slash-dispatch (`/subagent reviewer ...`) + natural-language paths; assert result message contains the sentinel. |
| `packages/bodhi-pi/e2e-ui/data/subagents-fork/diff.md` | Mirror seed. |
| `packages/bodhi-pi/e2e-ui/data/subagents-fork/.bodhi-pi/agents/reviewer.md` | Mirror profile. |
| `ai-docs/sub-agents/p2a-retrospective.md` | C5 retrospective. |

### Touched

| Path | Change |
|---|---|
| `src/subagents/types.ts` | Widen `SubagentProfile.context`, `SubagentFrontmatter.context`, `SubagentProfileSummary.context` from `"fresh"` to `"fresh" \| "fork"`. |
| `src/subagents/_validate.ts:43` | Replace hardcoded `context: "fresh"` with enum validation: accept `"fresh"` / `"fork"`, default `"fresh"` when omitted, return `null` (drop profile) on any other value. |
| `src/subagents/subagent-service.ts:139-279` | Inside `spawn()`: branch on `input.profile.context`. If `"fork"`, load `sessionStore.load(input.parentSessionId)`, call `cloneTranscriptSlice(record.entries, {leafOrFromEntryId: record.leafId, excludeEntryTypes: SUBAGENT_FORK_FILTER})`, run through `buildSessionContext({entries: sliced, leafId: null})`, take `.messages`. Pass to `buildChildSessionState`. Add `contextMode: input.profile.context` to: the `subagent_link` entry construction (`:157-167`), `events.emit("subagent_start", ...)` (`:201-209`), `events.emit("subagent_end", ...)` (`:257-267`). |
| `src/subagents/build-child-state.ts:9-91` | `BuildChildSessionStateArgs` gains optional `messages?: AgentMessage[]` (default `[]`). Thread to `createPiAgent({..., messages: args.messages ?? []})` (the createPiAgent call site at `:45-56` already passes `messages`). |
| `src/sessions/entries.ts` | `SubagentLinkEntry` gains required `contextMode: "fresh" \| "fork"`. (Required, not optional — same precedent as v2's `subagentDepth`; no production data to backfill.) |
| `src/events/types.ts` | `SubagentStartEvent` + `SubagentEndEvent` gain `contextMode: "fresh" \| "fork"`. |
| `src/sessions/in-memory-session-store.ts:59-79` | Refactor `forkRecord` to call `cloneTranscriptSlice(source.entries, {leafOrFromEntryId: fromEntryId, excludeTargetEntry: position === "before"})`. Behavior identical. (SQLite stores left alone — see refinement #1.) |
| `src/tools/subagent.ts:20-29` | Tool description refresh: drop the "Default context is fresh" sentence; replace with "Context behavior is decided by the profile (`context: fresh` starts the child with no parent history; `context: fork` clones the parent's transcript). Schema is unchanged." |
| `test/subagents-wire-events.test.ts` | Add `contextMode: "fork"` assertion to the existing start/end notification test (seed a `context: fork` profile in a second test case alongside the existing `echo` one). |
| `ai-docs/specs/bodhi-pi/subagents.md` | Frontmatter table: `context` enum widened to `"fresh" \| "fork"`. New "Fork mode" subsection: slice strategy (full filtered), filter list, pair-completeness inherited-gap note, sibling-relationship note with `_bodhi-pi/session/fork`. Update the `context: fresh` paragraph that currently says "real `context` discriminator returns when P2a (forked context) ships" — note that P2a chose not to surface it on the LLM tool. |
| `ai-docs/specs/bodhi-pi/lifecycle.md:20` | `subagent_link` row gains `contextMode` in the payload column. |
| `ai-docs/specs/bodhi-pi/acp.md:129-130` | `subagent_start`/`subagent_end` payloads gain `contextMode`. |
| `ai-docs/sub-agents/roadmap.md` | Mark P2a landed; promote next candidate (P2b). |
| `ai-docs/sub-agents/pending.md` | Cross out fork-mode entries; surface any new deferred items. |
| `ai-docs/sub-agents/v2-retrospective.md` | One-line "P2a landed YYYY-MM-DD" note in the "Items for v3 / future" section. |

## Per-commit slices

### C1 — `cloneTranscriptSlice` helper + in-memory store refactor

Behavior-preserving extract. No fork mode yet.

1. Write failing `test/clone-slice.test.ts`.
2. Implement `cloneTranscriptSlice` in `src/sessions/clone-slice.ts` using `walkPath` from `src/sessions/build-context.ts:21`.
3. Refactor `src/sessions/in-memory-session-store.ts:59-79` to call the helper. Existing fork tests (`test/sessions-*.test.ts`, `bodhi-pi-http/test/integration/session-fork-clone.test.ts`, `e2e/shared/fork-clone.e2e.ts`) gate behavior preservation.
4. `npm run check` + `npx vitest run` from `packages/bodhi-pi` + workspace tests for `bodhi-pi-http` → green.
5. Commit subject: `bodhi-pi sub-agents P2a: C1 — shared cloneTranscriptSlice helper + in-memory store refactor`.

### C2 — Accept `context: fork` in profile schema

Schema widening only. No spawn-flow changes.

1. Write failing `test/subagents-fork-schema.test.ts` (uses `seedSubagent` helper + `loadProjectSubagents`).
2. Widen the three `context` type fields in `src/subagents/types.ts`.
3. Update `src/subagents/_validate.ts:43` to validate the enum (`"fresh"`, `"fork"`, default `"fresh"`, else return `null`).
4. Update `ai-docs/specs/bodhi-pi/subagents.md` frontmatter table + add a stub "Fork mode" section noting "spawn-flow wiring lands in C3".
5. Verify `subagents-discovery.test.ts`, `subagents-builtin.test.ts`, `subagents-extension-profile.test.ts` still pass — the const-literal `context: "fresh"` in `profiles/{explore,planner}.ts` remains valid under the widened union.
6. `npm run check` + targeted vitest → green.
7. Commit subject: `bodhi-pi sub-agents P2a: C2 — accept context: fork in profile schema`.

### C3 — Spawn-flow fork branch + lineage + tool description

Load-bearing commit. Wires the actual fork behavior; lifecycle and link carry `contextMode`; LLM tool description updated.

1. Write failing `test/subagents-fork.test.ts`:
   - Setup: in-memory FS, `seedSubagent("/proj", "reviewer", "---\ndescription: review\ncontext: fork\n---\nbody")`, faux provider on parent (issues read tool + assistant text + `subagent` tool_call), separate faux provider on child that captures the `messages` it receives.
   - Assert: child's captured `messages` contains the parent's prior `user` + `assistant` + `tool_result` blocks for the parent's `read` invocation.
   - Assert: `subagent_link.contextMode === "fork"` on the child's persisted record.
   - Assert: pre-seeded `mcp_inclusion_set` and `extension` entries on the parent do NOT appear in the captured `messages`.
2. Add a `context: fork` assertion in `test/subagents-wire-events.test.ts` — a second test scenario alongside the existing `echo` one, verifying `subagent_start.contextMode === "fork"` and `subagent_end.contextMode === "fork"` on the wire payload.
3. Create `src/subagents/_clone-slice-filter.ts` exporting `SUBAGENT_FORK_FILTER`.
4. Modify `src/sessions/entries.ts`: add required `contextMode: "fresh" \| "fork"` to `SubagentLinkEntry`.
5. Modify `src/events/types.ts`: add `contextMode` to `SubagentStartEvent` and `SubagentEndEvent`.
6. Modify `src/subagents/build-child-state.ts`: `BuildChildSessionStateArgs` gains optional `messages?: AgentMessage[]`; thread into `createPiAgent`.
7. Modify `src/subagents/subagent-service.ts:139-279`:
   - After `childRecord` creation, compute `let messages: AgentMessage[] = []`.
   - If `input.profile.context === "fork"`: `const parentRecord = await this.sessionStore.load(input.parentSessionId)`; assert non-null; `const sliced = cloneTranscriptSlice(parentRecord.entries, {leafOrFromEntryId: parentRecord.leafId, excludeEntryTypes: SUBAGENT_FORK_FILTER})`; `messages = buildSessionContext({entries: sliced, leafId: null}).messages`.
   - Pass `messages` into `buildChildSessionState(...)`.
   - Set `contextMode: input.profile.context` on the `subagent_link` entry, on the `subagent_start` emit, and on the `subagent_end` emit.
8. Refresh `src/tools/subagent.ts:20-29` description text (per the file inventory entry above). Schema untouched.
9. Update specs: `subagents.md` "Fork mode" section, `lifecycle.md:20` row, `acp.md:129-130` payloads.
10. Run focused vitest:
    `npx vitest run test/clone-slice.test.ts test/subagents-fork.test.ts test/subagents-fork-schema.test.ts test/subagents-wire-events.test.ts test/subagents-spawn.test.ts test/subagents-builtin.test.ts test/subagents-cancellation.test.ts test/subagents-depth-cache.test.ts test/subagents-llm-invocation.test.ts test/subagents-discovery.test.ts test/subagents-list-extmethod.test.ts test/subagents-extension-profile.test.ts test/sessions-subagent-filter.test.ts`
11. Then `npx vitest run` (full bodhi-pi) + `npm run check` → green.
12. Commit subject: `bodhi-pi sub-agents P2a: C3 — context: fork spawn flow + lineage on entry/events`.

### C4 — e2e + e2e-ui parity

Real-LLM coverage across the runtime matrix (in-memory / cli / http / ws) and Playwright coverage across browser + chrome-ext + http.

1. Write `e2e/data/subagents-fork/.bodhi-pi/agents/reviewer.md`:
   `---\ndescription: review the diff the parent just read\ncontext: fork\ntools: [read]\n---\nYou are a code reviewer. The parent already loaded the diff; do NOT re-read it. Report any issues you see in the diff, citing specific symbols.`
2. Write `e2e/data/subagents-fork/diff.md` with sentinel `BLUE_FORK_42_handler` (the assertion checks the child surfaces this without the task re-stating it).
3. Write `e2e/shared/subagents-fork.e2e.ts` modeled on `subagents.e2e.ts`: parent prompt instructs `read` of `${h.cwd}/diff.md` then invokes the `reviewer` sub-agent. Soft-assert the parent's final response contains `BLUE_FORK_42_handler`.
4. Write `e2e-ui/data/subagents-fork/{.bodhi-pi/agents/reviewer.md, diff.md}` mirrors.
5. Write `e2e-ui/shared/subagents-fork.spec.ts` modeled on `subagents.spec.ts`. Two scenarios in one flow-consolidated test (per `e2e/CLAUDE.md` "When to flow-consolidate"): (a) `/subagent reviewer review the diff` after the parent reads it; (b) natural-language prompt that triggers the LLM to invoke the sub-agent. Assert `data-subagent-event="run-result"` contains `BLUE_FORK_42_handler` in both.
6. Run `just test-e2e` (filter `subagents-fork`) + `just test-e2e-ui` (browser + chrome-ext + http projects).
7. Commit subject: `bodhi-pi sub-agents P2a: C4 — e2e + e2e-ui coverage for fork mode`.

### C5 — Retrospective + roadmap refinement

1. Write `ai-docs/sub-agents/p2a-retrospective.md` (mirror v2-retrospective shape).
2. Update `roadmap.md`: mark P2a landed; promote P2b (parallel batch) as next candidate.
3. Update `pending.md`: remove fork-mode lines; add any new deferred items surfaced during execution.
4. Add a one-line P2a landed note to `v2-retrospective.md`'s "Items for v3 / future" section.
5. Commit subject: `bodhi-pi sub-agents P2a: C5 — retrospective + roadmap refinement`.

## Verification

Run after each commit. Final commit additionally runs the full e2e + e2e-ui matrices.

| Slice | Commands |
|---|---|
| C1 | `npx vitest run test/clone-slice.test.ts test/sessions-*.test.ts` (in `packages/bodhi-pi`) + `npm test -w @bodhiapp/bodhi-pi-http` (covers `session-fork-clone` integration) + `npm run check` |
| C2 | `npx vitest run test/subagents-fork-schema.test.ts test/subagents-discovery.test.ts test/subagents-builtin.test.ts test/subagents-extension-profile.test.ts` + `npm run check` |
| C3 | full `npx vitest run` in `packages/bodhi-pi` + `npm run check` |
| C4 (e2e) | `just test-e2e` (filter `subagents-fork`); requires `OPENAI_API_KEY` |
| C4 (e2e-ui) | `just test-e2e-ui` (browser + chrome-ext + http Playwright projects); requires `OPENAI_API_KEY` |
| Final | `npm run check` + `npm test --workspaces` + `just test-e2e` + `just test-e2e-ui` |

## Risk register

1. **Mid-pair tool_call slicing.** Slicing at an arbitrary leaf may leave a tool_call without its tool_result (or vice versa); pi-agent-core's message hydration can choke. Inherits the existing `_bodhi-pi/session/fork` gap. Practical mitigation: the parent typically spawns at end-of-turn (the LLM emits the `subagent` tool_use after prior tool_call/result pairs complete). Documented in `subagents.md` "Fork mode" as a known limitation; revisit if it bites.
2. **`SubagentLinkEntry.contextMode` becomes required.** Pre-P2a child records lack the field. Per the v2 `subagentDepth` precedent (no production yet, no backfill), this is acceptable. A pre-P2a child rehydrated post-P2a reads `contextMode` as `undefined`; consumer code (subagent/children listing) handles it as a missing optional in the output payload, but the entry type itself fails type narrowing — call this out in the commit body.
3. **`buildSessionContext` discards model/thinking/mcpInclusion/name.** Intentional; the child's profile is the source of truth for model + thinking, and MCP inclusion is per-session. Explicit destructuring of `.messages` makes the discard visible at the call site.
4. **Tool-list mismatch between parent and child under fork.** Parent's history may reference tools the child's profile doesn't allowlist. The LLM reads the prior tool_call/result as text and understands them; it just can't re-invoke. Acceptable; documented in spec.
5. **SQLite store walking divergence.** C1 refactors only the in-memory store; SQLite stores keep their inline `{row, entry}` walk for re-insertion. The two walks remain behavior-equivalent today but no shared helper enforces that. Document in C1 commit body; future commit can extract a generic `walkPathBy<T>(items, getId, getParentId, leafId)` if the inline walks ever drift.
6. **Spec drift.** ACP/lifecycle/SessionEntry changes require same-commit spec updates per `packages/bodhi-pi/CLAUDE.md`. C2 updates `subagents.md`; C3 updates `subagents.md`, `lifecycle.md`, `acp.md`. Verify at commit-staging time.

## Out of scope

- Per-call `slice: {...}` override on the LLM tool.
- Pair-completeness hardening (placeholder injection for orphan tool_call/tool_result).
- `context: "slice"` with explicit entry-id range.
- P2b (parallel batch), P3a (background runs), P3c (MCP allow/deny), P3d (skill inheritance), P4a (worktree isolation), P4c (workflow handoff).
- `scriptSubagentRun` helper, `ChatPanelPage.systemMessageWithEvent` Playwright helper (still deferred from v1).
