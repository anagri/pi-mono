# Sub-agents roadmap (rough)

V1 landed 2026-05-18 across three commits (`f7d7d421`, `532ee5fc`, `c8e06bf1`). Retrospective in [retrospective.md](./retrospective.md).

**V2 landed 2026-05-18** across eight commits (`9b67f7b4` C0 → `e2a3e93d` C1 → `cea50e87` C2 → `ea70a10e` e2e refresh → `121ba066` C3a → `d2a2fc51` C3b → `d963a049` C3c → C4 + C5). V2 shipped: bundled built-in profiles (P2c), extension-registered profiles (P2d), and the three v1 carry-forward fixes (cancellation test, `subagentDepth` caching, `evictChild` lifecycle per-status). It also folded in C0 — a pre-existing v1 schema bug on the `subagent` tool — surfaced during plan review. Retrospective in [v2-retrospective.md](./v2-retrospective.md).

**Next candidate**: P2a (forked context). It's the largest remaining Phase 2 item and unblocks "review this diff"-style usage. Suggested order from here: **P2a → P2b → P3a → ...**.

The phases below are refined with what v1 + v2 surfaced; each one still goes through its own brainstorming + planning + execution cycle before implementation. Order is a current guess at value × effort, not a commitment.

## Phase 2 candidates (one picks next)

### P2a — Forked context (parent history clone into child)

**Why**: Lets the child see the parent's conversation when the task isn't self-contained. Critical for "review this diff", "continue this thread"-style delegation. Mastra's data suggests forked is the more common usage in practice.

**Refs to re-read**:
- Mastra's forked path (`tools.ts` lines 893–989) — clones parent thread, reuses parent agent for prompt-cache stability, patches recursive `subagent` to a stub.
- cc's `forkSubagent.ts` and `buildForkedMessages` — preserves exact tool definitions, blocks recursion via boilerplate detection.
- bodhi-pi's existing `_bodhi-pi/session/fork` handler in `SessionGraphService` — interaction surface.

**Key design questions** (decide during brainstorming, do not pre-commit):
- Snapshot parent's leaf at fork time vs continuous mirror?
- How does this interact with bodhi-pi's existing `_bodhi-pi/session/fork`? Subset, superset, or sibling?
- Prompt-cache stability: do we go far enough to byte-match the parent's request prefix, or accept some cache misses for simpler semantics?
- Profile field: `context: "fork"` already typed in v1 — wire it to a real implementation here.

### P2b — Parallel batch

**Why**: "Run reviewers for correctness, tests, and cleanup in parallel" — the highest-leverage UX win after foreground works. Most coding-agent harnesses prioritize this early.

**Refs to re-read**:
- OpenHands `DelegateTool` — parallel children + result aggregation.
- pi-subagents `/parallel` slash + `subagent({ tasks: [...] })` tool overload.

**Key design questions**:
- Separate `subagent_batch` tool vs overload `subagent`?
- Concurrency cap (config or per-call)?
- Failure modes: fail-fast vs collect-all?
- How do parallel child events interleave on the parent's `tool_call_update` channel?

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

- **Progress mirroring is one global handler** filtering by sessionId. Works for foreground single-child but parallel batch (P2b) needs per-child UI accumulation in the Host — design the parallel-render UI before implementation.
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
