# Sub-agents v1 — kickoff plan

## Context

Bodhi-pi has no sub-agent surface. Coding-agent-style harnesses (cc, opencode, Mastra) and the pi-coding-agent extension (`pi-subagents`) all ship some flavor of "delegate this task to a specialist child" — bodhi-pi is the only one missing the primitive.

The constraint that shaped this v1 design: bodhi-pi must run in Node CLI, Node HTTP server (per-turn agent rebuild), browser Web Worker, and Chrome MV3 service worker. `pi-subagents`-style process spawn is out — it would break the three non-Node runtimes. The shape that fits is **in-process child Sessions** created in the existing `SessionStore`, driven by the existing `runPromptLoop`, with the result returned as a normal tool result to the parent.

This kickoff lands the minimal v1: foreground only, single child, fresh-context default, markdown-only profile discovery (`.bodhi-pi/agents/<name>.md`), child sessions persisted with `parentSessionId` and filtered out of default `listSessions()`, first-party `subagent` tool + minimal slash UX (`/agents`, `/subagent <name> <task>`), recursion off by default with a hard cap at depth 2. Forked context, parallel, background, bundled profiles, extension-registered profiles, worktree isolation, and MCP inheritance all defer to phase 2+ — tracked in [`ai-docs/sub-agents/roadmap.md`](../sub-agents/roadmap.md) and [`ai-docs/sub-agents/pending.md`](../sub-agents/pending.md).

The intended outcome: a user with `.bodhi-pi/agents/extractor.md` in their cwd can type "Use the extractor agent to summarize doc.md" in any of the 4 reference Hosts and see the parent LLM invoke a child run that reads the file and returns a one-sentence summary — with the child run durable in SessionStore for later inspection.

## Authoritative documents

- [`ai-docs/sub-agents/design.md`](../sub-agents/design.md) — architecture, runtime mechanics (registration, spawn, child↔parent↔Host comms, finish, cancellation), file inventory, harness research mapping
- [`ai-docs/sub-agents/v1-plan.md`](../sub-agents/v1-plan.md) — **authoritative commit-by-commit plan**. This kickoff file does NOT duplicate it; treat `v1-plan.md` as the operational spec
- [`ai-docs/sub-agents/roadmap.md`](../sub-agents/roadmap.md) — rough phase 2+ sketches (re-researched per phase)
- [`ai-docs/sub-agents/pending.md`](../sub-agents/pending.md) — deferred-from-v1 inventory
- [`ai-docs/sub-agents/README.md`](../sub-agents/README.md) — index of the above

## Approach (summary of `v1-plan.md`)

Three commits, depth-first per runtime per the bodhi-pi parity rule. Each commit lands across all 4 reference Hosts (`test-apps/{cli,http,browser,chrome-ext}`) plus the relevant `test/`, `e2e/`, and `e2e-ui/` slices, and ends green on `npm run check` plus its new tests before the next commit starts.

**C1 — Discovery scaffold.** Profile discovery + extension methods + SessionStore `parentSessionId` plumbing additive across in-memory, node SQLite, Dexie. `subagent` tool registered conditionally on profiles existing, body throws `"not yet implemented"`. Spec updates in `ai-docs/specs/bodhi-pi/`.

**C2 — Spawn + foreground run.** `SubagentService.spawn` works end-to-end. Child Session created with `parentSessionId`, `subagent_link` / `subagent_complete` entries persisted, `buildChildSessionState` constructs a child SessionState with a filtered tool list (excludes `subagent` unconditionally, no MCP in v1), `runPromptLoop` drives the child, progress mirrored to the parent's `tool_call_update` channel, `subagent_start` / `subagent_end` events emit. Canonical e2e scenario (extractor + `doc.md` → assert "fox") passes against `gpt-4o-mini` in all 4 vitest projects. Recursion guarded at depth 2.

**C3 — Slash UX + Playwright.** `/agents` and `/subagent <name> <task>` slashes added to each Host's client dispatcher. `e2e-ui/shared/subagents.spec.ts` Playwright spec for browser + chrome-ext drives the canonical scenario end-to-end through the UI.

## Critical files to modify

Full inventory in [`design.md` § File-level inventory of additions](../sub-agents/design.md#file-level-inventory-of-additions). The headline paths:

**New (`src/subagents/`):**
- `src/subagents/types.ts` — `SubagentProfile`, `SubagentSpawnInput`, `SubagentResult`
- `src/subagents/discovery.ts` — `loadProjectSubagents(filesystem, cwd)`
- `src/subagents/subagent-service.ts` — `SubagentService` (handlers + `spawn`)
- `src/subagents/build-child-state.ts` — `buildChildSessionState`
- `src/subagents/system-prompt.ts` — `composeSubagentSystemPrompt`

**New tool:**
- `src/tools/subagent.ts` — `createSubagentTool(deps)`

**Touched existing:**
- `src/tools/index.ts` — extend `ToolDeps` + `BUILTIN_TOOL_SNIPPETS`
- `src/sessions/entries.ts` — `+SubagentLinkEntry`, `+SubagentCompleteEntry` on the union
- `src/sessions/session-store.ts` — `+parentSessionId` on records; `+includeChildren` on list
- `src/sessions/in-memory-session-store.ts` — implement above
- `src/sessions/session-state.ts` — `+subagentProfiles`
- `src/sessions/session-bootstrap.ts` — wire profile loading + conditional tool registration
- `src/sessions/build-context.ts` — filter the two new entry types from LLM context
- `src/acp/agent.ts` — construct `SubagentService`, flatten its handlers into `extHandlers`
- `src/wire/constants.ts` — `EXT_SUBAGENT_LIST`, `EXT_SUBAGENT_RUN`, `EXT_SUBAGENT_CHILDREN`
- `src/events/types.ts` — `+SubagentStartEvent`, `+SubagentEndEvent`
- `src/index.ts` — export new public types

**Adapters (test-apps):**
- `test-apps/node-adapters/src/sessions/...` — additive `parent_session_id` nullable column
- `test-apps/browser/src/host/sessions/...` — additive Dexie field (no index → auto-upgrades)
- `test-apps/{cli,http,browser,chrome-ext}/src/client/slash/...` — `/agents` + `/subagent` dispatchers (C3)
- `test-apps/app-utils/...` — shared `parseSubagentArgs` parser (C3)

**Spec updates (same commit as code per the "specs are living docs" rule):**
- `ai-docs/specs/bodhi-pi/index.md` — new row in "Read this if…" table
- `ai-docs/specs/bodhi-pi/subagents.md` — NEW spec doc
- `ai-docs/specs/bodhi-pi/acp.md` — three new `_bodhi-pi/subagent/*` methods
- `ai-docs/specs/bodhi-pi/lifecycle.md` — two new SessionEntry types
- `ai-docs/specs/bodhi-pi/extensions-skills-commands.md` — new "Sub-agent profile" peer
- `ai-docs/specs/bodhi-pi/hosts.md` — new built-in slashes in dispatcher tables
- `packages/bodhi-pi/CONTEXT.md` — glossary entries

## Existing patterns reused

- `src/skills/discovery.ts` and `src/commands/discovery.ts` — discovery pattern (markdown walk, frontmatter parse, sort by name). `loadProjectSubagents` is structurally identical.
- `src/_internal/frontmatter.ts` — frontmatter parser
- `src/mcp/mcp-service.ts` — `register()` pattern returning `[[method, handler], ...]` flattened into `extHandlers`; `SubagentService` follows the same shape
- `src/sessions/session-bootstrap.ts:210` `buildSessionState` — `buildChildSessionState` is a small variant
- `src/acp/prompt-loop.ts` `runPromptLoop` — the child is driven by the same function used for top-level prompts; no re-implementation
- `src/sessions/_shared.ts` `extractText` — used to extract the child's last assistant text for the parent's tool result
- `src/sessions/session-graph-service.ts` `_bodhi-pi/session/fork` — sibling pattern for child-session creation (we don't reuse the method, but reference its handling of parent linkage)

## Verification

Each commit has its own acceptance gate. Detailed per-commit assertions are in [`v1-plan.md`](../sub-agents/v1-plan.md) under each commit's "Acceptance" section. The end-of-v1 verification is:

1. `npm run check` from repo root — green (no TS errors, no lint, no seam violations).
2. `npm test` from `packages/bodhi-pi/` — all `test/subagents-*.test.ts` and `test/sessions-parent-id.test.ts` pass.
3. `npx tsx ../../node_modules/vitest/dist/cli.js --run e2e/shared/subagents.e2e.ts` and `e2e/shared/subagents-list.e2e.ts` — pass across all 4 vitest projects (in-memory, cli, http, ws). The canonical scenario asserts the parent's final assistant text contains "fox".
4. `npx playwright test e2e-ui/shared/subagents.spec.ts` — passes for both browser and chrome-ext projects. Asserts the chat shows the subagent tool call, progress updates render, and the parent's final text contains "fox".
5. Manual smoke: `npm run dev` in `test-apps/cli` with the agents fixture seeded → type `/subagent extractor summarize doc.md` → see the run complete with a one-sentence summary.

## Post-v1

Per [`v1-plan.md` § After v1 lands](../sub-agents/v1-plan.md): write `retrospective.md` (what surprised vs design, what was harder/easier, what changes in roadmap), then refine `roadmap.md` and present the next phase pick for approval before kicking off.
