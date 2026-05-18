# Sub-Agent Implementations in Popular Open-Source Agent Harnesses: Research Report for Bodhi-Pi

**Author:** Manus AI  
**Date:** 2026-05-17  
**Target repository:** [`anagri/pi-mono/packages/bodhi-pi`](https://github.com/anagri/pi-mono/tree/main/packages/bodhi-pi)

## Executive Summary

This report surveys popular open-source agent harnesses on GitHub, with special attention to coding-agent harnesses represented in or adjacent to Terminal-Bench, and analyzes how they implement **sub-agents**, **delegation**, **handoffs**, or **multi-agent task routing**. The main conclusion is that the ecosystem uses at least four materially different designs under the common label “sub-agent.” The distinction matters for Bodhi-Pi because Bodhi-Pi is not only a Node CLI; it is an **embeddable, host-mediated, ACP-speaking coding agent** designed to run in CLI, server, browser worker, and Chrome extension worker runtimes. A direct port of a process-heavy CLI design would underfit the browser and server use cases, while a purely in-memory handoff design would underuse Bodhi-Pi’s session-store and extension strengths.

The strongest implementation pattern for Bodhi-Pi is a **tool-mediated child-session sub-agent model**. In this model, the parent agent receives a first-party `task` or `subagent` tool; the tool creates or resumes a child session; the child session runs with a selected agent profile, model, tool policy, workspace bindings, MCP availability, and cancellation signal; and the result is returned to the parent as a normal tool result. This pattern is used most concretely by opencode, Qwen Code, Gemini CLI, Goose, OpenAI Codex, OpenHands, Mastra, and LangChain DeepAgents, though each makes different choices about history isolation, event streaming, background tasks, and permissions.[^opencode-task] [^qwen-agent] [^gemini-agent-tool] [^goose-handler] [^codex-thread-manager] [^openhands-delegation] [^mastra-tools] [^deepagents-subagents]

For Bodhi-Pi, I recommend starting with a **first-party core extension or core service** that exposes a `subagent_task` tool. The first release should implement foreground child sessions, explicit agent profiles, tool allow/deny policies, inherited filesystem/MCP/model access through existing host-mediated services, ACP progress updates through existing tool-call update channels, and durable parent-child links in the existing session store. A second release should add resumable and background sub-agents, parallel fan-out, and a status/result tool similar to opencode’s background task mechanism. A third release should add workflow-style handoff graphs and specialist registries for more general multi-agent workflows.

## Scope and Method

The research started from the user-provided Bodhi-Pi package and expanded outward through Terminal-Bench agent wrappers, GitHub repository ranking, source-code triage, and focused source inspection. Repository popularity was estimated using public GitHub metadata collected for the prioritized harness list; the highest-ranked candidates included opencode, LangChain, Gemini CLI, OpenAI Codex, OpenHands, MetaGPT, AutoGen, CrewAI, LlamaIndex, Goose, Aider, Agno, LangGraph, Semantic Kernel, Qwen Code, Mastra, DeepAgents, Letta, Swarm, SuperAGI, PydanticAI, CAMEL, OpenHarness, Microsoft Agent Framework, VoltAgent, and mini-swe-agent. The local popularity snapshot ranked opencode at approximately 161k stars, LangChain at 136k, Gemini CLI at 104k, OpenAI Codex at 83k, OpenHands at 73k, MetaGPT at 68k, AutoGen at 58k, CrewAI at 51k, LlamaIndex at 49k, Goose at 45k, Aider at 44k, Agno at 40k, LangGraph at 32k, Semantic Kernel at 27k, Qwen Code at 24k, Mastra at 23k, DeepAgents at 22k, Letta at 22k, Swarm at 21k, and PydanticAI at 17k.[^repo-metadata]

> **Definition used in this report:** A “sub-agent feature” is any built-in or framework-level mechanism that allows one agent, manager, workflow, or runtime to delegate work to another named or configured agent with a distinct prompt, tools, model, memory/context boundary, execution lifecycle, or routing identity. This includes both true child-session delegation and lighter handoff models, but the report separates them because they have different implications for Bodhi-Pi.

## Bodhi-Pi Architecture Constraints Relevant to Sub-Agents

Bodhi-Pi is best understood as a host-mediated agent harness rather than a single fixed CLI runtime. Its public configuration requires host-supplied `sessionStore` and `filesystem`, supports host-injected models and API keys, and conditionally receives terminal/script/MCP capabilities depending on runtime. The `BodhiPiConfig` comments explicitly note that browser, Chrome-extension, stateless HTTP, and multi-tenant server hosts must make different decisions about MCP stdio support and MCP connection providers.[^bodhi-agent]

Bodhi-Pi’s `BodhiPiAcpAgent` owns a loaded-session map and core services such as event dispatch, model registry, MCP service, settings service, compaction orchestrator, session graph service, and extension runner host. Its `appendEntry()` method persists every new `SessionEntry`, assigns the entry’s parent to the current runtime leaf, updates the runtime leaf, and writes the new leaf ID back to the host session store.[^bodhi-append] This makes **durable session graphing** a natural substrate for parent-child sub-agent relationships.

Bodhi-Pi’s prompt loop already bridges low-level `piAgent` events into ACP updates. Text deltas become `agent_message_chunk`; tool starts become `tool_call`; partial tool output becomes `tool_call_update`; completed tools become completed or failed `tool_call_update`; and finished user, assistant, or tool-result messages are persisted through `appendEntry()`.[^bodhi-prompt-loop] Therefore, a sub-agent tool should not invent a separate event transport. It should surface child progress through the same ACP tool-call update mechanism, optionally with child-session metadata embedded in the tool-call metadata.

The extension runner is also important. Extensions can register tools, commands, providers, event handlers, custom session entries, and can send messages or append extension entries into sessions.[^bodhi-extensions] A first-party sub-agent implementation could be implemented as a core service or as an internal extension. However, because sub-agents need tight integration with session creation, cancellation, model selection, MCP capability inheritance, and event streaming, the cleanest design is a **core sub-agent service exposed through a first-party tool adapter**, rather than a purely external extension.

## Terminal-Bench Findings

Terminal-Bench itself does not implement sub-agent orchestration for coding agents. Its installed-agent registry is a thin launcher registry for agent wrappers such as Claude Code, Codex, and Grok CLI, while additional local wrappers found in the checkout include Gemini CLI, Qwen Code, Goose, and opencode.[^terminal-bench-registry] The wrappers inspected for Gemini CLI, Qwen Code, and Goose are primarily install/environment/command composition layers. They execute upstream CLIs, but they do not add benchmark-specific delegation semantics. Consequently, the correct way to answer “which Terminal-Bench agents have sub-agent features” is to inspect the upstream harnesses, not Terminal-Bench wrapper code.

| Terminal-Bench-adjacent harness | Upstream sub-agent status | Methodology observed | Relevance for Bodhi-Pi |
|---|---:|---|---|
| **opencode** | Strong support | `task` tool creates or resumes child sessions, supports background jobs, permission derivation, and parent result injection | Highest-value coding-agent reference for child-session design |
| **Gemini CLI** | Strong support | local and remote agent definitions exposed as tools, local executor isolates registry/context and remote executor uses A2A streaming | Strong reference for browser/server-compatible abstraction boundaries |
| **Qwen Code** | Strong support | explicit subagent and fork-subagent tools with inherited context and optional background/worktree behavior | Strong reference for “fork from current conversation” semantics |
| **Goose** | Strong support | Rust subagent handler with typed task config and recipe/task execution | Strong reference for typed task config and CLI agent UX |
| **OpenAI Codex** | Strong support | extension API exposes `spawn_subagent`; thread manager forks history into a child thread source | Strong reference for extension-mediated subagent spawning |
| **Aider** | Limited/no first-class sub-agent evidence in inspected source | Primarily single-agent pair-programming workflow | Useful as a negative coding-agent baseline |
| **mini-swe-agent** | Limited/no first-class sub-agent evidence in inspected source | Minimal single-agent loop | Useful as a negative baseline |

## Implementation Methodologies

### Methodology A: Tool-Mediated Child Session or Child Run

The most relevant class for Bodhi-Pi is the **tool-mediated child session**. The parent agent sees a normal tool schema, invokes it with a task description and agent type, and the runtime creates a child execution context. The child generally has a separate conversation or thread, a selected prompt/profile, constrained tool permissions, and a return protocol that wraps the result for the parent.

| Harness | Core mechanism | Context boundary | Tool/model policy | Return and lifecycle behavior |
|---|---|---|---|---|
| **opencode** | `task` tool creates or resumes a session with `parentID` and title suffix `(@subagent)` | Separate session; optional resume by `task_id` | Derives subagent permissions from parent and selected subagent profile; disables recursive `task` unless allowed | Foreground returns `<task_result>`; background jobs can inject synthetic results into parent and resume parent loop |
| **Qwen Code** | `AgentTool` dispatches explicit or forked subagents | Explicit subagent or forked history | Selects configured subagent and can run foreground/background | Supports cleanup, inherited history, worktree/background notices |
| **Gemini CLI** | Agent definitions become tool invocations via `AgentTool`; `LocalAgentExecutor` runs subagent loop | Local executor builds isolated agent context/registry; remote invocation uses A2A session IDs | Agent definitions select model, tools, prompts; remote calls require confirmation/auth | Returns structured `ToolResult`, progress events, telemetry, local/remote session continuity |
| **Goose** | Rust `subagent_handler` and typed task config | Separate subagent task run | Task config names prompt/model/tool behavior | Emits notifications/progress and returns task output |
| **OpenAI Codex** | extension API `spawn_subagent`; `ThreadManager` creates child thread source | Forked thread/history | Extension capability surface controls spawn | Child thread is tracked as subagent source and returns via extension flow |
| **OpenHands SDK** | `DelegateTool` supports `spawn` and `delegate` commands | Independent child conversations in same workspace | Child agents inherit parent LLM config by default; built-in/custom agent registry | Parallel delegation blocks until children finish and aggregates per-child results |
| **Mastra** | `createSubagentTool` in harness tools | Subagent run under harness metadata | Schema-driven tool parameters and agent definitions | Streams subagent output/events and returns structured result |
| **DeepAgents** | `task` tool from subagent middleware | Context isolation through middleware-created task agent | Subagent definitions include prompt, tools, and model behavior | Parent invokes task tool and receives task result, with optional state-return behavior |

The opencode implementation is especially instructive. Its `TaskTool` schema includes `description`, `prompt`, `subagent_type`, optional `task_id`, and optional `background`.[^opencode-task] The tool looks up the requested subagent type, creates a new child session with `parentID: ctx.sessionID` if a previous `task_id` is not supplied, derives child permissions from the parent session and subagent profile, and runs the child prompt with the selected model and disabled tools as needed.[^opencode-task] In background mode, it starts a background job, injects a synthetic result message into the parent when complete, and can resume the parent loop if the parent is idle.[^opencode-task] This design maps very well to Bodhi-Pi because Bodhi-Pi already has durable session entries, cancellation, ACP tool updates, and host-mediated session storage.

Qwen Code and Gemini CLI add two important refinements. Qwen Code distinguishes an explicit subagent from a **forked subagent**, which is useful when the child should inherit a carefully selected slice of the parent conversation rather than starting from only a task prompt.[^qwen-fork] Gemini CLI separates local and remote invocation. Local subagents are executed by `LocalAgentExecutor`, while remote subagents are invoked through an A2A client manager with remote context/task IDs that persist across invocations.[^gemini-local] [^gemini-remote] This suggests that Bodhi-Pi’s first abstraction should not assume that every sub-agent is an in-process `piAgent`; the `SubagentExecutor` interface should be able to target local in-process child sessions, server-side durable tasks, or remote/MCP-provided agents.

OpenAI Codex is notable because it exposes subagent spawning through the extension API. Its app server extension surface includes subagent-related hooks, and its core thread manager implements subagent spawning by creating a new thread with a subagent source and forked context.[^codex-extension] [^codex-thread-manager] This is directly relevant to Bodhi-Pi’s extension system: a sub-agent feature can remain core-owned while still being callable by extensions or exposed as an extension capability.

### Methodology B: Workflow Handoff Among Named Peer Agents

A second large family implements delegation as **handoff inside one workflow**, not as child-session spawning. The active agent changes, but the workflow runtime remains the same and often shares memory, context variables, state store, or message history.

| Harness | Mechanism | Context and state model | Best use case |
|---|---|---|---|
| **AutoGen Swarm** | Assistant agents emit `HandoffMessage`; `SwarmGroupChatManager` routes the next turn to the target | Shared team message thread with handoff context from tool calls | Conversational teams and turn routing |
| **Semantic Kernel HandoffOrchestration** | Each agent actor gets generated `transfer_to_<agent>` functions; runtime routes `HandoffRequestMessage` | Actor/topic runtime with message cache and shared orchestration graph | Enterprise workflow orchestration with typed runtime |
| **LlamaIndex AgentWorkflow** | Injected reserved `handoff` tool sets `next_agent` in workflow context | Shared workflow store, memory, state, and `can_handoff_to` map | Knowledge workflows and retrieval agents |
| **OpenAI Swarm** | Tool can return an `Agent`; runtime switches `active_agent` | Shared history and context-variable map | Minimal educational handoff design |
| **LangGraph** | Graph nodes and `Command(goto=...)` model handoff | Explicit graph state, reducers, checkpoints | Durable multi-agent workflow graphs |
| **LangChain** | Tool-calling agents can wrap other agents as tools; LangGraph often supplies runtime | Shared or tool-scoped context depending on composition | General agent engineering |

AutoGen’s AssistantAgent constructs handoff tools from configured `handoffs`, validates uniqueness, and includes those handoff tools in the model’s tool list.[^autogen-assistant] When a model result includes a handoff tool call, AutoGen selects the first handoff, collects non-handoff tool calls and results into `handoff_context`, and returns a `HandoffMessage` naming the target.[^autogen-assistant] The Swarm group-chat manager then scans the message thread for the most recent `HandoffMessage` and selects its target as the next speaker.[^autogen-swarm] This is a clean model for **routing**, but it is not the same as running a child task in isolation.

Semantic Kernel’s Python handoff orchestration generates transfer functions dynamically, such as `transfer_to_<agent>`, attaches them as a kernel plugin, and terminates the current auto-function invocation when one of those functions is called.[^semantic-handoffs] Its runtime uses actor topics and messages such as `HandoffStartMessage`, `HandoffRequestMessage`, and `HandoffResponseMessage`; each agent actor caches messages, invokes its agent, publishes responses, and routes requests to the next handoff agent when `_handoff_agent_name` is set.[^semantic-handoffs] This design is sophisticated but heavier than Bodhi-Pi needs for an initial subagent feature.

LlamaIndex’s `AgentWorkflow` injects a reserved `handoff` tool into each agent when multiple agents exist. The `handoff(ctx, to_agent, reason)` function validates the target against known agents and `can_handoff_to`, sets `next_agent` in the workflow context store, and returns a formatted handoff message.[^llamaindex-workflow] The workflow initializes shared context keys such as `memory`, `agents`, `can_handoff_to`, `state`, `current_agent_name`, and prompts.[^llamaindex-workflow] This is an excellent reference for a later Bodhi-Pi **workflow mode**, but it is less appropriate for the first coding sub-agent feature because it does not naturally preserve child-session transcripts as first-class session graph nodes.

OpenAI Swarm is the minimal version of this method. If a tool returns an `Agent`, Swarm wraps it as a `Result(agent=agent)`, appends the tool result, and rebinds `active_agent` for the next loop iteration while continuing over the same history and context variables.[^swarm-core] The strength of this pattern is simplicity. Its weakness for Bodhi-Pi is that a sub-agent transcript is not separately durable, resumable, or cancellable.

### Methodology C: Manager/Crew Orchestration and Role-Based Delegation

Crew-style frameworks treat sub-agents as **role-specialized coworkers** rather than child sessions. CrewAI’s agent tool helper sanitizes a coworker/role name, finds a matching agent by role, constructs a `Task(description=task, agent=selected_agent, expected_output=...)`, and calls `selected_agent.execute_task(task_with_assigned_agent, context)`.[^crewai-agent-tools] This makes delegation natural for business processes, but the implementation assumes a cooperative crew runtime rather than a parent coding agent delegating an isolated investigation or code-editing task.

MetaGPT, CAMEL, Agno, Letta, Microsoft Agent Framework, VoltAgent, and SuperAGI fall broadly into this family or adjacent framework-level multi-agent orchestration patterns. They offer agent teams, roles, workflows, memoryful agents, or graph/workflow composition. They are valuable for terminology and UX design, but the most implementation-relevant references for Bodhi-Pi remain the coding-harness child-session systems and the workflow handoff systems above.

### Methodology D: Extension, Middleware, or Library-Add-On Sub-Agent Features

Some ecosystems do not put sub-agents in the core loop; instead, they expose extension or middleware hooks that allow sub-agents to be composed externally. DeepAgents implements subagents through middleware that creates a `task` tool, validates subagent definitions, controls state/context behavior, and invokes a task-specific agent.[^deepagents-subagents] PydanticAI does not appear to have a single built-in coding-harness subagent equivalent in the inspected top-level source, but the separate `subagents-pydantic-ai` project exists specifically to add nested subagent delegation with runtime creation, parallel execution, and cancellation on top of PydanticAI.[^repo-metadata]

For Bodhi-Pi, this distinction is important because an external extension-only solution would be portable and easy to experiment with, but would not have enough privileged access to session graphing, cancellation, model registry, and MCP inheritance unless Bodhi-Pi exposes more internal capabilities. The recommended path is therefore a **core-owned service with extension-facing APIs**, similar in spirit to Codex’s extension-mediated spawning.

## Top Harnesses Checked and Sub-Agent Evidence

The table below summarizes the top candidates checked, grouped by whether they provide a concrete sub-agent/delegation mechanism and how close that mechanism is to Bodhi-Pi’s needs.

| Rank group | Harness | Stars snapshot | Sub-agent feature strength | Implementation family | Source-level finding |
|---:|---|---:|---|---|---|
| 1 | opencode | 161k | Very strong | Child session/task tool | `TaskTool` creates/resumes child sessions, derives permissions, supports background jobs |
| 2 | LangChain | 136k | Strong | Agent-as-tool / graph composition | Agent engineering framework; subagents commonly modeled as tools or LangGraph nodes |
| 3 | Gemini CLI | 104k | Very strong | Local/remote subagent tool | `AgentTool`, local executor, remote A2A invocation, progress events |
| 4 | OpenAI Codex | 83k | Strong | Extension-spawned child thread | extension API and thread manager expose `spawn_subagent` |
| 5 | OpenHands | 73k | Very strong | Parallel delegated child conversations | `DelegateTool` spawn/delegate with independent contexts and result aggregation |
| 6 | MetaGPT | 68k | Strong | Role/team orchestration | Software-company style multi-agent roles; useful crew reference |
| 7 | AutoGen | 58k | Strong | Handoff routing | `HandoffMessage` plus Swarm manager routing |
| 8 | CrewAI | 51k | Strong | Coworker task delegation | Agent tool finds coworker and calls `execute_task` |
| 9 | LlamaIndex | 49k | Strong | Workflow handoff | Injected `handoff` tool sets `next_agent` in workflow context |
| 10 | Goose | 45k | Strong | Typed subagent task handler | Rust handler/config for subagent tasks |
| 11 | Aider | 44k | Weak/none in inspected evidence | Single-agent coding loop | Useful negative baseline |
| 12 | Agno | 40k | Strong | Team/workflow agents | Multi-agent teams and platform abstractions |
| 13 | LangGraph | 32k | Strong | State graph routing | Explicit graph state, handoffs as graph transitions |
| 14 | Semantic Kernel | 27k | Strong | Actor handoff orchestration | Generated transfer functions and actor-topic routing |
| 15 | Qwen Code | 24k | Very strong | Explicit/forked subagent task | `AgentTool` and `fork-subagent` with foreground/background behavior |
| 16 | Mastra | 23k | Strong | Harness subagent tool | `createSubagentTool` with schema, streaming, metadata, result handling |
| 17 | DeepAgents | 22k | Strong | Middleware task tool | `subagents.py` creates task tool and isolated subagent invocation |
| 18 | Letta | 22k | Moderate/strong | Stateful multi-agent memory | More memory-agent oriented than coding child session |
| 19 | Swarm | 21k | Strong but lightweight | Tool-returned agent swap | Tool result can set replacement active agent |
| 20 | PydanticAI | 17k | Moderate core; strong add-on | Add-on nested subagents | `subagents-pydantic-ai` implements nested delegation on top |
| 21 | CAMEL | 16k | Strong | Multi-agent society/roleplay | Useful for high-level team abstractions |
| 22 | OpenHarness | 12k | Moderate | Open agent harness | Relevant harness project, less concrete coding-subagent evidence in this pass |
| 23 | Microsoft Agent Framework | 10k | Strong | Workflow/orchestration framework | Related to Semantic Kernel/AutoGen direction |
| 24 | VoltAgent | 9k | Moderate/strong | TypeScript agent platform | Relevant TypeScript framework candidate |
| 25 | mini-swe-agent | 4k | Weak/none | Minimal coding agent | Negative baseline for “keep it simple” |

## Design Implications for Bodhi-Pi

Bodhi-Pi should avoid copying a single framework wholesale. Instead, it should combine three ideas: opencode’s durable child-session task tool, Gemini/Qwen’s configurable local executor abstraction, and LlamaIndex/AutoGen’s explicit handoff metadata. The result should be a sub-agent subsystem that feels native to Bodhi-Pi’s ACP and extension architecture.

| Design dimension | Recommended Bodhi-Pi choice | Rationale |
|---|---|---|
| Primary abstraction | `SubagentService` plus first-party `subagent_task` tool | Keeps privileged session/cancellation/model/MCP access in core while presenting a normal LLM tool |
| Execution unit | Child session with `parentSessionId`, `taskId`, `agentProfile`, and `status` | Matches Bodhi-Pi’s durable session graph and opencode’s proven coding-agent model |
| Context policy | Configurable: task-only, summary, selected transcript slice, or forked parent history | Supports OpenHands-style independent contexts and Qwen/Codex-style forked context |
| Tool policy | Derived allow/deny matrix from parent runtime and agent profile | Prevents recursive runaway and respects browser/server host capabilities |
| Model policy | Agent profile may override model; otherwise inherit parent model/provider | Mirrors opencode/OpenHands while preserving Bodhi-Pi model registry behavior |
| MCP policy | Inherit only MCP connections allowed by host and profile; no stdio in unsupported hosts | Preserves Bodhi-Pi’s multi-runtime guarantees |
| Workspace policy | Same filesystem adapter by default, optional path scope or branch/worktree strategy where supported | Works in browser/extension and CLI; avoids assuming Git worktree availability |
| Progress | Parent tool-call updates with child session ID, recent activity, text snippets, and status | Reuses ACP event semantics and avoids special UI transport |
| Return protocol | Structured tool result containing `task_id`, `status`, `summary`, optional artifacts, and child-session link | Allows resumability and parent reasoning |
| Background execution | Phase 2 feature with `subagent_status` and synthetic parent result injection | opencode shows this is valuable but it complicates lifecycle and persistence |

## Proposed Bodhi-Pi Implementation Plan

### Phase 1: Foreground Child-Session Sub-Agent Tool

The first implementation should add a core `SubagentService` and register a built-in tool, tentatively named `subagent_task`. The minimal schema should include `description`, `prompt`, `subagent_type`, optional `context_mode`, optional `model`, optional `tool_policy`, and optional `task_id` for resuming an existing child session. The service should create a durable child session entry linked to the parent, build a child `piAgent` using the same host-mediated filesystem, model registry, MCP service, and extension runner constraints, and run the child until completion or cancellation.

The child run should be cancellable through the parent tool `AbortSignal`. On parent cancellation, the service should abort the child `piAgent`, persist an interrupted status, and return a failed or cancelled tool result rather than leaving hidden work running. This mirrors opencode’s explicit abort wiring and Bodhi-Pi’s existing `cancel()` behavior, where cancellation sets `session.runtime.cancelled` and aborts the underlying `piAgent`.[^bodhi-agent]

The result should be a normal tool result with a stable structure, for example:

```json
{
  "task_id": "subtask-session-id",
  "status": "completed",
  "subagent_type": "researcher",
  "summary": "The subagent found ...",
  "child_session_id": "...",
  "artifacts": []
}
```

### Phase 2: Agent Profiles and Permission Inheritance

Bodhi-Pi should introduce `SubagentProfile` definitions. A profile should contain `name`, `description`, `systemPrompt` or `systemPromptSuffix`, optional `model`, allowed tools, denied tools, MCP access policy, extension access policy, maximum turns, maximum tokens, and context policy defaults. Profiles can be built-in and extension-contributed. This is the point where Bodhi-Pi can borrow from Gemini CLI’s local agent definitions, Qwen’s explicit/forked subagent distinction, and OpenHands’ built-in/custom child-agent registry.

Permission inheritance should be conservative. The default subagent should not automatically get the `subagent_task` tool, because recursive delegation can explode cost and complexity. If recursion is enabled, it should be bounded by `maxDepth`, `maxChildren`, and tool-policy inheritance rules.

### Phase 3: Background and Parallel Sub-Agents

After foreground execution is stable, Bodhi-Pi should add `background: true`, a `subagent_status` tool, and result injection into the parent session. opencode’s implementation provides a concrete model: background mode starts a tracked job, returns immediately with `task_id`, injects a synthetic parent message on completion or error, and resumes the parent loop if appropriate.[^opencode-task] In Bodhi-Pi, this should be adapted to runtime constraints. A stateless HTTP host may not support in-memory background work unless it provides a durable job runner, while a browser worker may support only in-worker tasks with lifecycle caveats.

Parallel sub-agents should use an explicit `subagent_batch` or `delegate` tool rather than overloading the single-task tool. OpenHands’ `DelegateTool` demonstrates the value of named child IDs, maximum child count, and aggregated per-child results.[^openhands-delegation]

### Phase 4: Workflow Handoff Mode

A later release can add workflow-style handoff. This should be separate from child-session subagents. A `handoff` mode would let a named specialist become the active agent in the same session or workflow, similar to LlamaIndex, AutoGen, Semantic Kernel, and Swarm. This mode is useful for long-running multi-agent conversations but should not be confused with child-session task delegation.

## Recommended Internal Interfaces

A TypeScript-oriented interface sketch for Bodhi-Pi is below. It is intentionally host-mediated and avoids Node-only assumptions.

```ts
export interface SubagentProfile {
  name: string;
  description: string;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  modelId?: string;
  contextMode?: "task_only" | "summary" | "selected_history" | "fork_history";
  tools?: {
    allow?: string[];
    deny?: string[];
    inheritParent?: boolean;
  };
  mcp?: {
    inherit?: boolean;
    allowServers?: string[];
    denyServers?: string[];
  };
  limits?: {
    maxTurns?: number;
    maxDepth?: number;
    timeoutMs?: number;
  };
}

export interface SubagentTaskInput {
  description: string;
  prompt: string;
  subagentType: string;
  taskId?: string;
  contextMode?: SubagentProfile["contextMode"];
  background?: boolean;
}

export interface SubagentTaskResult {
  taskId: string;
  childSessionId: string;
  status: "completed" | "failed" | "cancelled" | "running";
  summary?: string;
  error?: string;
  artifacts?: Array<{ kind: string; uri: string; title?: string }>;
}
```

The most important design rule is that the child run should be a **normal Bodhi-Pi session state with extra parent-child metadata**, not a process-global singleton. This preserves compatibility with CLI, server, browser worker, and Chrome extension hosts.

## Risks and Mitigations

| Risk | Why it matters | Mitigation |
|---|---|---|
| Recursive delegation loops | Subagents can call subagents indefinitely if granted the task tool | Deny recursive `subagent_task` by default; enforce `maxDepth`, `maxChildren`, and budget limits |
| Runtime mismatch | Node CLI can spawn processes; browser workers cannot | Keep execution in host-mediated services; make background and stdio MCP capability-gated |
| Permission escalation | Child may gain tools parent did not have | Derive child permissions from parent and profile intersection, not union |
| Context leakage | Child may receive excessive parent transcript or secrets | Default to task-only context; require explicit `fork_history` or selected transcript mode |
| UI overload | Streaming every child token into parent may clutter ACP UI | Send summarized progress updates; link to child session for full transcript |
| Persistence ambiguity | Background results can arrive after parent turn ends | Store child status durably and inject synthetic parent entries with clear metadata |
| Tool result poisoning | Parent may over-trust subagent output | Wrap result in structured tags and metadata; include status and source child session ID |

## Final Recommendation

Bodhi-Pi should implement sub-agents as **durable, host-mediated child sessions invoked through a built-in task tool**. This aligns with the strongest coding-agent harnesses while respecting Bodhi-Pi’s multi-runtime design. The first implementation should be intentionally narrow: foreground execution, explicit profiles, conservative permission inheritance, task-only or summary context, ACP progress updates, and durable session links. Once that is stable, background jobs, parallel delegation, remote subagents, and workflow handoffs can be layered on without changing the core model.

The design should not treat “sub-agent” as synonymous with “multi-agent framework.” The source survey shows that workflow handoffs, crew delegation, graph routing, and true child tasks are all useful, but they solve different problems. For Bodhi-Pi’s next feature, the coding-agent-relevant unit is the **resumable child task**.

## References

[^bodhi-agent]: [`packages/bodhi-pi/src/acp/agent.ts` — Bodhi-Pi ACP composition root](https://github.com/anagri/pi-mono/blob/main/packages/bodhi-pi/src/acp/agent.ts).
[^bodhi-append]: [`packages/bodhi-pi/src/acp/agent.ts` — `appendEntry()` session persistence](https://github.com/anagri/pi-mono/blob/main/packages/bodhi-pi/src/acp/agent.ts).
[^bodhi-prompt-loop]: [`packages/bodhi-pi/src/acp/prompt-loop.ts` — prompt loop event-to-ACP bridge](https://github.com/anagri/pi-mono/blob/main/packages/bodhi-pi/src/acp/prompt-loop.ts).
[^bodhi-extensions]: [`packages/bodhi-pi/src/extensions/runner.ts` — extension runner and extension API behavior](https://github.com/anagri/pi-mono/blob/main/packages/bodhi-pi/src/extensions/runner.ts).
[^terminal-bench-registry]: [`terminal_bench/agents/installed_agents/__init__.py` — Terminal-Bench installed-agent registry](https://github.com/laude-institute/terminal-bench/blob/main/terminal_bench/agents/installed_agents/__init__.py).
[^repo-metadata]: Local GitHub metadata snapshot collected during this task from public repository metadata; saved at `/home/ubuntu/subagent_research/repo_meta_summary.txt`.
[^opencode-task]: [`packages/opencode/src/tool/task.ts` — opencode `TaskTool`](https://github.com/sst/opencode/blob/dev/packages/opencode/src/tool/task.ts).
[^qwen-agent]: [`packages/core/src/tools/agent/agent.ts` — Qwen Code agent tool](https://github.com/QwenLM/qwen-code/blob/main/packages/core/src/tools/agent/agent.ts).
[^qwen-fork]: [`packages/core/src/tools/agent/fork-subagent.ts` — Qwen Code fork-subagent](https://github.com/QwenLM/qwen-code/blob/main/packages/core/src/tools/agent/fork-subagent.ts).
[^gemini-agent-tool]: [`packages/core/src/agents/agent-tool.ts` — Gemini CLI agent tool](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/agents/agent-tool.ts).
[^gemini-local]: [`packages/core/src/agents/local-executor.ts` — Gemini CLI local subagent executor](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/agents/local-executor.ts).
[^gemini-remote]: [`packages/core/src/agents/remote-invocation.ts` — Gemini CLI remote A2A subagent invocation](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/agents/remote-invocation.ts).
[^goose-handler]: [`crates/goose/src/agents/subagent_handler.rs` — Goose subagent handler](https://github.com/block/goose/blob/main/crates/goose/src/agents/subagent_handler.rs).
[^codex-extension]: [`codex-rs/ext/extension-api/src/capabilities/agent.rs` — Codex extension agent capabilities](https://github.com/openai/codex/blob/main/codex-rs/ext/extension-api/src/capabilities/agent.rs).
[^codex-thread-manager]: [`codex-rs/core/src/thread_manager.rs` — Codex thread manager subagent spawn](https://github.com/openai/codex/blob/main/codex-rs/core/src/thread_manager.rs).
[^openhands-delegation]: [OpenHands SDK guide — Agent Delegation](https://docs.openhands.dev/sdk/guides/agent-delegation).
[^mastra-tools]: [`packages/core/src/harness/tools.ts` — Mastra harness subagent tool](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/harness/tools.ts).
[^deepagents-subagents]: [`libs/deepagents/deepagents/middleware/subagents.py` — LangChain DeepAgents subagent middleware](https://github.com/langchain-ai/deepagents/blob/main/libs/deepagents/deepagents/middleware/subagents.py).
[^autogen-assistant]: [`_assistant_agent.py` — AutoGen AssistantAgent handoff handling](https://github.com/microsoft/autogen/blob/main/python/packages/autogen-agentchat/src/autogen_agentchat/agents/_assistant_agent.py).
[^autogen-swarm]: [`_swarm_group_chat.py` — AutoGen Swarm group chat manager](https://github.com/microsoft/autogen/blob/main/python/packages/autogen-agentchat/src/autogen_agentchat/teams/_group_chat/_swarm_group_chat.py).
[^semantic-handoffs]: [`handoffs.py` — Semantic Kernel HandoffOrchestration](https://github.com/microsoft/semantic-kernel/blob/main/python/semantic_kernel/agents/orchestration/handoffs.py).
[^llamaindex-workflow]: [`multi_agent_workflow.py` — LlamaIndex AgentWorkflow handoff implementation](https://github.com/run-llama/llama_index/blob/main/llama-index-core/llama_index/core/agent/workflow/multi_agent_workflow.py).
[^swarm-core]: [`swarm/core.py` — OpenAI Swarm active-agent switching](https://github.com/openai/swarm/blob/main/swarm/core.py).
[^crewai-agent-tools]: [`base_agent_tools.py` — CrewAI coworker task delegation](https://github.com/crewAIInc/crewAI/blob/main/src/crewai/tools/agent_tools/base_agent_tools.py).
