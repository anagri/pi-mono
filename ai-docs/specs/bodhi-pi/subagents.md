# Sub-agents

bodhi-pi lets the parent LLM delegate a focused task to a specialized **child session** that returns a summary as a tool result. Each child runs the same `runPromptLoop` machinery the parent uses, but with a profile-constrained system prompt, tool list, and model. The child's full transcript is durable in `SessionStore` and inspectable; the parent only sees the summary.

This spec describes the public surface and the C1 (discovery scaffold) implementation. C2 (spawn + foreground run) and C3 (slash UX + Playwright) extend the same shape; see [`ai-docs/sub-agents/v1-plan.md`](../../sub-agents/v1-plan.md) for the commit boundaries.

## Concepts

**Sub-agent profile**: a markdown document under `<cwd>/.bodhi-pi/agents/<name>.md` defining a specialist's `name`, `description`, `model?`, `tools?` (allowlist over built-ins), `max-turns?`, and a body that becomes the child's system prompt. Peer concept to `Skill` and `PromptTemplate`. Discovered via `loadProjectSubagents(filesystem, cwd)` (`src/subagents/discovery.ts`).

**Child session**: a real `SessionRecord` created in `SessionStore` with `parentSessionId` set to the parent and `subagent: { profileName }` denormalized for filterability. Default `SessionStore.list()` excludes child sessions to keep the user-visible list clean; opt in with `list({ includeSubagentChildren: true })`.

**Sub-agent depth**: number of `subagent_link` entries in the chain from a child back to its root parent. Hard-capped at 2 in v1 (child of child = depth 2 is the max). Enforced in `SubagentService.spawn` (C2).

## Public surface

### LLM-facing tool

The built-in `subagent` tool (`src/tools/subagent.ts`) is registered by `createBuiltinTools` ONLY when at least one profile is discovered. Schema enumerates available profile names as a `Type.Union(Literal(...))` so the LLM gets compile-time-style validation:

```ts
subagent({
  agent: "<one of the discovered profile names>",
  task: string,
  context?: "fresh",   // v1: "fresh" only
  model?: string,
}) -> (C2: AgentToolResult with childSessionId + summary)
```

C1 stub: the tool is registered (so the LLM sees it in its tool list and the system prompt's "Available tools" includes it), but `execute` throws "spawn path lands in C2".

### Profile frontmatter

```yaml
---
name: extractor                 # optional, defaults to file basename
description: ...                # required, ≤1024 chars
model: gpt-4o-mini              # optional, inherits parent's current model when omitted
context: fresh                  # v1: "fresh" only; "fork" lands in P2a
tools:                          # optional allowlist over built-ins; omitted = all built-ins (minus `subagent`)
  - read
  - grep
max-turns: 50                   # optional, default 50
---
You are an extractor sub-agent. Your job is to...
```

Discovery rules (`src/subagents/discovery.ts`):

- Flat `.md` files under `<cwd>/.bodhi-pi/agents/` (Commands pattern, not Skills folder pattern).
- `name` regex `^[a-z0-9-]+$`, ≤64 chars, no leading/trailing/double `-`.
- Missing/empty `description` or empty body → profile silently dropped.
- Duplicate names: first wins; later ones silently dropped.
- Sorted by name.

### Extension methods

See [acp.md § Sub-agents](./acp.md). Constants in `src/wire/constants.ts`:

- `EXT_SUBAGENT_LIST = "_bodhi-pi/subagent/list"` — drives `/agents` slash
- `EXT_SUBAGENT_RUN = "_bodhi-pi/subagent/run"` — drives `/subagent <name> <task>` (C2)
- `EXT_SUBAGENT_CHILDREN = "_bodhi-pi/subagent/children"` — drives "runs from this session" UI

### Slash commands

Two flat, one-shot slashes per the bodhi-pi flat-and-complete slash design (no popups, no cycles):

- `/agents` — calls `_bodhi-pi/subagent/list`, renders the profile list
- `/subagent <name> <task...>` — calls `_bodhi-pi/subagent/run` (C3)

Host's client owns the dispatcher, same pattern as `/mcp ...`.

## SessionStore additions

Two additive fields on `SessionRecord` / `SessionInfo` (`src/sessions/session-store.ts`):

```ts
interface SessionRecord {
  // ... existing fields ...
  parentSessionId?: string;                  // also used by fork/clone (existing)
  subagent?: { profileName: string };        // NEW — set by SubagentService.spawn (C2)
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

## Wiring summary (C1)

```
session/new → buildSessionState
              ├─ loadProjectArtifacts(config, cwd, sessionId)
              │   ├─ loadProjectSubagents(fs, cwd)            → SubagentProfile[]
              │   └─ createBuiltinTools({
              │        ...,
              │        subagent: profiles.length > 0
              │          ? { sessionId, profiles }
              │          : undefined
              │      })
              └─ SessionState.subagentProfiles = profiles
                 SessionState.tools includes `subagent` tool iff profiles.length > 0

extMethod _bodhi-pi/subagent/list   → SubagentService.handleList   → profile summaries
extMethod _bodhi-pi/subagent/run    → throws -32601 (C1 stub; C2 wires spawn)
extMethod _bodhi-pi/subagent/children → SubagentService.handleChildren → sessionStore.list({parentSessionId, includeSubagentChildren:true})

subagent tool .execute()            → throws "spawn path lands in C2"
```

## C2/C3 sketch (what arrives later)

- C2: `SubagentService.spawn` creates a child Session via `sessionStore.create({ cwd, parentSessionId, subagent: { profileName } })`, appends `subagent_link` SessionEntry, builds a child `SessionState` via `buildChildSessionState`, calls `runPromptLoop` on it, mirrors progress to the parent's `tool_call_update` channel, appends `subagent_complete`, returns formatted tool result wrapped in `<subagent_result>...</subagent_result>`. Recursion guarded at depth 2.
- C3: each Host's client adds `/agents` and `/subagent` slash entries that call `_bodhi-pi/subagent/list` and `_bodhi-pi/subagent/run`. Playwright e2e-ui validates the user-facing flow.

## Reference research

External harness implementations surveyed in `ai-docs/research/sub-agents/`:

- opencode `task.ts` — closest fit; pattern for child Session creation, `<task_result>` framing, AbortSignal wiring.
- Mastra `tools.ts:createSubagentTool` — profile-as-enum tool schema; event-emit model adapted to ACP `tool_call_update`.
- cc `runAgent.ts` — two-track abort signal pattern; skill-preloading idea (deferred to P3d).
- pi-coding-agent `pi-subagents` — concepts and slash UX; **process-spawn impl rejected** because browser/chrome-ext/stateless-http cannot fulfill it.

See [`ai-docs/sub-agents/design.md`](../../sub-agents/design.md) for the full rationale and harness-borrowing matrix.

## See also

- [acp.md § Sub-agents](./acp.md) — full extension-method reference
- [lifecycle.md](./lifecycle.md) — where `subagent_link` and `subagent_complete` entries fit (C2)
- [extensions-skills-commands.md](./extensions-skills-commands.md) — peer comparison: Extension vs Skill vs Command vs Sub-agent profile
- [`ai-docs/sub-agents/v1-plan.md`](../../sub-agents/v1-plan.md) — commit-by-commit implementation plan
- [`ai-docs/sub-agents/roadmap.md`](../../sub-agents/roadmap.md) — rough phase 2+ sketches
