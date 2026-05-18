# Concise cc Sub-Agent Implementation Notes

**Scope.** This note summarizes the local `cc-analysis` implementation that the user asked to treat as the `cc` agent. The analysis is intentionally brief to conserve credits and is based on the already-read source paths under `/mnt/desktop/cc-anaysis`.

## Key source paths

| Source path | Role in sub-agent design |
|---|---|
| `src/tools/AgentTool/AgentTool.tsx` | Main delegation tool. Defines the `Agent` input schema, selects explicit subagent types, launches synchronous or asynchronous workers, supports worktree isolation, and branches into teammate/team spawning. |
| `src/tools/AgentTool/forkSubagent.ts` | Implements the implicit fork-subagent experiment. Omitting `subagent_type` can create a fork worker that inherits the parent context and exact tool definitions. |
| `src/tools/shared/spawnMultiAgent.ts` | Called by `AgentTool` when `team_name` and `name` are supplied, creating addressable teammates rather than one-shot subagents. |
| `src/tasks/LocalAgentTask/LocalAgentTask.tsx` | Provides background-agent registration, progress tracking, completion, failure, kill, and notification lifecycle. |
| `src/tasks/InProcessTeammateTask/InProcessTeammateTask.tsx` and `src/utils/swarm/*` | Support the “agent team” mode where addressable teammates are run in-process or through terminal backends. |

## Implementation summary

`cc` has one of the richer sub-agent implementations among the reviewed harnesses. Its `AgentTool` exposes `description`, `prompt`, optional `subagent_type`, optional model override, background execution, worktree isolation, and, when team mode is enabled, addressable teammate fields such as `name`, `team_name`, and `mode`. If `team_name` and `name` are present, the call is treated as a teammate spawn through `spawnTeammate`; otherwise it is treated as a normal sub-agent run.

For normal explicit subagents, `AgentTool` resolves an agent definition, checks permission-deny rules, verifies required MCP servers, computes an agent-specific system prompt, assembles a worker tool pool under the worker’s permission mode, and calls `runAgent`. The worker can run synchronously in the foreground, asynchronously from the start, or transition from foreground to background after a background signal. Background runs are registered as local agent tasks and emit progress, completion, failure, kill, output-file, and notification events.

The fork-subagent path is distinct. When the fork feature is enabled, omitting `subagent_type` selects a synthetic `fork` agent. The fork child inherits the parent’s already-rendered system prompt, parent conversation context, and exact tool definitions. `buildForkedMessages()` preserves the full parent assistant message, creates placeholder `tool_result` blocks for each parent tool use, and appends a child-specific directive. This is designed to maximize prompt-cache sharing across forked workers while giving each child a unique task directive. Recursive forking is blocked by detecting a fork boilerplate tag in the child history.

The design also includes worktree isolation. When `isolation: "worktree"` is requested, `AgentTool` creates a temporary git worktree, runs the sub-agent with a cwd override, injects a fork worktree notice when applicable, and removes the worktree if unchanged. If the worktree has changes, it is retained and reported in the result/notification.

## Methodology classification

| Pattern | cc behavior |
|---|---|
| Tool-as-delegation API | `AgentTool` is the primary LLM-visible sub-agent API. |
| Typed specialist agents | Explicit `subagent_type` selects a registered built-in or user-defined agent definition. |
| Forked context worker | Optional fork mode creates implicit workers that inherit parent context and exact tools. |
| Async task registry | Background agents are represented as local tasks with progress, output files, notifications, and kill/fail/complete transitions. |
| Addressable multi-agent team | `team_name + name` creates long-lived teammates reachable through messaging rather than a one-shot task result. |
| Isolation | Worktree isolation is first-class and can be combined with forked workers. |

## Bodhi-Pi takeaway

The most useful `cc` design to borrow is a two-tier model: first implement **one-shot typed subagents** as an `Agent`/`Task` tool with its own registry, tool pool, lifecycle events, and optional async task state; then add an advanced **fork worker** mode that clones parent context only when the runtime can preserve byte-stable tool and system-prompt prefixes. The addressable teammate/team mode is powerful but should be a later feature because it requires mailbox routing, task ownership, team config, idle notifications, and UI concepts beyond one-shot delegation.
