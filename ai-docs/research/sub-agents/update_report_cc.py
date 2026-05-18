from pathlib import Path

report = Path('/home/ubuntu/subagent_research/bodhi_pi_subagents_deep_research_report.md')
backup = Path('/home/ubuntu/subagent_research/bodhi_pi_subagents_deep_research_report.before_cc.md')
text = report.read_text()
if not backup.exists():
    backup.write_text(text)

section = '''
## Addendum: `cc` Local Agent Sub-Agent Implementation

The connected local `cc-analysis` source, treated here as the **`cc` agent**, implements sub-agents through a rich `AgentTool` abstraction rather than a small single-purpose helper. The tool schema exposes a short task description, task prompt, optional `subagent_type`, optional model override, optional background execution, optional worktree isolation, and team-oriented fields such as `name`, `team_name`, and `mode`.[^cc-agenttool] This makes `cc` closest to the **tool-mediated child session** methodology, but with two important extensions: a forked-context worker path and an addressable teammate/team mode.

| `cc` capability | Implementation summary | Relevance for Bodhi-Pi |
|---|---|---|
| Explicit typed sub-agent | `subagent_type` resolves a built-in or configured agent definition, validates permission rules and required MCP servers, builds the worker system prompt, assembles a worker tool pool, and invokes `runAgent`.[^cc-agenttool] | Strong fit for a first Bodhi-Pi implementation because it maps cleanly to an extension/tool invocation surface. |
| Foreground, async, and foreground-to-background lifecycle | The same tool can run a worker synchronously, launch it as a background task, or register a foreground task that later transitions to background. Background runs have task IDs, output files, progress updates, notifications, completion, failure, and kill semantics.[^cc-agenttool] [^cc-localagenttask] | Suggests Bodhi-Pi should separate child-run execution from lifecycle state, so REST, WebSocket, CLI, browser-worker, and extension runtimes can surface the same events differently. |
| Fork sub-agent mode | When the fork feature is enabled, omitting `subagent_type` selects a synthetic `fork` agent. The fork child inherits the parent’s rendered system prompt, conversation context, and exact tool definitions; `buildForkedMessages()` preserves the parent assistant tool-use blocks and appends placeholder tool results plus a child directive to maximize prompt-cache sharing.[^cc-fork] | Useful as a later optimization for parallel research or implementation workers, but it requires careful context cloning, recursion guards, and byte-stable prompt/tool serialization. |
| Worktree isolation | `isolation: "worktree"` creates a temporary git worktree, runs the child with a cwd override, injects a fork worktree notice when applicable, and removes the worktree when unchanged.[^cc-agenttool] | Valuable for coding agents, but should be optional and runtime-gated because Bodhi-Pi also targets browser and extension workers where git worktrees may be unavailable. |
| Addressable teammates | If `team_name` and `name` are present, `AgentTool` routes to `spawnTeammate()` and returns a `teammate_spawned` result. This is a long-lived, message-addressable multi-agent mode rather than a one-shot sub-agent result.[^cc-agenttool] [^cc-spawnmulti] | This should be treated as a second-generation feature after one-shot sub-agents, because it requires mailbox routing, team membership, task ownership, idle notifications, and UI state. |

The main architectural lesson from `cc` is that **sub-agent execution, lifecycle tracking, context inheritance, and multi-agent addressing are separate concerns**. For Bodhi-Pi, the practical path is to implement explicit typed sub-agents first, backed by a child-session registry and event stream. Forked-context workers can follow once Bodhi-Pi can clone parent prompt state safely across its Node CLI, Node server, browser worker, and Chrome extension runtimes. The teammate/team model is powerful, but should remain outside the minimum viable sub-agent feature because it introduces persistent identity, mailbox delivery, and collaborative task state.
'''

if '## Addendum: `cc` Local Agent Sub-Agent Implementation' not in text:
    marker = '\n## Design Implications for Bodhi-Pi\n'
    text = text.replace(marker, '\n' + section + marker)

refs = '''
[^cc-agenttool]: Local source: `/mnt/desktop/cc-anaysis/src/tools/AgentTool/AgentTool.tsx` — `cc` AgentTool schema, routing, lifecycle, worktree, async, and teammate branching.
[^cc-fork]: Local source: `/mnt/desktop/cc-anaysis/src/tools/AgentTool/forkSubagent.ts` — fork-subagent feature gate, synthetic fork agent, context cloning, prompt-cache placeholder construction, and recursion guard.
[^cc-localagenttask]: Local source: `/mnt/desktop/cc-anaysis/src/tasks/LocalAgentTask/LocalAgentTask.tsx` — background local agent task registration and progress lifecycle used by `AgentTool`.
[^cc-spawnmulti]: Local source: `/mnt/desktop/cc-anaysis/src/tools/shared/spawnMultiAgent.ts` — teammate/team spawning path invoked by `AgentTool` when `team_name` and `name` are supplied.
'''

if '[^cc-agenttool]:' not in text:
    text = text.rstrip() + '\n' + refs

report.write_text(text)
print('updated', report)
