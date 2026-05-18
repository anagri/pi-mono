# Sub-agents P2a retrospective

P2a landed 2026-05-18 as five commits on `main`:

- `bb17df96` — kickoff plan (Ultraplan-refined)
- `87ab9b2e` — C1: shared `cloneTranscriptSlice` helper + in-memory store refactor
- `7d5bfd18` — C2: accept `context: fork` in profile schema
- `764cb275` — C3: `context: fork` spawn flow + lineage on entry/events
- `0200ffda` — C4: e2e + e2e-ui coverage for fork mode
- `<this commit>` — C5: retrospective + roadmap refinement

A `705fb342` cleanup commit dropped the stale plan-mode-forced filename leftover from the kickoff rename (the `git mv` in C0 got recorded as add-only).

## What shipped

- **`context: "fork"` profile mode** — `SubagentFrontmatter.context` and `SubagentProfile.context` widened from `"fresh"` only to `"fresh" | "fork"`. Default remains `"fresh"` when omitted; unknown values are dropped at parse via `validateAndNormalizeProfile`.
- **Shared `cloneTranscriptSlice` helper** in `src/sessions/clone-slice.ts` — composes `walkPath` + optional `slice(0, -1)` for "before" semantics + optional entry-type filter. Pure, runtime-neutral.
- **`SUBAGENT_FORK_FILTER`** in `src/subagents/_clone-slice-filter.ts` — drops `mcp_inclusion_set`, `extension`, `subagent_link`, `subagent_complete` entries from the child's view. Co-located with the subagent domain so the filter sits one grep away from `SubagentService.spawn`.
- **`SubagentService.spawn` fork branch** — when `input.profile.context === "fork"`, loads the parent's `SessionRecord` once, slices via the helper, converts to `AgentMessage[]` via `buildSessionContext({entries: sliced, leafId: null}).messages`, and passes them as the child's initial `messages`. Fresh profiles keep the existing empty-messages path.
- **Lineage on both rails** — `SubagentLinkEntry.contextMode`, `SubagentStartEvent.contextMode`, `SubagentEndEvent.contextMode`. Wire forwarding flows automatically because `event-wiring.ts` spreads the whole event object via `notifyLifecycle`.
- **LLM-facing tool surface unchanged** — `subagent({agent, task, model?})` stays as-is per the C0 reviewer rule + the Ultraplan exploration's finding that cc has no equivalent per-call toggle. The profile is the source of truth. Tool description text refreshed to explain per-profile context behavior; profile bullets in the available-profiles list now include `(context: fresh|fork)` so the LLM sees lineage.
- **In-memory store refactor** — `forkRecord` calls `cloneTranscriptSlice` with no entry-type filter. Behavior identical; existing `session-fork-clone` integration + `fork-clone` e2e gate that.
- **e2e + e2e-ui coverage** — `subagents-fork.e2e.ts` (shared across in-memory / cli / http / ws) + `subagents-fork.spec.ts` (Playwright across browser / chrome-ext / http). The sentinel `BLUE_FORK_42_handler` in `diff.md` proves the child surfaces a fact the task body never mentioned.

## Surprises

- **The Ultraplan exploration found my draft was wrong about cc/Mastra/Gemini's slice strategy.** I'd recommended "last-user-prompt + last assistant only" in the kickoff prompt; the research showed all three upstream tools clone the FULL parent conversation. The user-confirmed answer ended up being "full filtered" — closer to the upstream norm. Folded into the Ultraplan-refined plan before C1; never reached implementation.
- **`_bodhi-pi/session/fork` has the same mid-pair gap.** The existing v1 fork has NO `tool_call`/`tool_result` pair-completeness enforcement. User-locked decision: inherit the gap rather than ship a placeholder-injection mechanism that v1 fork doesn't have. The practical exposure is small (parent typically spawns at end-of-turn), but it's documented in `subagents.md` "Fork mode" as a known limitation.
- **SQLite store refactor dropped during Ultraplan exploration.** `test-apps/node-adapters/sessions/{single,multi}-tenant/store.ts` walks `{row, entry}` tuples so it can re-insert the raw DB payload column. A `SessionEntry[]`-only helper doesn't fit without re-serialising. C1 refactored only the in-memory store; the SQLite stores keep their inline walks and the behavior remains equivalent today. Flagged in the plan's risk register as a divergence to watch.
- **`event-wiring.ts` needed no edit.** I'd planned to touch it for the new `contextMode` field, but the forwarder spreads the whole event object via `notifyLifecycle(e as unknown as Record<string, unknown>)` — the new field flowed automatically. Saved a commit hop.

## What was harder than expected

- **First commit (`bb17df96`) accidentally captured concurrent-session WIP** — a parallel coding-agent session staged files between my `git reset .` and `git commit`. The plan-mode-forced filename rename leaked alongside ~30 unrelated files into the commit. Couldn't easily undo (the user said to leave it), and I learned to use a chained single-Bash `git reset && git add <explicit-paths> && git commit` pattern instead. Saved to memory as `feedback_atomic_commit_with_reset`.
- **The C3 fork test almost passed too soon.** My initial `expect(capturedChildMessageCount[0]).toBeGreaterThanOrEqual(4)` ASSUMED the child would see ≥4 messages (parent user + assistant + tool_result + own task user turn). It worked because the parent's prior turn DOES produce 4 messages in this scenario. If the parent's transcript had a different shape, the threshold would need adjusting — but for the C3 RGR loop it served. The text-content assertion (`childTexts.some((t) => t.includes("Read /proj/diff.md"))`) is the real proof.

## What was easier than expected

- **Reusing `buildSessionContext`.** The existing entries → AgentMessage[] pipeline already handles `compaction` collapse, `branch_summary` wrapping, etc. The fork path just builds a synthetic `{entries, leafId: null}` and takes `.messages` — zero new conversion code. The other return fields (`currentModelId`, `currentThinkingLevel`, `name`, `mcpInclusion`) are discarded; the child gets those from the profile.
- **Lineage on both rails was free.** Adding `contextMode` to `SubagentStartEvent` / `SubagentEndEvent` made the wire forwarder emit it automatically (it spreads the whole event). The CLAUDE.md "both rails" rule paid off — I'd worried about needing to wire the field through manually but didn't.
- **`event-wiring.ts` flow + the existing `subagents-wire-events.test.ts` made the both-rails test cheap** — one new test scenario alongside the existing `echo` one; no new file.

## Test surface added

- 3 new unit/integration files: `clone-slice.test.ts` (7 tests), `subagents-fork-schema.test.ts` (4), `subagents-fork.test.ts` (4). **15 new tests**.
- 1 existing file extended: `subagents-wire-events.test.ts` gains a fork-mode scenario (1 new test); the existing fresh-mode scenario gains `contextMode` assertions.
- 1 new e2e file: `e2e/shared/subagents-fork.e2e.ts` (1 scenario across in-memory/cli/http/ws).
- 1 new Playwright spec: `e2e-ui/shared/subagents-fork.spec.ts` (flow-consolidated slash + LLM-invocation paths across browser/chrome-ext/http).
- Pre-P2a baseline: 493 tests. Post-P2a: **510 tests passing**.

## Items for v3 / future

- **Mid-pair pair-completeness hardening** — placeholder-injection (cc/Gemini pattern) for slicing that lands mid `tool_call`/`tool_result`. Practical exposure is small; revisit if the gap bites.
- **Per-call `slice: {...}` override** on the LLM tool — out of P2a; the profile is the source of truth for now. Reconsider if a real use case for runtime override surfaces.
- **`context: "slice"` mode** with an explicit entry-id range — future, not in current roadmap.
- **SQLite store walking divergence** — C1 refactored only the in-memory store. SQLite stores keep their inline `{row, entry}` walk for re-insertion. Behavior-equivalent today but no shared helper enforces it. Future cleanup could extract a generic `walkPathBy<T>(items, getId, getParentId, leafId)` if the inline walks ever drift.
- **Pre-P2a child SessionStore rehydration** reads `SubagentLinkEntry.contextMode` as `undefined` — per the v2 `subagentDepth` precedent (no production yet, no backfill), acceptable. Wipe-and-reseed is the dev-local workaround.
- **`scriptSubagentRun` test helper**, **`ChatPanelPage.systemMessageWithEvent` Playwright helper** — still deferred from v1 retrospective.

## What carried straight through

- The `SubagentService` constructor dependency graph stays unchanged.
- Progress mirroring via global `EventDispatcher` + `activeRuns` map — unchanged.
- `subagent_link` + `subagent_complete` entry shapes — only `SubagentLinkEntry` gained `contextMode`; `subagent_complete` is unchanged.
- Hard cap at depth 2 — semantics unchanged.
- Children still get NO MCP tools and never receive the `subagent` tool (recursion opt-in deferred to P3d).

## Process notes

- **Ultraplan was the right call.** The remote refinement caught five concrete deltas (SQLite store, event-wiring, wire test piggyback, built-in profile compat, Playwright location) before any code was written. Without it I'd have made the SQLite refactor mistake.
- **TDD red-green-refactor held for every commit.** Each test file was written failing, then the implementation flipped it green. The schema-widening C2 was a textbook clean slice.
- **Same-commit spec updates.** C2 touched `subagents.md`; C3 touched `subagents.md` + `lifecycle.md` + `acp.md`. No spec drift accumulated.
- **No source comments added.** The plan called this out and the no-comments memory entry reinforced it. WHY lives in commit-message bodies.
- **Atomic commit pattern.** After the C0 mishap I used `git reset && git add <explicit-paths> && git commit` for every subsequent commit; clean 3/4/12/6-file commits with no concurrent-WIP contamination.

## Refs

- P2a plan: [`ai-docs/plans/2026-05-18-bodhi-pi-sub-agents-p2a-forked-context.md`](../plans/2026-05-18-bodhi-pi-sub-agents-p2a-forked-context.md).
- V2 retrospective: [`v2-retrospective.md`](./v2-retrospective.md).
- Roadmap (post-P2a): [`roadmap.md`](./roadmap.md) — P2a now landed; **P2b (parallel batch)** is the next candidate.
- Pending inventory: [`pending.md`](./pending.md) — fork-mode rows resolved.
- Ultraplan session: `session_011V77TU1SMCGaq3VrpwgN13`.
