from pathlib import Path

path = Path('/home/ubuntu/subagent_research/bodhi_pi_subagents_deep_research_report.md')
text = path.read_text()

# Backup
backup = path.with_suffix('.before_mastracode.md')
backup.write_text(text)

text = text.replace(
    "This pattern is used most concretely by opencode, Qwen Code, Gemini CLI, Goose, OpenAI Codex, OpenHands, Mastra, and LangChain DeepAgents, though each makes different choices about history isolation, event streaming, background tasks, and permissions.[^opencode-task] [^qwen-agent] [^gemini-agent-tool] [^goose-handler] [^codex-thread-manager] [^openhands-delegation] [^mastra-tools] [^deepagents-subagents]",
    "This pattern is used most concretely by opencode, Qwen Code, Gemini CLI, Goose, OpenAI Codex, OpenHands, Mastra/MastraCode, and LangChain DeepAgents, though each makes different choices about history isolation, event streaming, background tasks, and permissions.[^opencode-task] [^qwen-agent] [^gemini-agent-tool] [^goose-handler] [^codex-thread-manager] [^openhands-delegation] [^mastra-tools] [^mastracode-index] [^deepagents-subagents]"
)

text = text.replace(
    "| **Mastra** | `createSubagentTool` in harness tools | Subagent run under harness metadata | Schema-driven tool parameters and agent definitions | Streams subagent output/events and returns structured result |",
    "| **Mastra / MastraCode** | `createSubagentTool` plus MastraCode built-in subagent definitions | Non-forked child agent with isolated request context, or forked cloned parent thread | Per-subagent instructions, tools, workspace-tool allowlists, model routing, forked recursion guards | Emits structured lifecycle events, renders live nested tool traces in MastraCode, and returns final text to parent |"
)

insert_after = "OpenAI Codex is notable because it exposes subagent spawning through the extension API. Its app server extension surface includes subagent-related hooks, and its core thread manager implements subagent spawning by creating a new thread with a subagent source and forked context.[^codex-extension] [^codex-thread-manager] This is directly relevant to Bodhi-Pi’s extension system: a sub-agent feature can remain core-owned while still being callable by extensions or exposed as an extension capability."
mastracode_para = """

MastraCode deserves separate treatment from generic Mastra because it shows how a TypeScript coding agent can productize sub-agents end-to-end rather than merely expose a framework primitive. MastraCode registers built-in `explore`, `plan`, `execute`, and `audit-tests` subagents from `mastracode/src/agents/subagents/` into the Mastra harness configuration.[^mastracode-index] These profiles are not interchangeable labels. `explore` is a read-only investigation delegate, `plan` is a read-only planning delegate, `execute` is a write-capable implementation delegate, and `audit-tests` is a specialized verification delegate that the main prompt explicitly permits using alone.[^mastracode-base] This is a useful pattern for Bodhi-Pi because it separates **delegation profiles** from the lower-level child-session executor.

The Mastra core runtime also has one of the clearest implementations of **dual-mode delegation**. In the non-forked path, `createSubagentTool()` creates a fresh `Agent` with the selected subagent’s instructions, resolved model, constrained tools, optional allowed harness tools, and optional workspace-tool allowlist; it copies request-scoped state but removes the parent thread/resource IDs so the subagent does not mutate or enrich the parent memory thread.[^mastra-tools] In the forked path, the same tool flushes pending parent messages, clones the parent thread, reuses the parent agent and parent toolsets for prompt-cache stability, repoints the harness context to the forked thread/resource, and patches the inherited `subagent` and parent task-list tools at runtime so the model sees the same schemas while recursive sub-agent spawning and parent task-list mutation fail safely.[^mastra-tools] This is more sophisticated than most harnesses inspected because it treats forked subagents as a cache-preserving execution mode rather than simply passing more history to a new child prompt.

MastraCode adds the policy and UX layers around that runtime. Its base prompt instructs the parent agent to use subagents only when spawning **multiple subagents in parallel**, except for `audit-tests`; to choose `forked: true` when the delegate needs the current conversation, prior tool results, user-stated facts, or the parent tool environment; and to treat every subagent result as untrusted until reviewed and verified.[^mastracode-base] The `/subagents` command lets users configure model routing per subagent type, with either thread-local defaults or global defaults persisted in settings, and it discovers custom configured subagents from `harness.config.subagents` instead of hard-coding only built-ins.[^mastracode-command] Runtime events are first-class as well: Mastra core emits `subagent_start`, `subagent_text_delta`, `subagent_tool_start`, `subagent_tool_end`, and `subagent_end`; MastraCode handles those events and renders a dedicated `SubagentExecutionComponent` with the task, nested tool activity, model ID, fork label, duration, status, and expandable final result.[^mastracode-handler] [^mastracode-component] Historical rendering also special-cases persisted `subagent` tool calls so old conversations replay as subagent execution boxes rather than generic tool output.[^mastracode-render]
"""
text = text.replace(insert_after, insert_after + mastracode_para)

text = text.replace(
    "| 16 | Mastra | 23k | Strong | Harness subagent tool | `createSubagentTool` with schema, streaming, metadata, result handling |",
    "| 16 | Mastra / MastraCode | 23k | Very strong | Harness subagent tool plus coding-agent profiles | `createSubagentTool` supports non-forked/forked modes; MastraCode adds explore/plan/execute/audit-tests profiles, per-type model routing, subagent prompt policy, and dedicated TUI event rendering |"
)

text = text.replace(
    "Bodhi-Pi should avoid copying a single framework wholesale. Instead, it should combine three ideas: opencode’s durable child-session task tool, Gemini/Qwen’s configurable local executor abstraction, and LlamaIndex/AutoGen’s explicit handoff metadata. The result should be a sub-agent subsystem that feels native to Bodhi-Pi’s ACP and extension architecture.",
    "Bodhi-Pi should avoid copying a single framework wholesale. Instead, it should combine four ideas: opencode’s durable child-session task tool, Gemini/Qwen’s configurable local executor abstraction, MastraCode’s profile/model-routing/event-UX polish, and LlamaIndex/AutoGen’s explicit handoff metadata. The result should be a sub-agent subsystem that feels native to Bodhi-Pi’s ACP and extension architecture."
)

text = text.replace(
    "| Model policy | Agent profile may override model; otherwise inherit parent model/provider | Mirrors opencode/OpenHands while preserving Bodhi-Pi model registry behavior |",
    "| Model policy | Agent profile may override model; otherwise inherit parent model/provider; allow per-subagent-type thread/global defaults | Mirrors opencode/OpenHands while preserving Bodhi-Pi model registry behavior and MastraCode-style user control |"
)

text = text.replace(
    "| Progress | Parent tool-call updates with child session ID, recent activity, text snippets, and status | Reuses ACP event semantics and avoids special UI transport |",
    "| Progress | Parent tool-call updates with child session ID, recent activity, nested tool traces, text snippets, fork flag, model ID, duration, and status | Reuses ACP event semantics while adopting MastraCode’s first-class subagent activity rendering model |"
)

text = text.replace(
    "Bodhi-Pi should introduce `SubagentProfile` definitions. A profile should contain `name`, `description`, `systemPrompt` or `systemPromptSuffix`, optional `model`, allowed tools, denied tools, MCP access policy, extension access policy, maximum turns, maximum tokens, and context policy defaults. Profiles can be built-in and extension-contributed. This is the point where Bodhi-Pi can borrow from Gemini CLI’s local agent definitions, Qwen’s explicit/forked subagent distinction, and OpenHands’ built-in/custom child-agent registry.",
    "Bodhi-Pi should introduce `SubagentProfile` definitions. A profile should contain `name`, `description`, `systemPrompt` or `systemPromptSuffix`, optional `model`, allowed tools, denied tools, MCP access policy, extension access policy, maximum turns, maximum tokens, and context policy defaults. Profiles can be built-in and extension-contributed. This is the point where Bodhi-Pi can borrow from Gemini CLI’s local agent definitions, Qwen’s explicit/forked subagent distinction, OpenHands’ built-in/custom child-agent registry, and MastraCode’s concrete coding profiles such as read-only exploration, read-only planning, write-capable execution, and test-audit verification."
)

text = text.replace(
    "| UI overload | Streaming every child token into parent may clutter ACP UI | Send summarized progress updates; link to child session for full transcript |",
    "| UI overload | Streaming every child token into parent may clutter ACP UI | Send summarized progress updates; link to child session for full transcript; optionally render MastraCode-style expandable nested activity boxes |"
)

# Add citations before final EOF
refs = """
[^mastracode-index]: [`mastracode/src/index.ts` — MastraCode composition root and subagent registration](https://github.com/mastra-ai/mastra/blob/main/mastracode/src/index.ts).
[^mastracode-base]: [`mastracode/src/agents/prompts/base.ts` — MastraCode prompt-level subagent rules](https://github.com/mastra-ai/mastra/blob/main/mastracode/src/agents/prompts/base.ts).
[^mastracode-command]: [`mastracode/src/tui/commands/subagents.ts` — MastraCode `/subagents` model-selection command](https://github.com/mastra-ai/mastra/blob/main/mastracode/src/tui/commands/subagents.ts).
[^mastracode-handler]: [`mastracode/src/tui/handlers/subagent.ts` — MastraCode subagent event handlers](https://github.com/mastra-ai/mastra/blob/main/mastracode/src/tui/handlers/subagent.ts).
[^mastracode-component]: [`mastracode/src/tui/components/subagent-execution.ts` — MastraCode subagent execution renderer](https://github.com/mastra-ai/mastra/blob/main/mastracode/src/tui/components/subagent-execution.ts).
[^mastracode-render]: [`mastracode/src/tui/render-messages.ts` — MastraCode historical subagent rendering](https://github.com/mastra-ai/mastra/blob/main/mastracode/src/tui/render-messages.ts).
"""
if '[^mastracode-index]' not in text:
    text = text.rstrip() + '\n' + refs

path.write_text(text)
print(f'Updated report: {path}')
print(f'Backup saved: {backup}')
