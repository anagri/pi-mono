# ACP Implementation Research — bodhi-pi vs zed (and known coding agents)

**Date:** 2026-05-12
**Scope:** `packages/bodhi-pi` ACP server vs `zed-industries/zed` ACP client, with reference patterns from
`zed-industries/claude-code-acp`, `zed-industries/codex-acp`, and `sst/opencode`.

This folder consolidates the analysis that should drive the next round of production-hardening work in
`bodhi-pi`. Read the files in order:

| # | File | What it covers |
|---|------|----------------|
| 1 | `01-zed-acp-architecture.md` | How zed implements the ACP **client** side. Connection lifecycle, dispatch model, session ref-counting, history replay, error mapping, terminal forwarding, telemetry, debug logs. |
| 2 | `02-bodhi-pi-vs-zed-comparison.md` | Side-by-side mapping of every ACP method, notification, and concept. Calls out gaps, mismatches, and where bodhi-pi deviates from what real clients expect. |
| 3 | `03-best-practices-from-known-agents.md` | Patterns harvested from claude-code-acp (TypeScript, Claude SDK bridge), codex-acp (Rust, codex-core bridge), and opencode (TypeScript, opencode SDK bridge). Authoritative reference for what a "production" ACP server looks like. |
| 4 | `implementation.md` | The actionable plan: prioritized list of changes for `packages/bodhi-pi` (and the five reference hosts) with line-of-code anchors and acceptance criteria. |

## TL;DR

bodhi-pi already gets the **fundamentals** right: it uses `AgentSideConnection` from the official SDK,
implements every spec-required method, wires `pi-agent-core` events into spec-stable
`session/update` notifications, ships pagination, model/thinking config options, history replay on
`session/load`, and a clean three-layer settings model. Most of the gaps below are not protocol
incorrectness — they're **production-grade ergonomics** that every other published ACP agent
ships:

1. **No `fs/read_text_file` / `fs/write_text_file` outbound calls.** bodhi-pi exclusively uses the
   host-injected `Filesystem` and never asks the client to do file I/O. This is a deliberate
   architectural choice (per CLAUDE.md), but it means clients with read-only file capabilities
   never get edit previews or unsaved-buffer awareness from bodhi-pi the way they do from
   claude-code-acp / codex-acp / opencode. **Every other ACP agent uses `client.readTextFile` /
   `client.writeTextFile` for edits** so the host editor can show diffs in unsaved buffers.
2. **No `session/request_permission` flow.** bodhi-pi has zero permission gating today. claude-code,
   codex, and opencode all surface tool calls (especially `bash`/`edit`) for client approval before
   running them. This is **the most important production gap.**
3. **No `terminal/*` outbound calls.** Bash/shell-style tools are not yet present (the `bash` row
   in PARITY.md is deferred). When they land, they should use ACP `terminal/create` rather than
   in-process execution — that's how zed renders live terminal output cards in the IDE.
4. **`tool_call` title/kind fidelity is thin.** `formatLocationHint` only emits `path`. claude-code,
   codex, and opencode emit per-tool human-readable titles ("Read src/foo.ts", "Edit (3 hunks)",
   `cargo build`). zed's UI renders these prominently in tool cards.
5. **No `tool_call_update.locations` for navigation.** Zed's `acp_thread::resolve_locations`
   auto-scrolls the editor to the line the tool just touched. bodhi-pi doesn't emit `locations`.
6. **No `available_commands_update` on settings/skills change.** When the user edits
   `.bodhi-pi/commands/` mid-session, the picker stays stale until the next `session/load`.
   bodhi-pi already has the event bus to drive this — just not wired.
7. **Authentication is a bypass (`authenticate()` returns `{}`).** Real clients expect a typed
   `auth_required` error code (`-32000`) for unauthenticated states. claude-code, codex, opencode
   all throw `RequestError.authRequired()` from `prompt()` when no API key is configured.
8. **`session/close` doesn't reference-count.** Zed concurrent loaders share one thread. bodhi-pi
   drops state on the first `close` — fine for single-client usage, broken for the
   `bodhi-pi-ws-server` multi-tenant case where one logical session may be open in several tabs.
9. **No `_meta.terminal_info` / `terminal_output` / `terminal_exit` bridging** for non-ACP
   terminals — zed's bridge in `agent_servers/src/acp.rs:3505-3606` reads this from ToolCall meta
   to render terminal cards for agents that don't speak full ACP terminals yet.
10. **No debug-log capture surface.** zed's `AcpDebugLog` captures every JSON-RPC message + stderr
    line with a 2000-message ring buffer. bodhi-pi has no equivalent — debugging a stuck session
    today requires re-running with `console.log` patches.

See `implementation.md` for the prioritized roll-out (P0/P1/P2) and the unit-test surfaces each
item should land with.

## Source pointers (for the report-writers)

- bodhi-pi ACP wire: `packages/bodhi-pi/src/acp/agent.ts` (2052 lines), `packages/bodhi-pi/src/acp/notifications.ts`, `packages/bodhi-pi/src/acp/constants.ts`
- bodhi-pi PARITY: `packages/bodhi-pi/PARITY.md`
- zed ACP client (the side that talks to bodhi-pi-shaped servers):
  - `crates/acp_thread/src/connection.rs` — `AgentConnection` trait + optional capability traits
  - `crates/acp_thread/src/acp_thread.rs` — `AcpThread::handle_session_update` (the canonical receiver)
  - `crates/agent_servers/src/acp.rs` — stdio transport, session ref-counting, history-replay race, terminal forwarding, debug log
  - `crates/agent_servers/src/custom.rs` — per-agent quirks (claude/codex/gemini env vars)
- Known agents (deepwiki abstracts in `03-best-practices-from-known-agents.md`):
  - `zed-industries/claude-code-acp` — TypeScript, wraps `@anthropic-ai/claude-agent-sdk`
  - `zed-industries/codex-acp` — Rust, wraps `codex-core`
  - `sst/opencode` — TypeScript, wraps opencode's own SDK
