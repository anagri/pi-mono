# Sub-agents roadmap (rough)

After v1 lands and we capture learnings in `retrospective.md`, we'll pick the next phase here and **re-research** it before writing its plan. The order below is a current guess at value × effort, not a commitment. Each phase will go through its own brainstorming + planning + execution cycle.

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

### P2c — Bundled built-in profiles

**Why**: New installs get value with zero config. Matches cc/opencode/Mastra UX. Reduces "what do I put in `.bodhi-pi/agents/`?" friction.

**Refs to re-read**:
- cc's `Explore/Plan/Execute/audit-tests`.
- Mastra's `explore/plan/execute/audit-tests`.
- pi-subagents' `scout/researcher/planner/worker/reviewer/oracle/context-builder/delegate`.

**Key design questions**:
- Which profiles to ship? Start with `explore` (read-only) + `planner` (planning prose only)? Skip `worker` (too generic, easy to ship a bad default)?
- Where do they live: `src/subagents/profiles/<name>.md` bundled as imports? Or runtime-loaded from a known path?
- How do users override / disable? `subagents.disableBuiltins` in settings? Override by name in `.bodhi-pi/agents/`?
- Should bundled profiles ship with `inheritProjectContext` / `inheritSkills` semantics (pi-subagents pattern)?

### P2d — Extension-registered profiles

**Why**: Lets third-party extensions ship subagent profiles. Closes the contribution model gap so subagent is a true peer with Commands/Skills/Extensions.

**Refs to re-read**:
- Existing `registerTool` / `registerCommand` API in `src/extensions/types.ts`.

**Key design questions**:
- Add `registerSubagentProfile(def)` to ExtensionAPI — straightforward.
- Profile merge precedence with markdown: `mergeSubagentProfiles(markdownProfiles, extensionProfiles)` — first-registered wins on name collision? Or project markdown beats extension?
- How does this interact with hot-reload (markdown profiles re-walk per session boot; extension profiles fixed at runner build)?

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

## Notes for re-reading

- Each phase is **rough**: assumptions may invalidate, ordering may change, scope may shrink or split.
- Before starting any phase, re-read the referenced harness code in `../research/sub-agents/` and look for upstream changes via the deepwiki MCP if available.
- Honor the `superpowers:brainstorming` flow per phase: brainstorm → design → spec → plan → implement → retrospect.
- Each phase's plan lands in `ai-docs/sub-agents/<phase>-plan.md` and follows the same TDD-across-4-runtimes shape as `v1-plan.md`.
