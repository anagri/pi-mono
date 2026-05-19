# Bodhi-pi sub-agents — milestone overview

**Owner role:** AI coding assistant
**Source-of-truth research:** [`../../research/sub-agents/`](../../research/sub-agents/) (the Top-Harness Research Report + per-harness notes for cc, OpenCode, Mastra, Gemini CLI, Qwen Code, OpenHands, OpenAI Agents SDK, AutoGen, LangGraph, Goose, …)
**Companion design + retros:** [`../`](../) — `design.md`, `README.md`, `roadmap.md`, `pending.md`, `retrospective.md`, `v2-retrospective.md`, `p2a-retrospective.md`, `p2b-retrospective.md`
**Companion milestone folder (for format reference):** [`../../research/modes/milestones/`](../../research/modes/milestones/)
**Target spec dir:** [`../../specs/bodhi-pi/`](../../specs/bodhi-pi/)

> ⚠ **READ [005-architecture-decisions.md](005-architecture-decisions.md) BEFORE STARTING ANY MILESTONE.** It locks the architectural choices that diverge from the research spectrum and supersedes any conflicting framing in this overview.

This folder is a **retrospective + forward-looking milestone log** for the sub-agents feature in `packages/bodhi-pi`. Milestones `010-040` are **shipped** — they document what already landed on `main` in commits between 2026-05-18 and 2026-05-19 (the V1/V2/P2a/P2b/cleanup wave). Milestones `050-100` are **pending** — they document gaps relative to the research spectrum that the team has explicitly deferred or not yet sized.

The milestones are intentionally written for AI coding agents who will do their own exploration of the current source. They list functional scope and critical-interface recommendations, not step-by-step implementation prescriptions.

## What we shipped

A foreground-only, in-process sub-agent system with:

- **One LLM tool:** `subagent`. Parallelism happens when the LLM emits multiple `subagent` tool calls in one assistant message; pi-agent-core's `executeToolCallsParallel` runs them concurrently through `Promise.all`.
- **Three profile sources:** project-scoped markdown discovery (`.bodhi-pi/agents/<name>.md`) → extension-registered (`ExtensionAPI.registerSubagentProfile`) → bundled built-ins (`explore`, `planner`).
- **Two context modes:** `fresh` (task-only) and `fork` (filtered parent transcript), selected at profile-discovery time.
- **Three ext methods** on the `_bodhi-pi/subagent/*` namespace: `list`, `run`, `children`.
- **Two flat slash commands** in reference hosts: `/agents` (list) and `/subagent <name> <task>` (run).
- **Two session-entry types:** `subagent_link`, `subagent_complete` — durable in `SessionStore`.
- **Two lifecycle events** on `BodhiPiEvent`: `subagent_start`, `subagent_end`.
- **Identical surface across all four runtimes** (cli, http, browser, chrome-ext) — `src/subagents/` contains no `node:*` imports.

## What we deferred

Six pending milestones, each tied to a research-spectrum capability that bodhi-pi consciously chose not to ship in the first wave:

| # | Capability | Research precedent | Why deferred |
|---|---|---|---|
| 050 | Background execution (fire-and-forget) | OpenCode, Qwen Code | Foreground-only was simpler for the per-turn-rebuild HTTP model; eviction seam already prepared |
| 060 | Resume after disconnect | OpenCode, Qwen Code, cc | Depends on 050 + a re-attach protocol that does not exist yet |
| 070 | MCP + skill inheritance policy | Mastra, cc, Qwen Code | v1–P2b hard-codes children to zero MCP tools to avoid baking a half-finished policy surface |
| 080 | Recursion opt-in | Mastra (unlimited with opt-in); cc (cap=3 with config override) | Hard depth-cap of 2 covers observed use cases; reconsider if real demand for longer chains surfaces |
| 090 | Worktree isolation | cc, Qwen Code | cli-only capability; needs a per-runtime capability gate |
| 100 | Advanced slash UX (`/run`, `/chain`, `/parallel`) | cc, Qwen Code `/subagents` | Flat `/agents` + `/subagent` is sufficient for v1; expansion not yet justified |

## Where we sit in the research spectrum

Bodhi-pi occupies a deliberate middle-ground across the design axes called out in the research report. Quick map:

| Axis | Spectrum | Bodhi-pi today |
|---|---|---|
| Execution model | child-session ↔ in-process fork ↔ peer handoff | **In-process spawn** (same node/worker), child lives in `SessionStore` for foreground execution |
| Context isolation | task-only ↔ summary ↔ slice ↔ full fork | **fresh OR fork** (profile-locked, not per-call); fork is full-transcript-with-filter |
| Tool policy | inherited ↔ derived ↔ restricted ↔ recursion-gated | **Derived from profile + recursion-gated**; MCP hard-empty for children in v1 |
| Invocation interface | tool ↔ slash ↔ workflow node | **Tool** (`subagent`) primary; flat `/agents` + `/subagent <name> <task>` as host-side affordance |
| Lifecycle | foreground ↔ background resume | **Foreground only**, with concurrent dispatch when the LLM emits multiple `subagent` calls in one turn (pi-agent-core handles the parallelism); background + resume deferred to milestones 050/060 |
| Return protocol | structured ↔ synthetic injection ↔ inline transcript | **Structured** (final assistant message → parent tool_result, truncated at 4000 chars) |
| Profile definition | code-defined ↔ markdown-defined ↔ runtime-discovered | **All three:** project markdown > extension-registered > bundled built-in |

This positioning is locked by [005-architecture-decisions.md](005-architecture-decisions.md); changing it would require a new decision doc.

## Milestone sequence

| # | Title | Status | Brief |
|---|---|---|---|
| [005](005-architecture-decisions.md) | **Architecture decisions (READ FIRST)** | locked | Locks in-process spawn, profile-as-source-of-truth, single `subagent` tool with LLM-driven parallelism, fresh-context default, depth-cap-2, MCP-empty-for-children, full-transcript fork filter. Not an implementation milestone. |
| [010](010-foundation-and-fresh-context.md) | Foundation + fresh-context single spawn (V1) | ☑ shipped | `SubagentService`, `subagent` LLM tool, markdown profile discovery, `parentSessionId` on `SessionStore`, depth tracking, session entries, `_bodhi-pi/subagent/{list,run,children}` ext methods, `/agents` + `/subagent` slashes. Foreground, fresh-context-only, single child. |
| [020](020-profile-sources-and-precedence.md) | Profile sources + precedence (V2) | ☑ shipped | Bundled `explore` + `planner` built-ins, `ExtensionAPI.registerSubagentProfile`, three-way merge (project > extension > builtin), `source` field, `disabled` override. |
| [030](030-forked-context.md) | Forked context (P2a) | ☑ shipped | `context: "fork"` profile field, full-transcript clone with `SUBAGENT_FORK_FILTER` exclusion, `contextMode` on link + lifecycle entries. Profile-locked (no per-call override). |
| [050](050-background-execution.md) | Background execution | ☐ pending | Fire-and-forget children with `subagent_status` polling tool + synthetic result injection (OpenCode pattern). Cross-turn lifecycle is the hard part. |
| [060](060-resume-after-disconnect.md) | Resume after disconnect | ☐ pending | Re-attach to running child after tab close / parent process restart. Requires 050 + a re-attach protocol that survives `SessionStore` rehydration. |
| [070](070-mcp-and-skill-inheritance.md) | MCP + skill inheritance policy | ☐ pending | Per-profile MCP allow/deny lists, profile-declared skill dependencies. Replaces the v1–P2b hard-empty MCP stance. |
| [080](080-recursion-opt-in.md) | Recursion opt-in | ☐ pending | Opt-in recursion past the hard depth-cap of 2 — gated by a per-profile flag, capped at a new bounded depth. |
| [090](090-worktree-isolation.md) | Worktree isolation | ☐ pending | cli-only worktree per child (cc / Qwen Code pattern), gated by a per-runtime capability flag. |
| [100](100-advanced-slash-ux.md) | Advanced slash UX | ☐ pending | `/run`, `/chain`, `/parallel` and friends beyond the flat `/agents` + `/subagent`. `/parallel` is a host-side `Promise.all` of `_bodhi-pi/subagent/run` calls, not a new ext method. Cross-host parity required. |

## Cross-cutting conventions

### Format of each milestone

Each milestone file follows roughly this shape (heavier sections expanded only when relevant to that milestone):

- **Status** — shipped commits OR "not yet started" + dependencies
- **Goal** — one paragraph
- **Functional scope** — what's IN and OUT
- **Critical interfaces** — only the named public seams (`SubagentService.spawn`, `SubagentProfile`, ext-method shapes) with recommendation-level shape. AI agents read current source for exact types.
- **Behaviour rules** — invariants that hold across runtimes
- **Where this sits in the research spectrum** — short paragraph on what was chosen vs the alternatives, and why
- **Tests / coverage** — for shipped: file pointers + counts; for pending: test-plan sketch
- **Per-runtime impact** — cli / http / browser / chrome-ext
- **Follow-ups / open knobs** — links forward to pending milestones

### How AI assistants should consume this folder

1. Read `000-overview.md` (this file) for the map.
2. Read `005-architecture-decisions.md` to internalise the locked choices.
3. For **shipped** milestones (010–040): treat the milestone as a retrospective. The doc lists what's in the code today; the code itself is the prescriptive source of truth. Use the milestone to understand the *intent* and the *rationale* before reading source.
4. For **pending** milestones (050–100): treat the milestone as a scoping doc. The doc lists the functional surface + behaviour rules + open design choices. The AI agent does its own current-state exploration before proposing the technical plan.
5. Cross-reference research notes in `../../research/sub-agents/` for any harness comparison.

### Status conventions

- ☑ shipped — the work landed on `main`; current code is the authoritative reference
- ◑ partial — the work shipped a subset of the scope; the milestone notes what's missing
- ☐ pending — no implementation work has started

There are no ◑ rows in this initial cut — every shipped milestone landed its full scope (cleanup work was folded back into the relevant phase rather than tracked as partial).

### Stale framing to ignore

- The `roadmap.md` and `pending.md` sibling docs are the source-of-truth for phase boundaries; the milestone numbers in this folder are independent and do not match the v1/v2/P2a/P2b/P3a/P3b labels one-to-one. The milestone-status table above is the mapping.
- The original `design.md` predates several P2a/P2b decisions; check it for high-level intent only, not for current behaviour. Where they conflict, the milestone files and the live source win.
