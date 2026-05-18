# Sub-agents — design + implementation tracker

Living set of documents for adding sub-agent support to bodhi-pi. The feature lets the parent LLM delegate focused tasks to specialized child sessions, each with its own profile (model, tool policy, system prompt). The child runs the same `runPromptLoop` machinery the parent uses; its full transcript is durable in SessionStore; only the summary returns to the parent as a tool result.

## Status

**Current phase**: v1 design locked (2026-05-18). Implementation pending user approval of `v1-plan.md`.

**Scope locked for v1** (from brainstorming session 2026-05-18):

- Lean v1: foreground only, single child, fresh-context default, no built-in profiles, no parallel/background.
- Markdown-only profile discovery (`.bodhi-pi/agents/<name>.md`).
- Real child sessions in SessionStore, linked via `parentSessionId`, filtered out of default `listSessions()`.
- First-party `subagent` tool + minimal slash UX (`/agents`, `/subagent`).
- Recursion off by default, max depth 2.
- Canonical e2e scenario: `extractor` profile reads a file and returns a one-sentence summary.

## Read this if…

| Question | Doc |
|---|---|
| What does the final shape look like and why? | [design.md](./design.md) |
| What are we building right now and in what order? | [v1-plan.md](./v1-plan.md) |
| What comes after v1? (Rough only — re-researched per phase) | [roadmap.md](./roadmap.md) |
| What did we defer from v1 and why? | [pending.md](./pending.md) |
| What's the upstream research base? | `../research/sub-agents/` |

## Reference material

- External research synthesis: `../research/sub-agents/Sub-Agent Implementations in Popular Open-Source Agent Harnesses: Research Report for Bodhi-Pi.md`
- Strongest harness references inspected directly:
  - opencode `task.ts` — closest fit; provides the child-session-with-parentID pattern, `<task_result>` framing, and AbortSignal wiring we borrow
  - Mastra `tools.ts:createSubagentTool` — provides the profile-as-enum tool schema and event-emit model we adapt to ACP
  - cc `runAgent.ts` — provides the two-track abort signal pattern, skill preloading idea (deferred), and recursive-guard mechanics
  - pi-coding-agent `pi-subagents` — concepts and slash UX; **process-spawn impl rejected** because browser/chrome-ext/stateless-http cannot fulfill it
- Bodhi-pi spec set being amended: `../specs/bodhi-pi/` (architecture, lifecycle, acp, hosts, testing, extensions-skills-commands)

## What you re-read after a context loss / resume

1. This README (orientation)
2. `design.md` (architecture)
3. `v1-plan.md` (current commit boundaries + remaining work)
4. `retrospective.md` once v1 lands (drives the next phase pick)
