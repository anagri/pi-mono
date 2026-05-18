# Bodhi-Pi Sub-Agent Research Notes

## Target package: anagri/pi-mono/packages/bodhi-pi

Repository URL: https://github.com/anagri/pi-mono/tree/main/packages/bodhi-pi

Initial README findings from GitHub page:

- Package name: `@bodhiapp/bodhi-pi`.
- Described as an **embeddable, host-mediated, ACP-speaking coding agent**.
- It is a sibling to `@earendil-works/pi-coding-agent` and depends on `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core`.
- Current status: pre-alpha.
- It exposes `createBodhiPiAgent` and host-injected services such as session store and filesystem.
- Example wiring uses `@agentclientprotocol/sdk` `AgentSideConnection` with `ndJsonStream` for stdio.
- Reference helpers include `createInMemoryFilesystem()` and `createInMemorySessionStore()`.
- Host services in `BodhiPiConfig` are mandatory; no silent defaults. `systemPrompt` is config-time only and re-applied from config on session/load.
- Directory structure includes `src`, `e2e`, `e2e-ui`, `test-apps`, and `test`.
- README references architecture and port-plan docs under `ai-docs/research/embeddable-agent-design.md` and `ai-docs/research/coding-agent-features.md`.

Implication for sub-agent design: any Bodhi-Pi sub-agent model should preserve embeddability and host mediation. The likely natural fit is a sub-agent abstraction that delegates context, filesystem/session access, model selection, and MCP/extension capabilities through host-mediated interfaces rather than assuming a single Node CLI runtime.


## OpenHands SDK sub-agent delegation findings

Source: https://docs.openhands.dev/sdk/guides/agent-delegation

OpenHands implements sub-agent delegation as a first-class tool-driven mechanism through a `DelegateTool`. The main agent first invokes a `spawn` command with meaningful child identifiers, then invokes `delegate` with a mapping from child identifier to task description. Each spawned sub-agent has its own independent conversation context, inherits the parent LLM configuration by default, operates in the same workspace, and returns results to the parent in a consolidated observation.

The delegate operation runs child tasks in parallel using threads and blocks until all children complete. It reports errors per sub-agent. The user or application can cap concurrency by configuring a maximum number of children. The documented API includes registering `DelegateTool`, adding it to the parent agent's tool list, and optionally overriding `DelegateTool.create(conv_state, max_children=...)`.

OpenHands also supports built-in and user-defined sub-agent types. The example imports `register_agent` from `openhands.sdk.subagent`, calls `register_builtins_agents()`, and demonstrates built-in `explore` and `bash` sub-agents as well as user-defined agents configured with custom `AgentContext`, skills, and system-message suffixes.

Design pattern: **tool-mediated parent-child agent spawning with separate child conversations, shared workspace, parallel execution, result aggregation, and optional typed child-agent factories**.


## Bodhi-Pi local source inspection findings

Local clone: `/home/ubuntu/subagent_research/pi-mono/packages/bodhi-pi`.

The package has a small embeddable core with ACP integration under `src/acp`, core/session abstractions under `src/core`, host/runtime adapters, MCP support, extension support, and tests/e2e fixtures. The public index exports `BodhiPiConfig`, `createBodhiPiAgent`, extension APIs, MCP constants/configuration, settings types, and host-backed filesystem/session-store helpers.

The extension system is highly relevant for sub-agents. Extensions register LLM-callable tools, slash commands, providers, lifecycle event handlers, inter-extension pub/sub handlers, custom session entries, and host-mediated message sending. The `ExtensionToolDefinition` mirrors `pi-agent-core` tool execution, including tool-call id, typed parameters, `AbortSignal`, and tool update callbacks. The `ExtensionAPI` exposes `sendMessage(sessionId, content)` and `appendEntry(sessionId, entry)`, which could be reused or generalized for parent-child task orchestration.

Architectural implication: a Bodhi-Pi sub-agent implementation should likely be an internal tool contributed by core or by a first-party extension. It should use the same host-injected filesystem/session-store/model-provider capabilities and the same event and tool update pathways as ordinary tool execution. Sub-agent task state should be represented as session entries or child session metadata rather than process-global state, because Bodhi-Pi supports CLI, server, browser worker, and Chrome extension worker runtimes.

