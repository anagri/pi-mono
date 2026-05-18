# Framework-level HITL/approval/mode notes

## Two distinct "mode" notions in the ecosystem

1. **Mode-as-enum** (AutoGen v0.2's `human_input_mode`) — a long-lived per-agent setting that biases when to ask the human.
2. **Mode-as-paused-thread-state** (LangGraph's `interrupt()` + checkpointer) — the session is *in* a state because an interrupt is outstanding; resume keyed by opaque ID.

Only **AutoGen v0.2** ships a true per-agent mode enum. Everything else is either a per-call hook (`requires_approval`, filters, middleware) or a session-state machine (LangGraph). Most have *abandoned* mode enums in favor of one of those two purer designs — AutoGen itself moved away from `human_input_mode` in v0.4.

## Lesson for bodhi-pi

A mode primitive should be **either**:
- (a) a small, well-defined enum surfaced on the *session* level (AutoGen-style), **or**
- (b) a checkpointed pause-state with explicit resume tokens (LangGraph-style)

Not a hybrid. Bodhi-pi should pick (a) — small enum on `SessionState` — because:
- ACP already has session lifecycle (no need to reinvent checkpointer)
- The four modes (`ask/plan/edit/allow-all`) are well-defined and well-understood
- Pause-state-with-resume is what bodhi-pi's `tool_call_update { status: "pending_approval" }` naturally is — bodhi-pi doesn't need a graph runtime for it

## Per-framework summary

| Framework | Primitive | True mode? | Survives process death? | Cross-runtime |
|---|---|---|---|---|
| **LangGraph** | resumable exception + checkpointer | implicit (paused thread) | yes (persistent checkpointer) | Python + JS |
| **AutoGen v0.2** | `human_input_mode = ALWAYS \| TERMINATE \| NEVER` | **yes (per-agent)** | no | Python |
| **AutoGen v0.4** | `input_func` + `approval_func` per-agent | no | no | Python |
| **DeepAgents** | `HumanInTheLoopMiddleware` over LangGraph | inherited | inherited | Python + JS |
| **LlamaIndex** | `InputRequiredEvent`/`HumanResponseEvent` workflow handshake | no | depends on Context store | Python |
| **PydanticAI** | `requires_approval=True` + `DeferredToolRequests` output type | no | yes (caller re-runs with results) | Python |
| **CrewAI** | `Task(human_input=True)` + `Agent(allow_delegation=...)` | no | no | Python |
| **Agno** | `@tool(requires_confirmation=True)` + `continue_run()` | no (per-run) | yes (run_id store) | Python |
| **Semantic Kernel** | `IAutoFunctionInvocationFilter` + `context.Terminate` | no | no | .NET + Python + Java |

## Most useful patterns to consider

### LangGraph `interrupt_before`/`interrupt_after` on nodes
The simplest model of "pause before tool execution": graph node configured at compile time to interrupt before/after. For bodhi-pi this is equivalent to "tool-call event handler returns `block: true`, agent emits `pending_approval` lifecycle event, awaits `_bodhi-pi/permission/respond`".

### PydanticAI `DeferredToolRequests` output type
The agent's run completes with a list of pending tool calls; the host resolves them externally and re-invokes with `deferred_tool_results=[...]`. This is interesting for bodhi-pi's **HTTP per-turn-rebuild host**: each turn ends cleanly, the pending approvals are persisted into `SessionStore`, the next request resumes with the user's decisions. Worth considering as a wire pattern for stateless HTTP hosts.

### Agno `requires_confirmation` + `is_paused` + `continue_run()`
Per-tool annotation + run-level pause state + explicit resume method. Cleanest API for stateful long-lived sessions. Bodhi-pi can adapt: `SessionState.pendingApprovals: ApprovalRequest[]`; `prompt-loop.ts` exits early when pending list non-empty; resumes when wire method clears them.

### Semantic Kernel filter pipeline
Filters wrap auto-function-calling and can short-circuit via `Terminate = true`. Bodhi-pi's `tool_call` event already does this via `ToolCallEventResult.block` — no new primitive needed.

## Sources

- [LangGraph types.py](https://github.com/langchain-ai/langgraph/blob/main/libs/langgraph/langgraph/types.py)
- [LangGraph Interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts)
- [AutoGen v0.2 conversable_agent.py](https://github.com/microsoft/autogen/blob/0.2/autogen/agentchat/conversable_agent.py)
- [AutoGen v0.4 UserProxyAgent](https://github.com/microsoft/autogen/blob/main/python/packages/autogen-agentchat/src/autogen_agentchat/agents/_user_proxy_agent.py)
- [DeepAgents HITL middleware](https://reference.langchain.com/python/langchain/agents/middleware/human_in_the_loop/HumanInTheLoopMiddleware)
- [LlamaIndex HITL docs](https://developers.llamaindex.ai/python/framework/understanding/agent/human_in_the_loop/)
- [PydanticAI Deferred Tools](https://pydantic.dev/docs/ai/tools-toolsets/deferred-tools/)
- [CrewAI Human Input](https://docs.crewai.com/how-to/human-input-on-execution)
- [Agno User Confirmation](https://docs.agno.com/execution-control/hitl/user-confirmation)
- [Semantic Kernel Filters](https://learn.microsoft.com/en-us/semantic-kernel/concepts/enterprise-readiness/filters)
