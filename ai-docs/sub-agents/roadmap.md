# Sub-agents roadmap (rough)

V1 landed 2026-05-18 across three commits (`f7d7d421`, `532ee5fc`, `c8e06bf1`). Retrospective in [retrospective.md](./retrospective.md).

**V2 landed 2026-05-18** across eight commits (`9b67f7b4` C0 → `e2a3e93d` C1 → `cea50e87` C2 → `ea70a10e` e2e refresh → `121ba066` C3a → `d2a2fc51` C3b → `d963a049` C3c → C4 + C5). V2 shipped: bundled built-in profiles (P2c), extension-registered profiles (P2d), and the three v1 carry-forward fixes (cancellation test, `subagentDepth` caching, `evictChild` lifecycle per-status). It also folded in C0 — a pre-existing v1 schema bug on the `subagent` tool — surfaced during plan review. Retrospective in [v2-retrospective.md](./v2-retrospective.md).

**P2a landed 2026-05-18** across five commits (`87ab9b2e` C1 → `7d5bfd18` C2 → `764cb275` C3 → `0200ffda` C4 → C5). P2a shipped: `context: "fork"` profile mode, shared `cloneTranscriptSlice` helper, `SUBAGENT_FORK_FILTER`, spawn-flow fork branch, `contextMode` lineage on `SubagentLinkEntry` + lifecycle events, refreshed LLM tool description, e2e + e2e-ui specs. Retrospective in [p2a-retrospective.md](./p2a-retrospective.md).

**Next candidate**: P2b (parallel batch). With fork-mode landed, the next high-leverage UX win is "run reviewers in parallel". Suggested order from here: **P2b → P3a → ...**.

The phases below are refined with what v1 + v2 + P2a surfaced; each one still goes through its own brainstorming + planning + execution cycle before implementation. Order is a current guess at value × effort, not a commitment.

## Phase 2 candidates (one picks next)

### P2a — Forked context ✅ landed in P2a

Shipped 2026-05-18. `context: "fork"` profile mode clones the parent's transcript (filtered to drop `mcp_inclusion_set`/`extension`/`subagent_link`/`subagent_complete` noise) into the child via the shared `cloneTranscriptSlice` helper. Distinct from `_bodhi-pi/session/fork` sibling — see `subagents.md` "Fork mode".

See [p2a-retrospective.md](./p2a-retrospective.md) for what shipped and what's deferred to v3.

### P2b → Phase 2 retirement — Parallel sub-agent dispatch ⛔ rewritten 2026-05-19

P2b originally shipped a separate `subagent_batch` LLM tool (2026-05-18). Phase 2 (2026-05-19) deleted that entire surface — `src/tools/subagent-batch.ts`, `src/subagents/batch-progress-accumulator.ts`, `SubagentService.spawnBatch`, `SubagentBatchEntry`, the batch lifecycle events, and the batch wire forwarders are gone.

Current shape: **parallelism via LLM parallel tool-use.** When the LLM emits N `subagent` tool calls in one assistant message, pi-agent-core's `Promise.all` executor (`packages/agent/src/agent-loop.ts::executeToolCallsParallel`) runs them concurrently. Each child fires its own `subagent_start` / `subagent_end` lifecycle events stamped with `serverTime`, which consumers use to prove wall-clock overlap (`max(start.serverTime) <= min(end.serverTime)`). No batch envelope tool, batch session-entry, or batch lifecycle event.

Model-dependency: non-reasoning models (claude-haiku-4-5, gpt-4o-mini) emit parallel tool calls reliably; reasoning models (gpt-5-mini, o-series) chunk one-per-turn → sequential execution. The tool description in `src/tools/subagent.ts` instructs the model to bundle independent tasks into one turn.

See [p2b-retrospective.md](./p2b-retrospective.md) for what shipped originally, [`milestones/040-parallel-batch.md`](./milestones/040-parallel-batch.md) for the Phase 2 superseded banner, and [`../plans/we-want-to-merge-jiggly-meteor.md`](../plans/we-want-to-merge-jiggly-meteor.md) for the retirement plan.

### P2c — Bundled built-in profiles ✅ landed in v2

Shipped `explore` + `planner` as TS modules under `src/subagents/profiles/`. Tool-locked to `{read, ls, find, grep}`. Runtime-neutral; works in cli + http + browser + chrome-ext with no bundler glue. Disable mechanism: project markdown override with `disabled: true`.

See [v2-retrospective.md](./v2-retrospective.md) for what shipped and what's deferred to v3.

### P2d — Extension-registered profiles ✅ landed in v2

`ExtensionAPI.registerSubagentProfile(def)` added as peer of `registerTool`/`registerCommand`/`registerProvider`. Precedence project > extension > built-in via `mergeSubagentProfiles` in `src/extensions/merge.ts`. Shares the `validateAndNormalizeProfile` pipeline with markdown discovery so no source can bypass invariants.

See [v2-retrospective.md](./v2-retrospective.md).

## Phase 3 candidates

### P3a — Background runs

**Why**: Long-running children (build, test, scrape) shouldn't block the parent's turn. Becomes essential for workflows beyond simple summaries.

**Refs to re-read**:
- opencode's TaskTool background mode + `BackgroundJob.start` + synthetic result injection (lines 271–303 of `task.ts`).
- pi-subagents `--bg` + `async-job-tracker.ts` + `async-status.ts`.

**Key design questions**:
- **Runtime constraint**: cli + browser + chrome-ext can run background tasks within the process lifetime. http (per-turn rebuild) needs an external job runner. v1 of this phase = cli/browser/chrome-ext only; http gates on a follow-up phase or stays unimplemented for background.
- How does parent's LLM see the background task as still-running across multiple turns? Inject a synthetic `<background_task_status>` reminder into the next prompt? Add a `subagent_status(task_id)` tool? Both?
- Notification UX when a background task completes — Host event + UI surface.

### P3b — Resume mid-run children

**Why**: User closes the tab while a child is mid-run; on reopen, the child should continue (or at least be inspectable + restartable).

**Refs to re-read**:
- opencode `task_id` to resume.
- pi-subagents `subagent({ action: "resume", id, message })`.

**Key design questions**:
- "Resume" semantics: re-load child session state, re-run from the last leaf vs start a new prompt that continues the conversation.
- Compaction implications.

### P3c — MCP inclusion allow/deny lists

**Why**: Profile-level granular MCP access. v1 has only inherit-all-or-nothing.

**Refs to re-read**:
- pi-subagents `mcp:<server>` tool naming pattern + frontmatter parsing.

### P3d — Skill inheritance for child agents

**Why**: Profile says "this subagent should have access to skill X" — wires the skill into the child's system prompt + advertises it.

**Refs to re-read**:
- cc's frontmatter `skills:` list and `getSkillToolCommands` integration in `runAgent.ts:577–646`.

## Phase 4 candidates

### P4a — Worktree isolation (cli-only)

**Why**: Parallel children that edit can clobber each other. Worktree gives each its own checkout. **Only meaningful for cli** because browser/chrome-ext/http have no worktree story.

**Refs to re-read**:
- cc's `isolation: "worktree"` path in `AgentTool.tsx`.
- pi-subagents' `worktree: true` + `worktree.ts`.

**Key design questions**:
- cli-only — needs `git`, needs a real filesystem. Profile field becomes a runtime-capability-gated knob: `worktree: true` errors with `unsupported in this runtime` on non-cli.
- Cleanup semantics (when does the worktree get removed?).

### P4b — Fuller slash UX

**Why**: `/run`, `/chain`, `/parallel` would feel pi-subagents-like and shorten common workflows.

**Refs to re-read**:
- pi-subagents `/run`, `/chain`, `/parallel`, `/run-chain`, `/subagents-doctor` slashes.

**Key design questions**:
- Per the bodhi-pi flat-and-complete slash design memory: no popups, no cycle conveniences. Each slash is one-shot.
- Chains as `.chain.md` files (pi-subagents pattern) — markdown discovery again.

### P4c — Workflow handoff mode (separate from sub-agent)

**Why**: Different model — a named specialist becomes the *active* agent in the *same* session. Useful for long-running multi-agent conversations.

**Refs to re-read**:
- LlamaIndex `AgentWorkflow.handoff`.
- AutoGen `HandoffMessage`.
- Semantic Kernel `HandoffOrchestration`.
- OpenAI Swarm.

**Key note**: This is conceptually distinct from child-session delegation. Should not be confused. Different public surface, probably a different tool name (`handoff` or `become`).

### P4d — Remote sub-agents (A2A)

**Why**: Delegate to an agent running elsewhere (different machine, different cluster).

**Refs to re-read**:
- Gemini CLI `remote-invocation.ts` + A2A streaming + `RemoteInvocation`.

**Key note**: Far-future. Depends on A2A spec maturity in our ecosystem. Likely needs a new `SubagentExecutor` interface (local vs remote) and a Host-injected dependency.

## Carry-forward from v1 + v2 retrospectives

V2 landed three of the v1 carry-forward items (cancellation test, subagentDepth cache, evictChild lifecycle per-status). What remains, deferred to a future phase:

- ~~**Progress mirroring is one global handler** filtering by sessionId.~~ ✅ resolved in P2b — `BatchProgressAccumulator` demuxes per-child events through one coalesced `tool_call_update` with `details.children[]` for batch children; single-child `spawn()` keeps its direct `run.onUpdate` path.
- **`buildChildSessionState` duplicates `buildSessionState`** — acceptable now, will diverge with profile inheritance features. Worth a shared helper in a later cleanup, likely alongside P3c/P3d.
- **Faux provider scripting helper** — add a `scriptSubagentRun({parentToolCalls, childToolCalls, finalText})` test helper so future spawn tests don't off-by-one on the queue. (Still deferred; v2's cancellation + LLM-invocation tests both hand-script.)
- **`ChatPanelPage.systemMessageWithEvent(event)`** Playwright helper — avoids the `.last()` after `waitForIdle()` race documented in retrospective. (Still deferred; the new C4 spec uses the same pattern.)
- **`SubagentService.config`** field is declared but unused — keep for symmetry, drop in cleanup if YAGNI wins.
- **Lint `.bodhi-pi/agents/<name>.md` for orphan `disabled: true`** — v2 introduced. Silently no-ops if the name doesn't match any built-in or extension. A `subagents-doctor`-style helper could flag it.
- **Pre-v2 SessionStore rehydration of child sessions reads `subagentDepth: 0`** — acceptable today (no production). Documented in the C3b commit body.

## Notes for re-reading

- Each phase is **rough**: assumptions may invalidate, ordering may change, scope may shrink or split.
- Before starting any phase, re-read the referenced harness code in `../research/sub-agents/` and look for upstream changes via the deepwiki MCP if available.
- Honor the `superpowers:brainstorming` flow per phase: brainstorm → design → spec → plan → implement → retrospect.
- Each phase's plan lands in `ai-docs/sub-agents/<phase>-plan.md` and follows the same TDD-across-4-runtimes shape as `v1-plan.md`.
