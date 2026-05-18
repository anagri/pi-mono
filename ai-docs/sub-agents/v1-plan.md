# v1 implementation plan

3 commits, depth-first per runtime. Each commit ends green on `npm run check` plus the new tests it adds. Per the trunk-based contract, each commit is bisectable.

Per memory `no mid-task pauses`: once this plan is approved, execute C1 → C2 → C3 straight through, reading code/web for ambiguous decisions but not pausing for confirmation.

## Pre-flight check

Before C1 starts:

- Re-read `packages/bodhi-pi/CLAUDE.md` (import policy, comment policy, no `node:*` in `src/`, trunk-based contract, runtime parity rule).
- Re-read `ai-docs/specs/bodhi-pi/extensions-skills-commands.md` (contribution model — sub-agent profiles will peer with Commands/Skills here).
- Confirm `gpt-4o-mini` is currently the e2e default model.
- Skim the existing `src/skills/discovery.ts` and `src/commands/discovery.ts` — `loadProjectSubagents` follows the same pattern.
- Skim the existing `_bodhi-pi/session/fork` handler in `SessionGraphService` — child Session creation reuses similar SessionStore primitives.

## Canonical e2e scenario (used by both `subagents.e2e.ts` and `subagents.spec.ts`)

Fixtures (created in `e2e/data/agents-fixture/`):

- `<cwd>/doc.md` content: `The quick brown fox jumps over the lazy dog.`
- `<cwd>/.bodhi-pi/agents/extractor.md`:

```
---
name: extractor
description: Read a file and return a one-sentence summary.
tools:
  - read
---
You are an extractor sub-agent. Read the file at the absolute path given in the task, then return a single-sentence summary of its content. Do not edit, write, or run scripts.
```

Flow:

1. User prompt to parent: `Use the extractor agent to summarize {cwd}/doc.md.`
2. Parent LLM invokes `subagent({ agent: "extractor", task: "summarize {cwd}/doc.md" })`.
3. Child runs (gpt-4o-mini), uses `read`, returns one-sentence summary.
4. Assertions:
   - Parent's final assistant text contains `fox` (deterministic anchor).
   - `_bodhi-pi/subagent/children?sessionId=<parentId>` returns one child.
   - Loading the child session shows the `subagent_link` and `subagent_complete` entries plus the `read` + assistant turns.
   - Default `session/list` (no `includeChildren`) does NOT show the child.

## Commit C1 — Discovery scaffold

**Goal**: Profile discovery + extension method work end-to-end across all 4 runtimes. The `subagent` tool is registered conditionally but throws "not yet implemented" when invoked. SessionStore gains `parentSessionId` plumbing additively.

**Files added/changed**:

src/:

- `src/subagents/types.ts` — `SubagentProfile { name, description, model?, context?, tools?, maxTurns?, body }`; `SubagentSpawnInput`; `SubagentResult`.
- `src/subagents/discovery.ts` — `loadProjectSubagents(filesystem, cwd)` walks `<cwd>/.bodhi-pi/agents/*.md`, parses frontmatter via existing `src/_internal/frontmatter.ts`, validates `name` regex `^[a-z0-9-]+$`, returns sorted list. Pattern mirrors `src/commands/discovery.ts`.
- `src/subagents/subagent-service.ts` — class skeleton:
  - `register()` returns `[[EXT_SUBAGENT_LIST, handleList], [EXT_SUBAGENT_RUN, handleRunStub], [EXT_SUBAGENT_CHILDREN, handleChildren]]`.
  - `handleList(params)` → reads `SessionState.subagentProfiles`, returns list.
  - `handleRunStub(params)` → throws `not yet implemented` (becomes real in C2).
  - `handleChildren(params)` → calls `sessionStore.list({ includeChildren: true })` filtered by `parentSessionId === params.sessionId`.
  - `spawn()` stub that throws.
- `src/tools/subagent.ts` — `createSubagentTool(deps)`:
  - Schema enumerates profile names as `Type.Union(Literal(...))`.
  - Description generated from profile list.
  - Execute body throws `not yet implemented` (becomes real in C2).
- `src/tools/index.ts` — extend `ToolDeps` with optional `subagent: { sessionId, profiles, service }`; emit the tool conditionally; add `subagent` entry to `BUILTIN_TOOL_SNIPPETS`.
- `src/sessions/session-store.ts` — add optional `parentSessionId?: string | null` to `SessionRecord` / `SessionInfo` / `CreateSessionInput`; add `includeChildren?: boolean` to `ListSessionsRequest`.
- `src/sessions/in-memory-session-store.ts` — implement `parentSessionId` field + `includeChildren` filter.
- `src/sessions/session-state.ts` — add `subagentProfiles: SubagentProfile[]`.
- `src/sessions/session-bootstrap.ts` — `loadProjectArtifacts` returns `subagentProfiles`; `buildSessionState` stores them on SessionState; `createBuiltinTools` is called with the conditional `subagent` block when profiles exist.
- `src/acp/agent.ts` — construct `SubagentService` in constructor (deps: `sessionStore`, `sessions` map; spawn deps wired in C2); flatten its `register()` into `extHandlers`.
- `src/wire/constants.ts` — `EXT_SUBAGENT_LIST`, `EXT_SUBAGENT_RUN`, `EXT_SUBAGENT_CHILDREN`.
- `src/index.ts` — export `SubagentProfile` type + the three constants + `SubagentService` (the class is internal but type might need export if consumed by adapters).

test-apps:

- `test-apps/node-adapters/src/sessions/...` — Node SQLite session store gets the new column. Migration: `ALTER TABLE sessions ADD COLUMN parent_session_id TEXT` (nullable). Read existing schema.ts patterns first.
- `test-apps/browser/src/host/sessions/...` — Dexie schema gets `parentSessionId?: string` in the SessionInfo interface; Dexie auto-handles since we're not indexing by it.

Specs:

- `ai-docs/specs/bodhi-pi/index.md` — new "Sub-agents" row in "Read this if…" table → links to `subagents.md`.
- `ai-docs/specs/bodhi-pi/subagents.md` — new spec doc covering the public surface, profile format, runtime mechanics (mostly a port of `design.md` in spec-shape).
- `ai-docs/specs/bodhi-pi/acp.md` — add the three `_bodhi-pi/subagent/*` extension methods to the table.
- `ai-docs/specs/bodhi-pi/extensions-skills-commands.md` — add a row/column for "Sub-agent profile" peer.
- `packages/bodhi-pi/CONTEXT.md` — add `Sub-agent`, `Sub-agent profile`, `Child session`, `Sub-agent depth` to the glossary.

Tests added:

- `test/subagents-discovery.test.ts` — using `createInMemoryFilesystem`, seed `.bodhi-pi/agents/extractor.md`, assert `loadProjectSubagents` returns the profile with parsed frontmatter, validates name regex, drops profiles with missing description, sorts by name.
- `test/subagents-list-extmethod.test.ts` — full ACP pair via test harness, seed the agents fixture, call `_bodhi-pi/subagent/list`, assert response shape.
- `test/sessions-parent-id.test.ts` — assert in-memory session store correctly persists and filters by `parentSessionId`, and that `list({ includeChildren: false })` excludes children.
- `e2e/shared/subagents-list.e2e.ts` — minimal e2e: seed agents fixture, call `_bodhi-pi/subagent/list` over the real transport, assert the profile is returned. Runs across all 4 vitest projects (in-memory, cli, http, ws).

Acceptance:

- `npm run check` green (no ts errors, no lint errors, no seam violations).
- `npm test` for new tests passes from `packages/bodhi-pi/`.
- `e2e/shared/subagents-list.e2e.ts` passes against in-memory, cli, http, ws.
- Invoking the `subagent` tool throws `not yet implemented` — expected stub behavior in C1.

Risks:

- **Dexie additive schema**: confirm Dexie auto-upgrades vs requires explicit version bump for an additive field that isn't indexed. Read `test-apps/browser/src/host/sessions/dexie-session-store.ts` first.
- **SQLite migration pattern**: confirm the existing pattern in `test-apps/node-adapters/src/sessions/`. If a versioned migration exists, add a v+1 file; if it's a single bootstrap `CREATE TABLE IF NOT EXISTS`, add an `ALTER TABLE` guarded by a `pragma_table_info` check.
- **`SubagentService` construction**: in C1 the service has no spawn deps; in C2 it gains `events`, `mcpService`, `promptLoopDeps`. Construct it with optional fields in C1, populate in C2.

## Commit C2 — Spawn + foreground run + parent progress mirroring

**Goal**: SubagentService.spawn works end-to-end. Child Session is created, builds its own SessionState, runs `runPromptLoop`, mirrors progress to parent `tool_call_update`, persists link + complete entries, recursion guarded at depth 2. The canonical e2e scenario passes against a real LLM.

**Files added/changed**:

src/:

- `src/sessions/entries.ts` — add `SubagentLinkEntry { type: "subagent_link", parentSessionId, profileName, task, toolCallId, depth }` and `SubagentCompleteEntry { type: "subagent_complete", status, summary, durationMs }` to the `SessionEntry` union. Also add the type guards.
- `src/sessions/build-context.ts` — filter both new entry types before assembling LLM messages.
- `src/subagents/build-child-state.ts` — `buildChildSessionState`:
  - Accepts `profile, parentSessionState, childSessionId, childCwd, depth`.
  - Builds tools = `filterBuiltins(builtinsFor(parent), profile.tools)` ⊕ extensionTools. Excludes `subagent` unconditionally in v1. No MCP tools in v1 (P3c).
  - Builds child systemPrompt via `composeSubagentSystemPrompt`.
  - Constructs pi-agent-core Agent, returns SessionState.
- `src/subagents/system-prompt.ts` — `composeSubagentSystemPrompt(profile, toolSnippets)`:
  - Uses `profile.body` as the base.
  - Appends standard `<available_tools>` section from `BUILTIN_TOOL_SNIPPETS` filtered by the child's tool set.
  - Appends `<task>${task}</task>` framing block.
- `src/subagents/subagent-service.ts` — full `spawn()` implementation:
  - Read parent SessionState; compute depth from `subagent_link` ancestry (walk parent's session log for the most recent `subagent_link`; depth = that depth + 1, or 0 if none).
  - Reject if depth > 2 with a clear error.
  - Create child session via `sessionStore.create({ cwd, parentSessionId })`.
  - Append `subagent_link` entry to child session.
  - Call `buildChildSessionState` and register in `sessions` map.
  - Call `mcpService.hydrate(childSessionId, [], [])` (v1: empty inclusion).
  - Subscribe to child events for parent progress mirroring (see design.md Flow B).
  - Emit `subagent_start` event.
  - Call `runPromptLoop(promptLoopDeps, childSessionState, { sessionId: childSessionId, prompt: [{ type: "text", text: task }] })`.
  - On completion: read last assistant text via `extractText`, append `subagent_complete`, emit `subagent_end`, return formatted tool result.
  - On cancel: abort child piAgent, append `subagent_complete{ status: "cancelled" }`, return cancelled result.
  - Cleanup event subscriptions in `finally`.
- `src/tools/subagent.ts` — replace stub with `service.spawn(...)` call.
- `src/events/types.ts` — add `SubagentStartEvent`, `SubagentEndEvent` to the `BodhiPiEvent` union; add to `BodhiPiEventType`.
- `src/acp/agent.ts` — wire the C2 spawn deps into `SubagentService` (events, mcpService, promptLoopDeps function).
- `src/index.ts` — export new event types + `SubagentLinkEntry`, `SubagentCompleteEntry`.

Specs:

- `ai-docs/specs/bodhi-pi/lifecycle.md` — add `SubagentLinkEntry`, `SubagentCompleteEntry` to the SessionEntry table.
- `ai-docs/specs/bodhi-pi/subagents.md` — update runtime mechanics section with the spawn flow details.

Tests added:

- `test/subagents-spawn.test.ts` — integration test with two faux providers (parent + child):
  - Parent LLM is scripted to call `subagent({ agent: "extractor", task: "summarize doc.md" })`.
  - Child LLM is scripted to call `read`, then return text.
  - Assert: child session created with `parentSessionId`, `subagent_link` + `subagent_complete` entries present in child log, parent's tool result contains the child's final text, parent's session list (default) excludes the child, `includeChildren: true` includes it.
  - Assert: parent receives `tool_call_update` frames during execution with `details.kind === "subagent_progress"`.
  - Assert: `subagent_start` and `subagent_end` events emit on the parent's event dispatcher.
- `test/subagents-recursion-guard.test.ts` — script a 3-deep call chain via faux providers (parent → child1 → child2 → would-be-child3); assert the depth-3 call rejects with a clear error and the child2's tool result reflects the rejection.
- `test/subagents-cancellation.test.ts` — start a child via faux provider that streams slowly; cancel the parent prompt; assert child returns cancelled, `subagent_complete{ status: "cancelled" }` is written, parent's tool result reflects cancellation.
- `e2e/shared/subagents.e2e.ts` — canonical scenario with `gpt-4o-mini` for both parent and child. Assert parent's final text contains `fox`. Runs across all 4 vitest projects.

Acceptance:

- All new tests green across in-memory + cli + http + ws projects.
- Child sessions visible via `_bodhi-pi/subagent/children`; absent from default `_bodhi-pi/session/list`.
- `npm run check` green.

Risks:

- **`runPromptLoop` re-entry**: parent's tool execute is awaiting the child's `runPromptLoop`. Both are async; SessionState instances are independent. Should be reentrant. Verify with the cancellation test (which exercises both running concurrently).
- **Parent tool_call_update mirroring**: should not double-emit. Filter strictly by childSessionId in the event listener; verify in `subagents-spawn.test.ts`.
- **http per-turn rebuild**: child completes inside the parent's turn. Verify the child session is committed to SessionStore before the parent's turn returns (`appendEntry` is awaited).
- **Excluding `subagent` tool from child unconditionally**: ensure the tool description doesn't list itself when a child happens to discover its own profile registry. The current model is: child has its own SessionState; `buildChildSessionState` does NOT call `loadProjectSubagents` for the child. Confirm this — children should not auto-discover profiles either.

## Commit C3 — Slash UX + Playwright e2e-ui

**Goal**: User can type `/agents` and `/subagent extractor <task>` from any of the 4 test-apps' chat UI and see the run complete with the same canonical scenario. Playwright assertions for browser + chrome-ext.

**Files added/changed**:

test-apps:

- `test-apps/cli/src/client/slash/...` — add `/agents` and `/subagent` to the REPL's built-in slash dispatcher. Calls `_bodhi-pi/subagent/list` / `_bodhi-pi/subagent/run`. Renders the result inline.
- `test-apps/http/src/client/...` — add `/agents` and `/subagent` to the React client's slash dispatcher.
- `test-apps/browser/src/client/...` — same.
- `test-apps/chrome-ext/src/client/...` — same. (May share with browser via subpath imports — verify the current pattern.)
- `test-apps/{cli,http,browser,chrome-ext}/src/client/slash/parse-subagent-args.ts` (or shared in `test-apps/app-utils/`) — parses `/subagent <name> <task...>` into `{ agent, task }`. Handles quoted tasks.

Specs:

- `ai-docs/specs/bodhi-pi/hosts.md` — note the new built-in slashes in each Host's slash dispatcher table.

Tests added:

- `e2e-ui/shared/subagents.spec.ts` — Playwright spec runs against browser + chrome-ext:
  - Seed the agents fixture via the test-app's seed helpers.
  - Type `/subagent extractor summarize doc.md` in the chat input.
  - Assert:
    - The chat shows a `subagent(extractor, ...)` tool call frame.
    - Progress updates render (at least one `→ read` line in the progress widget).
    - Final parent assistant text contains `fox`.
    - The session sidebar / `/agents` view shows the child session when expanded.

Acceptance:

- `e2e-ui/shared/subagents.spec.ts` passes against browser + chrome-ext.
- Manual smoke (developer): `npm run dev` in `test-apps/cli` with the agents fixture; type `/subagent extractor summarize doc.md`; see the run complete.
- `npm run check` green.

Risks:

- **chrome-ext sandbox iframe** quirks for tool result rendering — same path as bash/run_script tool results, should be fine.
- **Slash arg parsing across hosts** — extract the parser into `test-apps/app-utils/` to avoid drift.
- **Playwright assertion timing** — gpt-4o-mini child runs take 5-15s; bump per-test timeout to 60s with a documented comment per the e2e CLAUDE.md convention.

## Out of scope (v1)

Tracked in `pending.md` and `roadmap.md`. The most-likely-to-be-asked-about items:

- Forked context mode (P2a)
- Parallel batch (P2b)
- Bundled built-in profiles (P2c)
- Extension-registered profiles (P2d)
- Background mode (P3a)
- Resume mid-run (P3b)
- MCP inclusion allow/deny lists (P3c)
- Skill inheritance for child agents (P3d)
- Worktree isolation (P4a)
- Fuller slash UX — `/run`, `/chain`, `/parallel` (P4b)

## After v1 lands

1. Write `retrospective.md` capturing:
   - What surprised us vs the design predictions?
   - What was harder than expected? Easier?
   - What design decisions should change in roadmap based on what we learned?
2. Update `roadmap.md` with the refined sequence and any new candidates the implementation surfaced.
3. Present a brief next-phase proposal for user approval before kicking off the next chunk.
