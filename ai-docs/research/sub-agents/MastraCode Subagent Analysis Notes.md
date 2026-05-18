# MastraCode Subagent Analysis Notes

## Scope

Repository: `mastra-ai/mastra`, folder `mastracode`. This analysis extends the prior Bodhi-Pi sub-agent research report by separating MastraCode’s coding-agent usage of subagents from the generic Mastra core harness implementation.

## MastraCode subagent definitions

MastraCode defines built-in subagents under `mastracode/src/agents/subagents/`, including `explore`, `plan`, `execute`, and `audit-tests`. These definitions are registered by the MastraCode composition root in `mastracode/src/index.ts` and are passed into the Mastra core Harness as configured `HarnessSubagent` entries.

The subagents form distinct delegation profiles. `explore` is read-only codebase investigation. `plan` is read-only planning and design. `execute` can edit files and run implementation commands. `audit-tests` is a specialized verification subagent that can be used alone, unlike the general rule that subagents should be spawned in parallel batches.

## Mastra core runtime connection

MastraCode relies on Mastra core’s `createSubagentTool()` in `packages/core/src/harness/tools.ts`. The runtime exposes one `subagent` tool with schema fields `agentType`, `task`, optional `modelId`, and optional `forked`. It supports two execution paths:

1. Non-forked path: creates a fresh `Agent` with the selected subagent’s instructions, model, constrained tools, and workspace-tool allowlist. The request context strips the parent thread/resource IDs so the subagent does not enrich or mutate the parent memory thread.
2. Forked path: reuses the parent agent, flushes pending parent messages, clones the parent memory thread, runs against the cloned thread/resource, inherits parent toolsets, and patches recursive `subagent` calls and parent task-list tools so the schema stays cache-stable while runtime recursion and parent-task mutation are blocked.

## Prompt policy

`mastracode/src/agents/prompts/base.ts` includes explicit Subagent Rules. The main agent is instructed to use subagents only when spawning multiple subagents in parallel, except that `audit-tests` may be used alone. It should use `forked: true` when the delegate needs current conversation context, prior tool results, user-stated facts, or the parent tool environment. It should use non-forked subagents for self-contained tasks. Subagent outputs are explicitly untrusted and must be reviewed and verified by the parent.

## User-facing configuration

`mastracode/src/tui/commands/subagents.ts` implements a `/subagents` slash command. It discovers configured subagents from `harness.config.subagents`, falling back to built-in `Explore`, `Plan`, and `Execute` options. The user selects a subagent type, chooses thread-level or global scope, then selects a model from `harness.listAvailableModels()`. The command calls `harness.setSubagentModelId({ modelId, agentType })`; for global scope it persists to settings at `settings.models.subagentModels[agentType]`.

## Runtime UI and eventing

Mastra core emits structured events: `subagent_start`, `subagent_text_delta`, `subagent_tool_start`, `subagent_tool_end`, and `subagent_end`. MastraCode handles these in `mastracode/src/tui/handlers/subagent.ts` and renders a first-class `SubagentExecutionComponent` (`mastracode/src/tui/components/subagent-execution.ts`). The component stores agent type, task, model ID, nested tool calls, completion/error status, duration, final result, and whether the run is forked. It renders a bordered live box with the task, rolling nested tool activity, optional expanded final result, and footer `subagent <type/model/status>` or `subagent fork ...` for forked runs.

## History rendering

`mastracode/src/tui/render-messages.ts` special-cases historical `subagent` tool calls. It reconstructs `SubagentExecutionComponent` from the tool call arguments and result metadata, including `agentType`, `task`, `modelId`, `forked`, duration, and nested tool calls when available. Current core avoids appending model-facing metadata tags for new runs to prevent the parent model from echoing them, while preserving parsing for older persisted threads.

## Key design implications

MastraCode is one of the most relevant examples for Bodhi-Pi because it separates policy, configuration, runtime execution, eventing, and UI. The implementation is particularly notable for the dual non-forked/forked model, prompt-cache-preserving forked execution, per-subagent model routing, event-based nested progress rendering, and explicit trust-boundary rules.
