# Zed — ACP client deep-read

Local source: `/Users/amir36/Documents/workspace/src/github.com/zed-industries/zed/`. ACP version pinned: `=0.11.1` with `unstable` features (`Cargo.toml:499`).

## Where it lives

- `crates/agent_servers/src/acp.rs` (~3400 LOC) — RPC handler for external ACP agents
- `crates/acp_thread/src/acp_thread.rs` — thread/session state machine
- `crates/agent_ui/src/conversation_view/thread_view.rs` — UI rendering (permission cards, tool calls)

## `session/request_permission` handler

`agent_servers/src/acp.rs:3344` — `handle_request_permission`. Marks the tool call as `WaitingForConfirmation` in the thread, emits a UI event, and returns the outcome (`Selected | Cancelled`) once the user clicks a button.

```rust
let task = thread.update(cx, |thread, cx| {
  thread.request_tool_call_authorization(
    args.tool_call,
    acp_thread::PermissionOptions::Flat(args.options),
    acp_thread::AuthorizationKind::PermissionGrant,
    cx,
  )
}).flatten_acp()?;
```

## UI: inline card in conversation (NOT modal, NOT sidebar)

`agent_ui/conversation_view/thread_view.rs:7162` — `render_permission_buttons_flat`. Renders all four `PermissionOptionKind` variants as inline buttons WITHIN the tool-call card in the conversation transcript. Visual cues:

| Kind | Icon | Color |
|---|---|---|
| `allow_once` | Check | Success (green) |
| `allow_always` | CheckDouble | Success (green) |
| `reject_once` | Close | Error (red) |
| `reject_always` | Close (disabled — no action bound) | Error (red) |

Each button has an associated GPUI `Action` (`&AllowOnce`, `&AllowAlways`, `&RejectOnce`) so keybindings work. `reject_always` button is rendered but **does not have a keybindable action wired** — the user can click but not key-shortcut it.

The card sits inline in the conversation so the user can scroll while it's pending. There's no blocking modal.

## `setSessionMode` invocation (deprecated path)

`agent_servers/src/acp.rs:3175` — `AcpSessionModes::set_mode`. Uses the deprecated `acp::SetSessionModeRequest`:

```rust
let result = into_foreground_future(
  connection.send_request(acp::SetSessionModeRequest::new(session_id, mode_id))
).await;
```

Optimistic local update (mutates `state.current_mode_id` immediately), reverts on failure. Confirms Zed has NOT yet migrated to the new `setSessionConfigOption` path (likely will when 0.11.x → 0.12.x).

## `SessionModeState` consumption

`agent_servers/src/acp.rs:1095-1120` — reads `response.modes` from `session/load` (and similar paths for new/resume), stores in `session.session_modes` wrapped in `Rc<RefCell<>>` for live updates.

```rust
let (modes, models, config_options) = config_state(response.modes, response.models, response.config_options);
session.session_modes = modes;
```

Zed handles BOTH the legacy `modes` field AND the new `config_options` field. When an agent provides both, Zed appears to prefer one (haven't traced exactly, but `config_state` does the merge).

## `CurrentModeUpdate` notification handler

`agent_servers/src/acp.rs:3479-3485` — when agent emits `CurrentModeUpdate` via `session/update`, Zed mutates the local `current_mode_id` AND forwards the update to `thread.handle_session_update()`. UI re-renders the mode badge.

## Tool-call card status rendering

`agent_ui/conversation_view/thread_view.rs:7887-7918`:

| Status | Visual |
|---|---|
| `pending` (input streaming OR awaiting approval) | Spinner |
| `in_progress` | Spinner |
| `completed` | Green check |
| `failed` | Red close |
| `cancelled` | Grey circle |

So a tool call awaiting `requestPermission` shows a spinner + the inline permission buttons below it. Good model for bodhi-pi's browser host.

## Filesystem — Zed IS the trust boundary

`agent_servers/src/acp.rs:3383` (`handle_write_text_file`), `:3418` (`handle_read_text_file`). Both delegate to Zed's `Project`/buffer APIs. Path validation, write permissions, dirty-buffer reconciliation — all Zed's responsibility. The agent NEVER touches fs.

This is the **standard ACP architecture**: client owns fs, agent asks. Bodhi-pi inverts this (host injects `Filesystem`; agent calls directly).

## Permission persistence

Zed does NOT persist `allow_always` outcomes to per-agent/per-workspace rules. Session-memory only. Cross-session "allow this tool always" is achieved through Zed's separate global `tool_permissions` settings (in `agent_settings.rs:170-374`), which is NOT derived from ACP outcomes. So if a user clicks "Allow always" in an ACP agent's permission card, it remembers for that session only.

This is interesting: in standard ACP, **the agent is the natural place to persist** if it wants cross-session memory. cc, Codex, and bodhi-pi all do this. Zed (as client) chose not to bother.

## Implication for bodhi-pi

- **Inline-card pattern is the recommended browser-host approach** — better UX than blocking modal (user can scroll/copy/inspect while pending). Update milestone 030 / browser host to prefer inline card. CLI host still uses prompt; HTTP/browser/chrome-ext use inline card.
- **Zed supports BOTH `setSessionMode` AND `setSessionConfigOption`** through `config_state(...)`. Bodhi-pi can ship just the new path — if Zed targets `=0.11.1` and only handles `modes`, then bodhi-pi exposing `configOptions` works too because Zed merges both. Test against actual Zed before promising — but the spec says clients should prefer `configOptions` when both are present.
- **All 4 PermissionOptionKinds should be offered** when the mode is restrictive enough to make `allow_always`/`reject_always` meaningful. For `ask` mode, all 4. For `plan` mode (deny by default), only `allow_once` and `reject_once` (an `allow_always` to bypass plan-mode write-deny is incoherent). claude-agent-acp's plan-exit only offers 3 — bodhi-pi should mirror.
- **Keybinding support per button** — bodhi-pi browser host should add keybindings (y/A/n) per Zed pattern.
