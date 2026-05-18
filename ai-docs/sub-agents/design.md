# Sub-agents — architecture

## What this is

A first-party mechanism for the parent LLM to delegate a focused task to a specialized child session that returns a summary as a tool result. Each child runs the same prompt-loop machinery the parent uses, but with a profile-constrained system prompt, tool list, and model. The child's full transcript is durable in SessionStore and inspectable; the parent only sees the summary.

## Why this shape

Bodhi-pi is runtime-neutral. It runs in Node CLI, Node HTTP server (per-turn agent rebuild), browser Web Worker, and Chrome MV3 service worker. Two design rules drop out:

1. **No process spawn.** Rules out pi-coding-agent's `pi-subagents` approach (which spawns child `pi` CLI processes via `node:child_process`). Browser, chrome-ext, and stateless HTTP rebuild Hosts cannot fulfill it.
2. **Durable state across rebuilds.** http rebuilds the agent every turn; the child session must live in SessionStore so it survives.

Combined, these point at: **in-process child Session created in SessionStore, run via the existing `runPromptLoop` machinery, summarized result returned as a tool result.** This is the shape used by opencode (closest existing fit) and refined per Mastra's prompt-cache insights.

(Rejected alternatives:
- **Bundling as a first-party extension** — extensions lack privileged access to `buildSessionState` / `runPromptLoop`. They would have to call `_bodhi-pi/session/fork` via extMethod for child creation and then re-implement the prompt loop. Heavy duplication.
- **Thinning the agent and letting the Host orchestrate** — recreates the cross-runtime tax we're avoiding. Each of cli/http/browser/chrome-ext would have to implement its own driver. Also, the parent LLM cannot natively invoke a subagent as a tool — that orchestration must live inside the agent.)

## Public surface

### LLM-facing tool

The built-in `subagent` tool, registered by `createBuiltinTools` when at least one profile is discovered. `src/sessions/session-bootstrap.ts:65-70` (the current call site for `createBuiltinTools`) will be extended to thread an optional `subagent: { sessionId, profiles, service }` block through `ToolDeps`.

```ts
subagent({
  agent: string,         // profile name from `.bodhi-pi/agents/<name>.md`
  task: string,          // self-contained task description
  context?: "fresh",     // v1 only supports "fresh"; "fork" lands in v2 (roadmap P2a)
  model?: string,        // override profile.model
}) -> {
  content: [{ type: "text", text: formatResult(...) }],
  details: { kind: "subagent_result", childSessionId, profile, status, durationMs, toolCount },
  isError: status === "failed",
}
```

Schema enumerates available profile names as a `Type.Union(Literal(...))` (Mastra pattern) so the LLM gets compile-time-style validation. Tool description is generated from the profile list.

`BUILTIN_TOOL_SNIPPETS` (`src/tools/index.ts:45`) gains a `subagent` entry so the system prompt's "Available tools" section includes it when the tool is registered.

### Host-facing extension methods

| Method | Purpose |
|---|---|
| `_bodhi-pi/subagent/list` | Returns discovered profiles (name, description, model, tools, context default) — drives `/agents` slash |
| `_bodhi-pi/subagent/run` | Invokes a profile (Host-driven path for `/subagent <name> <task>`) — internally same path as the tool |
| `_bodhi-pi/subagent/children` | Lists child sessions whose `parentSessionId === sessionId` — for "runs originating from this session" UI |

Constants live in `src/wire/constants.ts` next to existing `EXT_*` constants. Pattern follows the established `_bodhi-pi/<area>/<verb>` form.

### Slash commands

Each Host's client adds two built-in slash entries (no `availableCommands` advertisement needed — slashes for `_bodhi-pi/*` extension methods are Host-owned today, same pattern as `/mcp ...`):

- `/agents` → calls `_bodhi-pi/subagent/list`, renders profile list
- `/subagent <name> <task...>` → calls `_bodhi-pi/subagent/run`

Adheres to the bodhi-pi flat-and-complete slash design: each operation has a single direct slash form, no popups, no cycle conveniences.

### SessionStore + SessionEntry changes

**SessionStore.parentSessionId** — new optional field on `SessionRecord` and `SessionInfo`. Top-level sessions get `parentSessionId: null`; children get the parent's id. Implementations:

- in-memory store (`src/sessions/in-memory-session-store.ts`): additive field on the record map
- node SQLite (`test-apps/node-adapters/`): new nullable column on the sessions table — additive migration
- Dexie (`test-apps/browser/src/host/sessions/`): additive field — Dexie auto-handles schema upgrade when no existing index references the field

**SessionStore.list({ includeChildren? })** — defaults `false`. Rows with `parentSessionId IS NOT NULL` are filtered out unless explicitly included. Keeps existing UX clean while preserving inspectability.

**SessionEntry new discriminants** (`src/sessions/entries.ts:94`):

```ts
| SubagentLinkEntry        // appended to child session at spawn
| SubagentCompleteEntry    // appended to child session at end
```

`buildSessionContext` (`src/sessions/build-context.ts`) filters both before assembling LLM messages — they don't reach the model but are visible in inspectors and the SessionGraph.

## Profile discovery

Markdown files under `.bodhi-pi/agents/<name>.md` (top-level, mirroring `.bodhi-pi/commands/`). Loader: `src/subagents/discovery.ts → loadProjectSubagents(filesystem, cwd)`. Returns `SubagentProfile[]` sorted by name.

Discovery rules:

- Flat files, not folder-based (Commands pattern, not Skills pattern)
- `name` must match `^[a-z0-9-]+$`, ≤64 chars (matches Skills rule)
- Missing/empty `description` → profile silently dropped (looks like a draft)
- Frontmatter parsed via `src/_internal/frontmatter.ts` (existing utility)

Frontmatter:

```yaml
---
name: extractor                 # optional, defaults to file basename
description: ...                # required, ≤1024 chars
model: gpt-4o-mini              # optional, inherits parent's current model when omitted
context: fresh                  # v1: fresh only; fork in v2
tools:                          # tool allowlist over built-ins; omitted = inherit parent's built-ins (minus `subagent`)
  - read
  - grep
maxTurns: 50                    # safety cap; default 50
---
You are an extractor sub-agent. Your job is to...
```

Loaded per session boot, same lifecycle as skills/commands. Stored in `SessionState.subagentProfiles: SubagentProfile[]` for the `_bodhi-pi/subagent/list` handler and the tool factory.

## Runtime mechanics

### Registration

When `buildSessionState` runs (per-session bootstrap, `src/sessions/session-bootstrap.ts:210`):

1. `loadProjectArtifacts` (called inside `buildSessionState`) gets a new call: `loadProjectSubagents(config.filesystem, cwd)`.
2. `createBuiltinTools` is called with `subagent: profiles.length > 0 ? { sessionId, profiles, service } : undefined`.
3. The `subagent` tool is emitted into `builtinTools` only when at least one profile exists.
4. `SessionState.subagentProfiles` stores the loaded list (used by `_bodhi-pi/subagent/list` and the tool description generator).

### Spawn flow

When the LLM emits a `subagent({...})` tool call, `pi-agent-core` invokes `tool.execute(toolCallId, params, signal, onUpdate)`. The tool body delegates to `SubagentService.spawn` (all in-process, no IPC):

```
┌────────────────────────────────────────────────────────────────────────────┐
│ 1. LLM emits tool_call: subagent({ agent: "extractor", task: "..." })      │
└────────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼  pi-agent-core invokes tool.execute(...)
┌────────────────────────────────────────────────────────────────────────────┐
│ 2. subagent tool calls subagentService.spawn({ parentSessionId, profile,   │
│    task, context, signal, onUpdate })                                      │
└────────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ 3. SubagentService.spawn (sequential, all in-process):                     │
│                                                                            │
│   a. Validate parent session loaded; read parent SessionState for cwd,     │
│      current model, current MCP inclusion (for mcp.inherit profiles).      │
│                                                                            │
│   b. Compute child config:                                                 │
│      - model = profile.model ?? params.modelOverride                       │
│                                       ?? parent.runtime.currentModelId    │
│      - toolPolicy = profile.tools (allow-list over built-ins)              │
│      - mcpInclusion = [] (v1: children get no MCP tools; granular          │
│        inheritance + allow/deny lands in roadmap P3c)                      │
│      - depth = walkSubagentLinks(parent session log) + 1                   │
│      - if depth > 2 → reject before creating child session                 │
│                                                                            │
│   c. sessionStore.create({ cwd: parent.cwd, parentSessionId })             │
│      → returns childSessionId                                              │
│      SessionStore interface gains an optional parentSessionId arg          │
│      (existing impls accept and persist it; null = top-level session)      │
│                                                                            │
│   d. Append SUBAGENT_LINK entry to child session log:                      │
│      { type: "subagent_link", parentSessionId, profileName, task,          │
│        toolCallId, depth }                                                 │
│      → makes child self-describing; build-context.ts ignores it for LLM    │
│        history but UI/inspectors render it as the lineage header.          │
│                                                                            │
│   e. buildChildSessionState (variant of buildSessionState, in              │
│      src/subagents/build-child-state.ts):                                  │
│        - tools = filterBuiltins(builtins, profile.tools)                   │
│                 ⊕ extensionTools (always inherited in v1; phase 2 filters) │
│                 — `subagent` tool is EXCLUDED unconditionally in v1        │
│                   (recursion guard via depth cap is belt-and-suspenders)   │
│                 — no MCP tools in v1 (roadmap P3c)                         │
│        - systemPrompt = composeSubagentSystemPrompt(profile, toolSnippets) │
│        - thinkingLevel = profile.thinking ?? parent's current              │
│        - messages = [] (fresh context; fork mode arrives in v2)            │
│                                                                            │
│      Just like buildSessionState, this constructs a pi-agent-core Agent    │
│      and registers childSessionState in agent.sessions Map<...>.           │
│                                                                            │
│   f. mcpService.hydrate(childSessionId, [], [])                            │
│      → v1: no MCP for the child (empty inclusion set)                      │
│      → still called so available_commands_update fires for child sessionId │
│                                                                            │
│   g. Subscribe to child's events for parent progress mirroring (§ comms)   │
│                                                                            │
│   h. Call runPromptLoop(promptLoopDeps, childSessionState,                 │
│            { sessionId: childSessionId,                                    │
│              prompt: [{ type: "text", text: task }] })                     │
│      — same function that drives top-level prompts.                        │
│        Runs until stopReason "end_turn" / "cancelled" / "error".           │
└────────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
                       (now executing — see § Communication)
```

### Communication during execution

Three concurrent flows; nothing custom required for any of them:

**Flow A — Child session updates (native ACP)**

The child's `runPromptLoop` calls `conn.sessionUpdate({ sessionId: childSessionId, update })` for `agent_message_chunk`, `tool_call`, `tool_call_update`, `available_commands_update`. The Client receives these with the child's sessionId — same wire, same shape. Hosts decide whether to render the child transcript inline, in an expand-able panel, or ignore.

This is the architectural payoff of ACP being session-scoped: a child session is "just another session" on the wire. No new methods, no new wire format.

**Flow B — Parent `tool_call_update` (summary heartbeat)**

SubagentService subscribes to child events filtered by childSessionId and forwards summaries via the `onUpdate` callback the `subagent` tool received from pi-agent-core:

```ts
const offToolCall = events.on('tool_call', (e) => {
  if (e.sessionId !== childSessionId) return;
  onUpdate({
    content: [{ type: 'text', text: `→ ${e.toolName}` }],
    details: {
      kind: 'subagent_progress',
      childSessionId,
      profile: profile.name,
      lastTool: e.toolName,
      status: 'running',
    },
  });
});

const offMessageEnd = events.on('message_end', (e) => {
  if (e.sessionId !== childSessionId) return;
  onUpdate({
    content: [{ type: 'text', text: `[${profile.name}] ${snippet(e.text)}` }],
    details: { kind: 'subagent_progress', childSessionId, status: 'running' },
  });
});

try {
  await runPromptLoop(...);
} finally {
  offToolCall(); offMessageEnd();
}
```

The parent's UI sees `tool_call_update` frames on its own session for the `subagent` tool call, with structured `details` it can render as a "Running subagent: <profile> (12 tool calls, 8s)" widget.

**Flow C — Host event subscriptions**

Hosts wiring `eventHandlers: BodhiPiEventHandlers` get two new event types added to `BodhiPiEvent`:

- `subagent_start { parentSessionId, childSessionId, profile, task, toolCallId }`
- `subagent_end { parentSessionId, childSessionId, status, durationMs, summary?, error? }`

These power telemetry, logging, and global UI surfaces (e.g., a "running subagents tray" in the Host) without polling.

### Finish

When `runPromptLoop` returns:

1. SubagentService reads the last assistant MessageEntry from the child session via `extractText` (`src/sessions/_shared.ts:1`).
2. Appends `subagent_complete { status, summary, durationMs }` to the child session log.
3. Emits `subagent_end` event.
4. Returns to the tool:

```ts
{
  content: [{ type: 'text', text:
    `childSessionId: ${childSessionId} (load to inspect full transcript)\n\n` +
    `<subagent_result>\n${summary}\n</subagent_result>` }],
  details: { kind: 'subagent_result', childSessionId, profile, status, durationMs, toolCount },
  isError: status === 'failed',
}
```

5. pi-agent-core surfaces this as a normal tool result to the parent's LLM; `appendEntry` persists it into the parent's session log.
6. Parent's LLM resumes on its next turn with the summary in context.

Opencode's `<subagent_result>` framing is borrowed because it empirically reduces parent over-trust — the LLM treats wrapped content as "report from another agent" rather than its own thought.

### Cancellation

- **Parent cancel** (`cancel(parentSessionId)`) → `parent.runtime.piAgent.abort()` → the AbortSignal propagates into the `subagent` tool's `execute(signal)` → SubagentService calls `childSessionState.runtime.piAgent.abort()` → child's `runPromptLoop` returns `stopReason: "cancelled"` → `subagent_complete { status: "cancelled" }` is appended → tool result with `status: "cancelled"` returns to parent.
- **Child cancel directly** (`cancel(childSessionId)` — possible because the child is in `agent.sessions`) → same flow, parent's tool result reflects cancellation.

## Cross-runtime considerations

| Runtime | Notes |
|---|---|
| cli | No special handling. Child runs in the same Node process. |
| http (per-turn rebuild) | Child runs to completion within the parent's turn (foreground only in v1, OK). State is durable in SessionStore so subsequent turns can inspect via `_bodhi-pi/subagent/children` or load childSessionId directly. |
| browser | Child runs in the same Web Worker as the parent. ZenFS provides the same file ops. Dexie persistence for SessionStore. |
| chrome-ext | Child runs in the same service worker as the parent. Same Dexie + ZenFS adapters as browser. |

**No `node:*` imports in `src/subagents/`** — this is core; bodhi-pi `src/` is runtime-neutral.

**MCP inheritance**: not in v1. Children get no MCP tools, regardless of parent inclusion. Profile-level `mcp` field is deliberately omitted from v1 to avoid baking a half-finished policy surface. Granular inheritance + allow/deny lands in roadmap P3c.

## What the v1 mechanics borrow from harness research

| From | What we borrow | What we drop |
|---|---|---|
| opencode `task.ts` | Child Session created in store with `parentID`, foreground execution, `<subagent_result>` framing, tool result format with `task_id` (we call it `childSessionId`) | Background mode (roadmap P3a), recursion-allowing primary-tools config, permission derivation (we use simpler depth cap + profile tool allowlist) |
| Mastra `createSubagentTool` | Profile-as-enum in tool schema, `subagent_start/text_delta/tool_start/tool_end/end` event model (we map to ACP `tool_call_update` and `BodhiPiEvent` instead of a custom emit channel) | Forked mode (roadmap P2a), prompt-cache-stable patched-tool-for-fork (P2a) |
| cc `runAgent.ts` | Two-track abort signal (sync = shared parent signal), pre-loading skills from profile frontmatter (deferred to roadmap P3d) | Sidechain transcript files (bodhi-pi uses SessionStore), sync/async permission UI bubble (no analog), worktree isolation (roadmap P4a) |
| pi-coding-agent `pi-subagents` | Conceptual: subagent slash UX, profile naming conventions, recursion guard via depth env var | Process spawn (incompatible with browser/chrome-ext), session-file JSONL durability (we use SessionStore), intercom bridge (deferred — depends on pi-intercom) |

## File-level inventory of additions

```
src/subagents/
├── types.ts                     # SubagentProfile, SubagentSpawnInput, SubagentResult
├── discovery.ts                 # loadProjectSubagents(filesystem, cwd)
├── subagent-service.ts          # SubagentService.spawn / list / children handlers
├── build-child-state.ts         # buildChildSessionState (variant of buildSessionState)
└── system-prompt.ts             # composeSubagentSystemPrompt

src/tools/subagent.ts            # createSubagentTool (built-in)
src/sessions/entries.ts          # +SubagentLinkEntry, +SubagentCompleteEntry
src/sessions/session-store.ts    # +parentSessionId on SessionRecord/SessionInfo; +includeChildren on list
src/sessions/session-state.ts    # +subagentProfiles: SubagentProfile[]
src/wire/constants.ts            # +EXT_SUBAGENT_LIST, +EXT_SUBAGENT_RUN, +EXT_SUBAGENT_CHILDREN
src/events/types.ts              # +SubagentStartEvent, +SubagentEndEvent
src/index.ts                     # export new public types

test/subagents-discovery.test.ts
test/subagents-spawn.test.ts
test/subagents-recursion-guard.test.ts
e2e/shared/subagents-list.e2e.ts        # C1 e2e — list only
e2e/shared/subagents.e2e.ts             # C2 e2e — canonical scenario
e2e/data/agents-fixture/...             # extractor.md fixture
e2e-ui/shared/subagents.spec.ts         # C3 Playwright

test-apps/{cli,http,browser,chrome-ext}/src/client/slash/...  # /agents + /subagent dispatchers (C3)
test-apps/node-adapters/...      # parentSessionId column migration (C1)
test-apps/browser/src/host/sessions/...  # Dexie schema additive (C1)
```

## Specs to amend (same commit as code)

Per bodhi-pi's "specs are living docs" rule, the following must be updated alongside the v1 commits:

- `ai-docs/specs/bodhi-pi/index.md` — new "Sub-agents" row in the "Read this if…" table, link to a new `subagents.md` spec
- `ai-docs/specs/bodhi-pi/subagents.md` — new spec doc (analogous to mcp.md / extensions-skills-commands.md) covering the public surface, profile format, runtime mechanics
- `ai-docs/specs/bodhi-pi/acp.md` — add the three `_bodhi-pi/subagent/*` extension methods to the table
- `ai-docs/specs/bodhi-pi/lifecycle.md` — add `SubagentLinkEntry`, `SubagentCompleteEntry` to the SessionEntry table
- `ai-docs/specs/bodhi-pi/extensions-skills-commands.md` — add a column/row for the new "Sub-agent profile" contribution mechanism (markdown discovery, peers with Commands and Skills)
- `packages/bodhi-pi/CONTEXT.md` — add `Sub-agent`, `Sub-agent profile`, `Child session`, `Sub-agent depth` to the glossary
