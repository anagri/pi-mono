# Milestone 010 — Foundation + fresh-context single spawn (V1)

> **Status:** ☑ shipped (V1 phase, 2026-05-18 — three commits: `f7d7d421`, `532ee5fc`, `c8e06bf1`).
> **Prerequisite reading:** [`005-architecture-decisions.md`](005-architecture-decisions.md), `../v1-plan.md`, `../retrospective.md`.

## Goal

Land the foundational sub-agent surface end-to-end across all four runtimes: a markdown-discovered profile system, a single LLM tool that spawns one child synchronously inside the parent's turn, a fresh (task-only) context for that child, the session-store + lifecycle plumbing to record the spawn, the wire-level ext methods that let hosts/clients introspect, and the slash-command affordances `/agents` + `/subagent`.

This milestone is the **biggest single landing** in the sub-agent arc — everything later (built-ins, fork, batch, future background mode) layers on the seams introduced here.

## Functional scope

### IN

- **Profile discovery from `.bodhi-pi/agents/*.md`** — markdown files with YAML frontmatter (`name`, `description`, `model?`, `tools?`, `max-turns?`). The first directory found walking up from `cwd` wins; project-scoped only in this milestone.
- **`SubagentProfile` data type** with the field set locked by Decision 2 (profile is source-of-truth): `name`, `description`, `model?`, `context: "fresh"|"fork"` (only `"fresh"` actually exercised in V1; `"fork"` arrives in milestone 030), `tools?`, `maxTurns`, `body`, `filePath`, `source`.
- **`SubagentService`** with a `spawn` method — takes a profile + a task string + the parent session id + a `toolCallId` + an `onUpdate` callback, returns a structured result (status, child session id, summary, error?).
- **`subagent` LLM tool** — registered iff at least one profile was discovered. Schema enumerates profile names so the model can only pick a valid one. Three parameters: `agent`, `task`, `model?`.
- **Three ext methods** under `_bodhi-pi/subagent/*`: `list` (returns profile summaries with metadata), `run` (host-facing single spawn — same internal code path as the LLM tool), `children` (queries `SessionStore` for sessions where `parentSessionId === <given>`).
- **`SessionStore` schema additions** — every record gains an optional `parentSessionId` and an optional `subagent: { profileName }` block. `list()` gains an `includeChildren?: boolean` filter that defaults to `false` so parent-facing UIs don't see children.
- **Two new session-entry variants:** `subagent_link` (the spawn record, appended as the first entry of a child session) and `subagent_complete` (terminal marker for the child).
- **Two `BodhiPiEvent` variants:** `subagent_start` and `subagent_end`. Carry the parent session id, child session id, profile name, task, toolCallId, duration, and status.
- **Depth tracking on `SessionState`** — `subagentDepth: number` (0 for top-level, incremented on spawn). The `subagent` tool is excluded from the child's tool list at any depth ≥ 1, enforcing the hard cap by construction.
- **Two slash commands** in reference hosts (cli, browser, chrome-ext, http): `/agents` (list available profiles), `/subagent <name> <task>` (run one). Implemented host-side, calling the ext methods.

### OUT

- **Built-in profiles** — V1 ships zero bundled profiles; `explore` and `planner` land in milestone 020.
- **Extension-registered profiles** — `ExtensionAPI.registerSubagentProfile` lands in milestone 020.
- **Forked context** — milestone 030. V1 only exercises `context: "fresh"`.
- **Parallel batch tool** — shipped in P2b (milestone 040), retired in Phase 2 (2026-05-19). Parallelism is now achieved by the LLM emitting multiple `subagent` tool calls in one assistant message; pi-agent-core executes them concurrently.
- **Background mode + resume** — milestones 050, 060.
- **MCP for children** — out by Decision 6; children get zero MCP tools in V1.

## Critical interfaces

**Recommendation-level only — current source is the prescriptive reference. Live in `packages/bodhi-pi/src/subagents/` and `packages/bodhi-pi/src/tools/`.**

### `SubagentProfile`
The discovery-time shape that flows from markdown → loader → `SessionState.subagentProfiles[]` → tool-schema enum and child-bootstrap input. Stable fields: `name`, `description`, `context`, `body`, `filePath`, `source`. Optional fields: `model`, `tools`, `disabled`. A `maxTurns` field with a defined default. The profile name is the LLM-visible identifier and must satisfy `^[a-z0-9-]+$`.

### `SubagentService`
A registered core service constructed alongside `ModelRegistry` + `McpService`. Holds refs to `SessionStore`, `EventDispatcher`, the ACP `conn`, the bootstrap factory, and the prompt-loop factory. Exposes:

- `spawn(input): Promise<SpawnResult>` — single-child entry point. Used by both the `subagent` LLM tool and the `_bodhi-pi/subagent/run` ext method.
- Constants exported for external use: `SUBAGENT_MAX_DEPTH` (hard 2), `SUBAGENT_SUMMARY_MAX_CHARS` (4000).
- Internal: bootstraps a fresh `SessionState` for the child, registers it in the `Map<sessionId, SessionState>`, drives `runPromptLoop` to completion, captures the final assistant text into the parent's `tool_result` body, persists `subagent_link` + `subagent_complete` entries, emits `subagent_start` + `subagent_end` lifecycle events.

### `subagent` tool factory
Returns an `AgentTool` with `name: "subagent"`. Description embeds the list of available profiles + per-profile description so the model can pick. Schema: `agent: enum<profile-names>`, `task: string`, `model?: string`. Execute body delegates straight to `SubagentService.spawn` and translates the result to a parent-side `AgentToolResult`.

### Ext-method shapes (informal, see `src/wire/constants.ts` for the names)
- `_bodhi-pi/subagent/list { sessionId } → { profiles: SubagentProfileSummary[] }`
- `_bodhi-pi/subagent/run { sessionId, agent, task, model? } → { status, childSessionId, summary?, error? }`
- `_bodhi-pi/subagent/children { sessionId } → { children: Array<{ sessionId, subagent: { profileName } }> }`

### Session-entry shapes
- `SubagentLinkEntry` — `type: "subagent_link"`, carries `parentSessionId`, `childSessionId`, `profileName`, `task`, `toolCallId`, `depth`, `contextMode` (V1 always `"fresh"`).
- `SubagentCompleteEntry` — `type: "subagent_complete"`, carries `childSessionId`, `status`, `summary?`, `error?`, `durationMs`.

## Behaviour rules (invariants)

1. **Profile name uniqueness** — duplicate names across discovered files trigger a discovery warning and the second occurrence is dropped (milestone 050 cleanup hardens the warnings).
2. **Child session never sees the `subagent` tool** — enforced by depth-cap-2 → tool exclusion (not a runtime check).
3. **Child session never sees any MCP tool** — `mcpToolsByServer` is empty for children.
4. **`subagent_link` is appended BEFORE the child starts**, `subagent_complete` is appended AFTER the child terminates. Replay of `SessionStore` reconstructs the spawn history.
5. **`SessionStore.list()` defaults to excluding children.** Callers that want them must pass `includeChildren: true`.
6. **The child's final assistant message becomes the parent's `tool_result` body**, truncated at 4000 chars with an ellipsis indicator if truncation occurred.
7. **The child's `cancel` propagates from parent** — if the parent's prompt-loop is cancelled, the child's signal aborts mid-turn.
8. **Failure modes:** profile-not-found → tool returns an error result without spawning; child errors → `subagent_complete` records `status: "failed"`; child timeout / cancellation → `status: "cancelled"`. Parent's tool_result always returns; the parent's prompt-loop is never blocked indefinitely.

## Where this sits in the research spectrum

V1 commits bodhi-pi to four of the seven locked decisions:

- **In-process spawn (Decision 1).** Same node/worker; no child process. Forced by the four-runtime parity rule.
- **Profile as source of truth (Decision 2).** The `subagent` tool exposes only `agent`/`task`/`model?`. Everything else is profile-bound.
- **Hard depth-cap-2 (Decision 5).** Enforced by tool exclusion from child tool list.
- **MCP-empty for children (Decision 6).** Children get nothing despite parent registrations.

V1 does NOT commit yet to:
- Decision 3 (separate tools) — only `subagent` exists. Note: Decision 3 was later Superseded in Phase 2 (2026-05-19); the dual-tool stance never made it past P2b.
- Decision 4 (fresh-default) — only fresh exists; the fork option arrives in milestone 030.
- Decision 7 (full-transcript fork) — no fork yet.

Relative to the research spectrum:
- **Execution model:** in-process spawn — closest to cc's in-process fork model, but using a fresh `SessionState` rather than cloning the parent's.
- **Context isolation:** task-only / fresh — closest to OpenCode's default.
- **Lifecycle:** foreground-only — narrower than OpenCode's foreground+background or OpenHands' parallel batch.
- **Return protocol:** structured (final assistant text → tool_result body) — closest to Mastra and Gemini.
- **Profile definition:** markdown discovery only — closest to cc's `.claude/agents/*.md` pattern.

## Tests / coverage

Tests landed in `packages/bodhi-pi/test/` (unit + integration), `packages/bodhi-pi/e2e/shared/` (gpt-4o-mini round-trip), `packages/bodhi-pi/e2e-ui/shared/` (Playwright). See the live test files; sample names:

- Unit: `subagents-discovery.test.ts`, `subagents-spawn.test.ts`, `subagents-list-extmethod.test.ts`, `subagents-cancellation.test.ts`, `subagents-depth-cache.test.ts`, `subagents-failed-eviction.test.ts`, `subagents-llm-invocation.test.ts`, `sessions-subagent-filter.test.ts` (the `includeChildren` filter), `subagents-wire-events.test.ts`.
- e2e (gpt-4o-mini): `subagents.e2e.ts`, `subagents-list.e2e.ts`.
- e2e-ui (Playwright): `subagents.spec.ts`.

The test scaffolding helper `scriptSubagentRun` (in `packages/bodhi-pi/test/helpers/`) gives tests a way to inject a deterministic child run without exercising the LLM — used by spawn/cancellation/failure tests.

## Per-runtime impact

| Runtime | What changed |
|---|---|
| **cli** (`test-apps/cli`) | New REPL slash commands `/agents`, `/subagent <name> <task>`. Discovery walks up from the launch cwd to find `.bodhi-pi/agents/`. |
| **http** (`test-apps/http`) | Per-turn-rebuild model preserves `SessionStore`; child completes within the parent's turn so no cross-request lifecycle is needed. The slash commands fire from the headless e2e harness. |
| **browser** (`test-apps/browser`) | Web Worker hosts the agent; discovery reads from ZenFS-backed `.bodhi-pi/agents/`. React client adds `/agents` + `/subagent` to its slash dispatcher. Children render inline in the conversation panel. |
| **chrome-ext** (`test-apps/chrome-ext`) | Same as browser: MV3 service worker hosts the agent, sidebar client has the slash commands. |

## Follow-ups / open knobs

- Built-in profiles + extension-registered sources → milestone [020](020-profile-sources-and-precedence.md).
- Forked context for richer child input → milestone [030](030-forked-context.md).
- Parallel sub-agent dispatch → LLM emits multiple `subagent` tool calls in one assistant message; concurrent execution by pi-agent-core. (Originally shipped as `subagent_batch` in milestone [040](040-parallel-batch.md); retired in Phase 2.)
- The MCP-empty stance from Decision 6 → unblocked by milestone [070](070-mcp-and-skill-inheritance.md).
- The "discovery warns on dropped files" cleanup work that originally fell out of V1 → hardened during the cleanup wave; current source in `src/subagents/discovery.ts` carries the final form.
