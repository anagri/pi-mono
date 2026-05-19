# Milestone 100 — Advanced slash UX

> **Status:** ☐ pending. Tracked in `../pending.md` as **P4b**. Not yet started.
> **Prerequisite reading:** [`005-architecture-decisions.md`](005-architecture-decisions.md), the `feedback_bodhi_pi_slash_design` memory ("flat-and-complete slashes, no prompts/popups").

## Goal

Extend the host-side slash command surface beyond the current flat `/agents` (list) + `/subagent <name> <task>` (run) to cover the operational patterns users need once the underlying sub-agent feature gets richer (background, batch, resume).

This is a **host-side milestone, not a core milestone** — it adds no `src/` behaviour, only new commands in `test-apps/<host>/src/client/`. The core feature must support whatever the commands invoke; that comes from milestones 050, 060, 070, 080.

## Functional scope

### IN

Candidate commands (the implementing agent picks based on what's actually useful — not all need to ship):

- **`/agents`** — already exists. Extension: show source column (project / extension / builtin) and disabled state. Show status of any running children.
- **`/subagent <name> <task>`** — already exists. Extension: `--background` flag once milestone 050 ships.
- **`/run <name> <task>`** — possible alias of `/subagent` if the shorter name is preferred.
- **`/chain <name1> <task1> <name2> <task2> …`** — sequential dispatch: each step's output is appended to the next step's task description. Implements a manual chain pattern without core changes.
- **`/parallel <name1> <task1> ; <name2> <task2> ; …`** — slash-driven multi-child dispatch. The host emits N `_bodhi-pi/subagent/run` calls in parallel (or a new `_bodhi-pi/subagent/run-many` ext method) so users can trigger concurrency without going through the LLM.
- **`/children`** — list this session's children with status (currently exists as `/subagent children` — could be promoted).
- **`/cancel <childSessionId>`** — cancel a running background child (requires milestone 050).
- **`/resume <childSessionId>`** — re-attach to a child that may have outlived the host process (requires milestone 060).

### OUT

- **A graph/workflow language** — beyond a flat `/chain` or `/parallel`. Workflow handoff is a separate feature.
- **Interactive prompts inside slash commands.** The `feedback_bodhi_pi_slash_design` memory locks the flat-and-complete pattern — slash commands take all their arguments inline, never prompt.
- **A `/agents new` wizard** that helps author a new markdown profile interactively — same reason.
- **TUI-style status panes for running children.** The host renders progress in its standard transcript; no new TUI surfaces.

## Critical interfaces (recommendation-level)

### Slash command shapes
All commands follow the flat-and-complete pattern from the memory:
- `/<verb> [args…]` — every argument required and inline. No follow-up prompts.
- Help is per-command — `/subagent` with no args prints usage.
- Output goes via `ctx.pushSystemMessage` (or equivalent per host) with `data-subagent-event` attributes for Playwright assertions.

### Ext-method dependencies
Most of the proposed commands map to existing `_bodhi-pi/subagent/*` ext methods or extensions thereof:
- `/agents` → `_bodhi-pi/subagent/list`
- `/subagent <name> <task>` → `_bodhi-pi/subagent/run`
- `/children` → `_bodhi-pi/subagent/children`
- `/chain` → repeated `_bodhi-pi/subagent/run` invocations with output stitching
- `/parallel` → would need a `_bodhi-pi/subagent/batch` ext method (currently the batch path is LLM-tool-only)
- `/cancel` → needs a new `_bodhi-pi/subagent/cancel` ext method (milestone 050)
- `/resume` → needs a new `_bodhi-pi/subagent/resume` or extension of `/status` (milestone 060)

### Cross-host parity
Each implemented command lives in all four host clients (`test-apps/cli`, `test-apps/http`, `test-apps/browser`, `test-apps/chrome-ext`) with consistent behaviour. The Playwright shared specs assert this — extend the existing `subagents.spec.ts` family.

## Behaviour rules (invariants this milestone must preserve)

1. **No interactive prompts.** Every command takes its full input inline. Memory: `feedback_bodhi_pi_slash_design`.
2. **No `/thinking` or `/settings`-style cycle conveniences.** Same memory.
3. **Cross-host parity is mandatory.** A command exists in all hosts or in none.
4. **Output is system-message-based** (not modal, not popup, not status-bar). Hosts render system messages with standard styling.
5. **All seven locked architectural decisions still apply.** Slash commands cannot bypass profile-as-source-of-truth, depth-cap-2, etc.

## Where this sits in the research spectrum

cc, Qwen Code, and OpenCode all have slash commands for sub-agent operations (cc's `/agents`, Qwen's `/subagents` for config). Bodhi-pi's current minimal surface is intentionally narrower — this milestone closes selective gaps.

Relative to the spectrum:
- **Invocation-interface axis:** strengthens the slash-command position alongside the existing tool-call position. Both coexist; users dispatch directly while LLMs dispatch via tool.
- **The choice not to ship a workflow language** keeps bodhi-pi on the "primitive operations" side of the spectrum, distinct from LangGraph / AutoGen which ship graph definitions as first-class artefacts.

## Tests / coverage (sketch)

Each implemented command lands with:
- Per-host unit tests on the client-side command parser.
- Shared Playwright assertions in `e2e-ui/shared/` — extending the existing `subagents*.spec.ts` family — that verify the command works in browser/chrome-ext/http hosts.
- cli e2e in `test-apps/cli/e2e/` that verifies the command from a real REPL session.

## Per-runtime impact

| Runtime | Considerations |
|---|---|
| **cli** | REPL slash dispatcher gains new commands. Text-mode rendering of results. |
| **http** | Headless e2e harness exercises commands; HTTP clients (cursor, etc.) see them through the standard `_bodhi-pi/*` channel. |
| **browser** | React slash dispatcher in `test-apps/browser/src/client/lib/commands.ts` gains entries. Output rendered as system messages in the chat panel. |
| **chrome-ext** | Same as browser — sidebar client. |

## Follow-ups / open knobs

- **A `/agents disable <name>`** command — currently `disabled: true` is markdown-only. A live toggle would write back to project settings. Designer's call whether to support.
- **A `/agents reload`** — useful after editing markdown. Currently requires fresh session boot.
- **A `/agents validate`** — lints profiles and prints discovery warnings. Currently warnings only surface at session boot.
- **Telemetry for slash usage** — out of scope but useful for prioritising which commands actually matter.
- **Custom skill-defined slash commands that integrate with sub-agents** — overlaps with the skills feature, not exclusive to this milestone.
