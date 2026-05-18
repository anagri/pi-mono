# Goose — ACP server deep-read

Local: `/Users/amir36/Documents/workspace/src/github.com/aaif-goose/goose/`. `agent-client-protocol = 0.11` + schema 0.12 unstable.

## Headline: Goose makes the OPPOSITE filesystem choice from cc/Codex/bodhi-pi

`crates/goose/src/acp/fs.rs:26-60`:

```rust
async fn acp_read_text_file(cx: &ConnectionTo<Client>, session_id: &SessionId, path: &Path, ...) -> Result<String, String> {
  let mut request = ReadTextFileRequest::new(session_id.clone(), path.to_path_buf());
  let response = cx.send_request(request).block_task().await...;
  Ok(response.content)
}

async fn acp_write_text_file(cx: &ConnectionTo<Client>, session_id: &SessionId, path: &Path, content: &str) -> Result<(), String> {
  let request = WriteTextFileRequest::new(session_id.clone(), path.to_path_buf(), content.to_string());
  cx.send_request(request).block_task().await...;
  Ok(())
}
```

**Goose's tools call back through ACP `fs/*` requests** — even though Goose is a full native agent that COULD access fs directly. This is a deliberate architectural choice: the ACP client (Zed) is the trust boundary for fs.

This puts Goose in a different camp from bodhi-pi. Two distinct architectures:
- **Client-owned fs**: Goose, cc-acp, Zed-as-client → agent calls `fs/*` over ACP
- **Agent-owned fs**: bodhi-pi, codex-acp, pi-acp → agent's tools access fs directly via injected adapter

Both are valid. Bodhi-pi's choice is fine; this note is for documentation, not action.

## All 4 modes 1:1 to ACP

`crates/goose/src/acp/server.rs:950-967`:

```rust
fn build_mode_state(current_mode: GooseMode) -> Result<SessionModeState, ...> {
  let mut available = Vec::with_capacity(GooseMode::VARIANTS.len());
  for &name in GooseMode::VARIANTS {
    let goose_mode: GooseMode = name.parse()?;
    let mut mode = SessionMode::new(SessionModeId::new(name), name);
    mode.description = goose_mode.get_message().map(Into::into);
    available.push(mode);
  }
  Ok(SessionModeState::new(...))
}
```

All four `GooseMode` variants (`Auto | Approve | SmartApprove | Chat`) exposed as four ACP `SessionMode`s. Direct 1:1 mapping. No collapse, no hide.

**Goose uses `SessionModeState` (deprecated path)**, not `configOptions`. Same as Zed itself.

## `setSessionMode` handler

`crates/goose/src/acp/server.rs:3251-3270`:

```rust
async fn on_set_mode(&self, session_id: &str, mode_id: &str) -> Result<SetSessionModeResponse, ...> {
  let mode = mode_id.parse::<GooseMode>()?;
  let agent = self.get_session_agent_provider_ready(session_id).await?;
  agent.update_goose_mode(mode, session_id).await?;
  Ok(SetSessionModeResponse::new())
}
```

`crates/goose/src/acp/server/dispatch.rs:288-296`: emits `CurrentModeUpdate` notification BEFORE responding (so clients see the update even before the request's `Ok` arrives — handles race where client unblocks on response before receiving the broadcast).

```rust
cx.send_notification(SessionNotification::new(session_id,
  SessionUpdate::CurrentModeUpdate(CurrentModeUpdate::new(mode_id)),
))?;
responder.respond(resp)?;
```

**Lesson for bodhi-pi**: emit `ConfigOptionUpdate` BEFORE returning from `setSessionConfigOption`. Avoids the same race.

## `requestPermission` — all 4 PermissionOptionKinds

`crates/goose/src/acp/server.rs:2120-2196`:

```rust
let options = vec![
  option(PermissionOptionKind::AllowAlways),
  option(PermissionOptionKind::AllowOnce),
  option(PermissionOptionKind::RejectOnce),
  option(PermissionOptionKind::RejectAlways),
];

let permission_request = RequestPermissionRequest::new(session_id, tool_call_update, options);

cx.send_request(permission_request).on_receiving_result(|result| async move {
  match result {
    Ok(response) => {
      agent.handle_confirmation(request_id, outcome_to_confirmation(&response.outcome)).await;
      // ...
    }
  }
});
```

**All four kinds offered**. Maps user response back via `outcome_to_confirmation` → Goose's `PermissionDecision` enum → `Permission` (persisted per-tool).

**Goose persists `AllowAlways` to its own permission_manager** (cross-session). Same agent-side persistence pattern as cc/Codex/bodhi-pi.

## SmartApprove on the wire

ACP clients CAN'T distinguish `SmartApprove` from `Approve` on the wire — both result in `requestPermission` calls for the same tools. The LLM-classifier runs server-side (`permission_inspector.rs:165-171`) BEFORE the wire. By the time ACP sees the request, the classifier has already decided "this needs human approval".

**Implication for bodhi-pi**: even if bodhi-pi later adopts a SmartApprove-like LLM classifier (deferred, per [research report's milestone roadmap](../report.md)), the wire surface doesn't change. The classifier just short-circuits some `ask` decisions to `allow`.

## Sub-agent / fork inheritance

`crates/goose/src/acp/server.rs:3437` — on `ForkSessionRequest`, the new session inherits the parent's current `goose_mode` at fork time. After fork, parent and child are independent — mode changes on parent don't propagate to existing forks.

**This matches bodhi-pi's milestone 070 plan** — Qwen-rule child resolution at spawn time, no live-link after.

## Implication for bodhi-pi

| Goose pattern | Bodhi-pi adoption |
|---|---|
| All native modes exposed 1:1 to ACP | Adopt: 4 modes, no collapse |
| Emit `ConfigOptionUpdate` BEFORE response to avoid race | Adopt — small but important detail for milestone 020 |
| Offer all 4 PermissionOptionKinds | Adopt for `ask` mode; subset for plan-mode-exit and other contexts |
| Persist `AllowAlways` agent-side | **Already aligned** — milestone 090 |
| LLM-classifier transparent on the wire | Adopt if/when SmartApprove-like mode is added — wire stays the same |
| Fork inherits mode at creation, no live-link | **Already aligned** — milestone 070's Qwen rule |
| `fs/*` proxied through ACP client | **Reject** — bodhi-pi's "agent owns filesystem" decision |

## Notable architectural divergence on filesystem

This is the single biggest divergence between Goose and bodhi-pi. It's a deliberate decision worth documenting in bodhi-pi's spec for future contributors:

| Aspect | Goose | Bodhi-pi |
|---|---|---|
| Where fs lives | Client (Zed) | Host-injected `Filesystem` adapter (in same process as agent for cli/browser/chrome-ext; in server process for http) |
| Who validates paths | Zed's `Project` API | Bodhi-pi's tool implementations + host's adapter (e.g. ZenFS scoping) |
| Who handles unsaved buffers | Zed (via `read_text_file` reading dirty buffer state) | Bodhi-pi can't see editor buffers — sees disk state only |
| Trust boundary for fs | Zed | Bodhi-pi agent's PermissionService + host's adapter scope |
| Performance | RPC per fs op (over stdio/ws) | In-process call (cli/browser/chrome-ext) or HTTP per op (http) |

Bodhi-pi chose "agent owns fs" because:
1. Lower latency for browser-worker and chrome-ext where most tools are in-process
2. Editor-buffer integration is not bodhi-pi's primary use case (bodhi-pi is headless)
3. Host's adapter pattern already exists and is more flexible (in-memory, ZenFS, real `node:fs`)

This decision means bodhi-pi's PermissionService is THE trust boundary (no fallback in ACP client). The hardcoded safety-immune deny list (milestone 060) is critical to compensate.
