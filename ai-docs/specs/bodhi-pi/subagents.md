# Sub-agents

bodhi-pi lets the parent LLM delegate a focused task to a specialized **child session** that returns a summary as a tool result. Each child runs the same `runPromptLoop` machinery the parent uses, but with a profile-constrained system prompt, tool list, and model. The child's full transcript is durable in `SessionStore` and inspectable; the parent only sees the summary.

This spec covers the full sub-agents surface as it ships on `main`: discovery (project markdown + bundled built-ins + extension-registered), the LLM-facing `subagent` tool, spawn + foreground run, slash UX, the depth cap, per-status eviction lifecycle, `LIFECYCLE_EVENT_METHOD` wire forwarding of `subagent_start` / `subagent_end`, and `context: "fresh" | "fork"` (fork inherits a filtered slice of the parent transcript via `cloneTranscriptSlice`). Implementation milestones: v1 (discovery + spawn + slash UX), v2 (built-in profiles + `ExtensionAPI.registerSubagentProfile` + cancellation + depth-cache + per-status eviction + wire forwarder), P2a (`context: "fork"` + cloneTranscriptSlice). See [`ai-docs/sub-agents/v1-plan.md`](../../sub-agents/v1-plan.md), [`v2-retrospective.md`](../../sub-agents/v2-retrospective.md), [`p2a-retrospective.md`](../../sub-agents/p2a-retrospective.md) for per-commit context; [`roadmap.md`](../../sub-agents/roadmap.md) sketches what's next.

## Concepts

**Sub-agent profile**: a specialist's `name`, `description`, `model?`, `tools?` (allowlist over built-ins), `max-turns?`, `disabled?`, and a `body` that becomes the child's system prompt. Peer concept to `Skill` and `PromptTemplate`. Three contribution sources:

- **Project markdown** — `<cwd>/.bodhi-pi/agents/<name>.md`, discovered via `loadProjectSubagents(filesystem, cwd)` (`src/subagents/discovery.ts`). `source: "project"`.
- **Built-in** — bundled with the package under `src/subagents/profiles/`, returned by `getBuiltinSubagentProfiles()` (`src/subagents/profiles/index.ts`). Currently ships `explore` and `planner`. `source: "builtin"`.
- **Extension-registered** — via `ExtensionAPI.registerSubagentProfile(def)`; aggregated by `ExtensionRunner.getSubagentProfiles()`. `source: "extension"`. Extension-registered profiles currently bind `context: "fresh"`; if you need fork-mode behaviour from an extension, ship the profile as a project markdown file under `<cwd>/.bodhi-pi/agents/` instead.

Merged at session bootstrap via `mergeSubagentProfiles(project, extension, builtin)` (`src/extensions/merge.ts`) with precedence **project > extension > built-in**. Entries where the winning entry has `disabled: true` are dropped from the output — that's how a project markdown stub overrides + hides a built-in or extension-registered profile by name.

**Child session**: a real `SessionRecord` created in `SessionStore` with `parentSessionId` set to the parent and `subagent: { profileName }` denormalized for filterability. Default `SessionStore.list()` excludes child sessions to keep the user-visible list clean; opt in with `list({ includeSubagentChildren: true })`.

**Sub-agent depth**: number of `subagent_link` entries in the chain from a child back to its root parent. Hard-capped at `SUBAGENT_MAX_DEPTH = 2` (child of child = depth 2 is the max). Enforced in `SubagentService.spawn` and cached on `SessionState.subagentDepth` to avoid walking the entry chain on each spawn.

## Public surface

### LLM-facing tool

The built-in `subagent` tool (`src/tools/subagent.ts`) is registered by `createBuiltinTools` ONLY when at least one profile is discovered. Schema enumerates available profile names as a `Type.Union(Literal(...))` so the LLM gets compile-time-style validation:

```ts
subagent({
  agent: "<one of the discovered profile names>",
  task: string,
  model?: string,
}) -> AgentToolResult with childSessionId + summary
```

The tool params schema declares `additionalProperties: false`. Context mode is decided by the profile (see [`SubagentProfile.context`](#profile-frontmatter)) and is intentionally NOT exposed as an LLM-facing parameter — single-const optional fields attract free-text from LLMs and trigger validation failures; even with ≥2 valid values, a profile-level decision is more useful than asking the LLM to choose at call time (P2a chose to keep the LLM tool surface unchanged).

### Profile frontmatter

```yaml
---
name: extractor                 # optional, defaults to file basename
description: ...                # required, ≤1024 chars
model: gpt-4o-mini              # optional, inherits parent's current model when omitted
context: fresh                  # "fresh" (default) or "fork". Fresh starts the child with an empty
                                # message history; fork clones a filtered slice of the parent's
                                # transcript so the child sees prior context (e.g. read tool results).
                                # See the "Fork mode" subsection below.
tools:                          # optional allowlist over built-ins; omitted = all built-ins (minus `subagent`)
  - read
  - grep
max-turns: 50                   # optional, default 50
disabled: true                  # optional; on a project markdown entry, drops the same-name built-in or
                                # extension-registered profile from the registry. Built-in source files
                                # may NOT declare disabled:true (asserted at module load); extension
                                # `registerSubagentProfile` calls with disabled:true throw at registration.
---
You are an extractor sub-agent. Your job is to...
```

Discovery rules (`src/subagents/discovery.ts`):

- Flat `.md` files under `<cwd>/.bodhi-pi/agents/` (Commands pattern, not Skills folder pattern).
- `name` regex `^[a-z0-9-]+$`, ≤64 chars, no leading/trailing/double `-`.
- Missing/empty `description` or empty body → profile silently dropped.
- Duplicate names: first wins; later ones silently dropped.
- Sorted by name.
- Validation logic shared with extension-registered profiles via `src/subagents/_validate.ts` (`validateAndNormalizeProfile`).

### Built-in profiles

Two profiles ship bundled with bodhi-pi (no project seed required):

- **`explore`** — read-only investigator (`tools: [read, ls, find, grep]`). Reads the workspace and reports findings without modifying state.
- **`planner`** — design plans without executing them (`tools: [read, ls, find, grep]`). Produces numbered implementation plans grounded in real code.

Both are loaded as TS modules from `src/subagents/profiles/{explore,planner}.ts` so they work uniformly across cli + http + browser Worker + chrome-ext MV3 with no bundler-specific glue. Disable a built-in by creating a project markdown profile with the same `name` and `disabled: true` in frontmatter.

### Extension-registered profiles

Extensions register profiles via `ExtensionAPI.registerSubagentProfile(def)`. The runner aggregates them into `runner.getSubagentProfiles()` and the bootstrap merger places them between project (highest precedence) and built-in (lowest). Registration shares the markdown validation pipeline; a registration that supplies `disabled: true` throws synchronously. The `def.context` field is restricted to `"fresh"` at the extension surface — project markdown is the only contribution source that may opt into `context: "fork"` (see [Fork mode](#fork-mode)).

### Fork mode

`context: "fork"` makes the child see a sliced copy of the parent's transcript so tasks like "review this diff" don't need to re-feed context the parent already loaded.

**Slice mechanics** (`SubagentService.spawn` when `profile.context === "fork"`):

1. Load the parent's `SessionRecord` from `sessionStore`.
2. `cloneTranscriptSlice(record.entries, { leafOrFromEntryId: record.leafId, excludeEntryTypes: SUBAGENT_FORK_FILTER })` (`src/sessions/clone-slice.ts` + `src/subagents/_clone-slice-filter.ts`) walks the parentId chain from root to the parent's current leaf, then drops entries of type:
   - `mcp_inclusion_set` — session-MCP snapshot; child has its own MCP wiring.
   - `extension` — extension-author bookkeeping; not part of the user-visible conversation.
   - `subagent_link` — bracket-of-prior-spawn marker.
   - `subagent_complete` — bracket-of-prior-spawn terminator.
3. `buildSessionContext({entries: sliced, leafId: null})` converts the remaining entries to `AgentMessage[]` (reusing the same code path that hydrates loaded sessions). The non-`messages` fields it returns (`currentModelId`, `currentThinkingLevel`, `name`, `mcpInclusion`) are discarded — the child's model + thinking + MCP come from the profile, not parent state.
4. The resulting `messages` are passed into `buildChildSessionState` as the agent's initial state. The child's first `runPromptLoop` prompt (the task body) is appended as a new user turn after the inherited history.

**Lineage:** the child's `subagent_link` SessionEntry and both `subagent_start` / `subagent_end` lifecycle events carry `contextMode: "fresh" \| "fork"` so the wire surface and persisted log can distinguish how a child was spawned.

**Known limitation — mid-pair slicing:** the slicer does not enforce `tool_call` / `tool_result` pair-completeness. If the parent's current leaf falls between a tool_call and its tool_result, the child's message history can be malformed and pi-agent-core hydration may choke. The existing `_bodhi-pi/session/fork` sibling has the same gap; the practical exposure is small because the parent typically spawns at end-of-turn (the LLM emits the `subagent` tool_use after prior tool_call/result pairs complete). Future work may add placeholder-result injection (cc/Gemini pattern).

**Distinct from `_bodhi-pi/session/fork`** (`SessionGraphService.handleSessionFork`): session-fork preserves the full session shape (tools / skills / MCP / settings); sub-agent fork is profile-constrained and drops the session-management entry types listed above from the child's view.

### Extension methods

See [acp.md § Sub-agents](./acp.md). Constants in `src/wire/constants.ts`:

- `EXT_SUBAGENT_LIST = "_bodhi-pi/subagent/list"` — drives `/agents` slash
- `EXT_SUBAGENT_RUN = "_bodhi-pi/subagent/run"` — drives `/subagent <name> <task>`
- `EXT_SUBAGENT_CHILDREN = "_bodhi-pi/subagent/children"` — drives "runs from this session" UI

### Slash commands

Two flat, one-shot slashes per the bodhi-pi flat-and-complete slash design (no popups, no cycles):

- `/agents` — calls `_bodhi-pi/subagent/list`, renders the profile list
- `/subagent <name> <task...>` — calls `_bodhi-pi/subagent/run`

Host's client owns the dispatcher, same pattern as `/mcp ...`.

## SessionStore additions

Two additive fields on `SessionRecord` / `SessionInfo` (`src/sessions/session-store.ts`):

```ts
interface SessionRecord {
  // ... existing fields ...
  parentSessionId?: string;                  // also used by fork/clone (existing)
  subagent?: { profileName: string };        // set by SubagentService.spawn — denormalized for filterability
}
```

Two additive `ListSessionsRequest` filters:

```ts
interface ListSessionsRequest {
  // ... existing fields ...
  parentSessionId?: string;                   // when set, returns only sessions with this parent
  includeSubagentChildren?: boolean;          // default false — preserves existing UX (forks remain visible)
}
```

Implementations:

- `src/sessions/in-memory-session-store.ts` — filters in-memory.
- `test-apps/node-adapters/sessions/single-tenant/` and `multi-tenant/` — `parent_session_id` + `subagent_profile` columns on the `sessions` table; `isNull(subagent_profile)` filter unless `includeSubagentChildren: true`.
- `test-apps/browser/src/host/sessions/dexie-session-store.ts` — fields on the SessionRow; filter in JS after fetch (Dexie's `where().equals()` doesn't compose well with the OR-by-default).

## SessionState addition

`SessionState.subagentProfiles: SubagentProfile[]` (`src/sessions/session-state.ts`) — loaded by `loadProjectArtifacts` at session bootstrap. Drives `_bodhi-pi/subagent/list` and the conditional `subagent` tool registration.

## Wiring summary

```
session/new → buildSessionState
              ├─ loadProjectArtifacts(config, cwd, sessionId)
              │   ├─ loadProjectSubagents(fs, cwd)            → SubagentProfile[] (source: "project")
              │   ├─ runner?.getSubagentProfiles()            → SubagentProfile[] (source: "extension")
              │   ├─ getBuiltinSubagentProfiles()             → SubagentProfile[] (source: "builtin")
              │   ├─ mergeSubagentProfiles(project, extension, builtin)
              │   │     → dedup by name (project > extension > builtin); drop disabled-winning
              │   └─ createBuiltinTools({
              │        ...,
              │        subagent: merged.length > 0
              │          ? { sessionId, profiles: merged, service }
              │          : undefined
              │      })
              └─ SessionState.subagentProfiles = merged
                 SessionState.tools includes `subagent` tool iff merged.length > 0

extMethod _bodhi-pi/subagent/list     → SubagentService.handleList   → merged profile summaries (with `source`)
extMethod _bodhi-pi/subagent/run      → SubagentService.spawn        → child summary
extMethod _bodhi-pi/subagent/children → SubagentService.handleChildren → sessionStore.list({parentSessionId, includeSubagentChildren:true})
```

## Spawn lifecycle

`SubagentService.spawn` is the single entry point for both LLM tool invocation and the `_bodhi-pi/subagent/run` extension method:

1. Resolve the profile + reject unknown agent names with `-32602`.
2. Enforce `SUBAGENT_MAX_DEPTH` via the cached `SessionState.subagentDepth` — at depth 2 the spawn rejects before any state is allocated.
3. `sessionStore.create({ cwd, parentSessionId, subagent: { profileName } })` creates the child SessionRecord.
4. Append `subagent_link` SessionEntry to the child (carries `parentSessionId`, `profileName`, `task`, `toolCallId`, `depth`, `contextMode`).
5. If `profile.context === "fork"`, run `cloneTranscriptSlice(parent.entries, {…})` and build the child `SessionState` from the inherited messages (see [Fork mode](#fork-mode)). Otherwise, build a fresh `SessionState`.
6. Register the run in `activeRuns` and emit `subagent_start` (in-process via `EventDispatcher`, forwarded to the wire via `notifyLifecycle(LIFECYCLE_EVENT_METHOD, …)` in `src/acp/event-wiring.ts`).
7. Run `runPromptLoop` on the child; mirror progress to the parent's `tool_call_update` channel.
8. Append `subagent_complete` SessionEntry (terminal status `completed | cancelled | failed`).
9. Emit `subagent_end` on both rails.
10. Evict the child from the live `sessions` map regardless of terminal status — children are durable in `SessionStore` and load on demand via `_bodhi-pi/session/load`; the live map only tracks runs in flight.

The returned tool result is wrapped as `<subagent_result>…</subagent_result>` for `completed`/`cancelled` and `<subagent_error>…</subagent_error>` for `failed`, prefixed with the `childSessionId` so the parent LLM and Host can navigate into the full transcript.

## Reference research

External harness implementations surveyed in `ai-docs/research/sub-agents/`:

- opencode `task.ts` — closest fit; pattern for child Session creation, `<task_result>` framing, AbortSignal wiring.
- Mastra `tools.ts:createSubagentTool` — profile-as-enum tool schema; event-emit model adapted to ACP `tool_call_update`.
- cc `runAgent.ts` — two-track abort signal pattern; skill-preloading idea (deferred to P3d).
- pi-coding-agent `pi-subagents` — concepts and slash UX; **process-spawn impl rejected** because browser/chrome-ext/stateless-http cannot fulfill it.

See [`ai-docs/sub-agents/design.md`](../../sub-agents/design.md) for the full rationale and harness-borrowing matrix.

## See also

- [acp.md § Sub-agents](./acp.md) — full extension-method reference
- [lifecycle.md](./lifecycle.md) — where `subagent_link` and `subagent_complete` entries fit in the SessionEntry union
- [extensions-skills-commands.md](./extensions-skills-commands.md) — peer comparison: Extension vs Skill vs Command vs Sub-agent profile
- [`ai-docs/sub-agents/v1-plan.md`](../../sub-agents/v1-plan.md) — commit-by-commit implementation plan
- [`ai-docs/sub-agents/roadmap.md`](../../sub-agents/roadmap.md) — rough phase 2+ sketches
