# Deferred from v1 (tracked inventory)

Each entry: what, why deferred, where it will be picked up. Update this file as items move into a phase or get resolved.

## Profile sources beyond markdown — ✅ resolved in v2

Both items below shipped in v2 (P2c + P2d). See [v2-retrospective.md](./v2-retrospective.md).

- ~~**Extension-registered profiles** — added to `ExtensionAPI.registerSubagentProfile(def)`. Roadmap: P2d.~~
- ~~**Bundled built-in profiles** — `src/subagents/profiles/<name>.md` or similar. Roadmap: P2c.~~

## Context modes — ✅ fork mode resolved in P2a

`context: "fork"` shipped in P2a. See [p2a-retrospective.md](./p2a-retrospective.md).

- ~~**Forked context** — child inherits parent's conversation slice. v1 only supports `fresh`. Profile schema already accepts `context: "fork"` to keep the future API stable; v1 throws "not yet supported" if `fork` is requested. Roadmap: P2a.~~
- **Selected transcript slice** — child gets a curated subset of parent messages (per-call `slice: {...}` override). Future. Not in current roadmap.
- **Mid-pair pair-completeness hardening** — placeholder-injection for slicing that lands mid `tool_call`/`tool_result`. P2a inherits the existing `_bodhi-pi/session/fork` gap. Revisit if it bites.

## Execution modes — ✅ parallel resolved

Parallel sub-agent execution: the LLM emits multiple `subagent` tool calls in one assistant message, pi-agent-core dispatches them concurrently via `Promise.all`. Phase 1 unregistered `subagent_batch` from the LLM tool list (commit 6a2bd218); Phase 2 deleted the entire batch surface (2026-05-19). See `milestones/040-parallel-batch.md` (Superseded), `milestones/005-architecture-decisions.md` Decision 3 (Superseded), and `../plans/we-want-to-merge-jiggly-meteor.md`.

- **Background runs** — fire-and-forget child with synthetic result injection. Roadmap: P3a.
- ~~**Parallel batch** — multiple children launched together.~~ ✅ via LLM parallel tool-use of `subagent`.
- **Resume mid-run** — re-attach to a child that was running when the tab closed. Roadmap: P3b.

## Policy surfaces

- **MCP inheritance + allow/deny lists** — v1 children get NO MCP tools (the profile schema has no `mcp:` field at all to avoid baking a half-finished policy). Inheritance + granular allow/deny lands together in P3c.
- **Extension allow/deny** — v1 children inherit all parent extensions. Future, no specific phase yet.
- **Tool execution permissions** — `Permissioner`-style runtime gating. Cross-cutting with skills' `allowed-tools` enforcement (which is also deferred). Not in this roadmap.

## UX surfaces

- **Fuller slash UX** (`/run`, `/chain`, `/parallel`) — Roadmap: P4b.
- **Child-session visible in `listSessions` by default** — chose "real but filtered" in v1. Could change if user research shows demand. Currently revisit only on explicit feedback.
- **In-chat live transcript expansion** for the child — Host-side enhancement; works via existing ACP wire today (the child's `session/update` notifications flow naturally; the Host just chooses when to render them). Not a core change.

## Isolation

- **Worktree isolation** — cli-only. Roadmap: P4a.
- **Path scope** (subagent can only read/write a subdirectory) — future, depends on a Permissioner layer.

## Conversational features

- **Skill inheritance for child agents** — Roadmap: P3d.
- **Intercom-style child↔parent messaging** (pi-intercom style) — future, depends on a pi-intercom equivalent for bodhi-pi. No current phase.
- **Workflow handoff mode** (named-specialist routing within one session) — Roadmap: P4c, conceptually distinct from child-session delegation.

## Cross-process / cross-host

- **Remote sub-agents** (A2A protocol) — Roadmap: P4d.

## Open knobs to revisit per phase

- Recursion: v1 hard cap at depth 2, child opt-in disabled (the `subagent` tool is excluded from child tool sets unconditionally in v1). Should we expose `maxDepth` per profile in a later phase?
- Profile model fallback: v1 uses `profile.model → params.modelOverride → parent's current`. Should there be a `subagents.defaultModel` setting layer? Revisit when bundled profiles land (P2c).
- Compaction: child sessions follow the same compaction rules as parents. Probably fine, but watch for cost surprises in long children. Revisit if retrospective surfaces issues.
- Child profile discovery: v1 children do NOT call `loadProjectSubagents` — only the top-level session has the profile registry. Confirmed sensible because children never get the `subagent` tool in v1. Revisit if/when recursion opt-in lands.

## Status of pre-v1 ideas

| Idea | Status | Note |
|---|---|---|
| First-party `subagent` tool | In v1 | C2 |
| Markdown profile discovery | In v1 | C1 |
| Slash UX `/agents`, `/subagent` | In v1 | C3 |
| Child session in SessionStore with parentSessionId | In v1 | C1 plumbing + C2 use |
| Recursion depth 2 cap | In v1 | C2 |
| Bundled profiles | **In v2** | P2c — `explore` + `planner` ship in `src/subagents/profiles/` |
| Extension-registered profiles | **In v2** | P2d — `ExtensionAPI.registerSubagentProfile(def)` |
| Cancellation regression test | **In v2** | C3a |
| `subagentDepth` cached on SessionState | **In v2** | C3b |
| `evictChild` lifecycle per-status | **In v2** | C3c |
| Forked context | **In P2a** | C3 — `context: "fork"` accepted in schema + spawn flow wired |
| Parallel batch | **Shipped P2b, retired Phase 2 (2026-05-19)** | Initially `subagent_batch` LLM tool; replaced by LLM parallel tool-use of `subagent`. |
| Background mode | Deferred | P3a |
| Worktree | Deferred | P4a (cli-only) |
