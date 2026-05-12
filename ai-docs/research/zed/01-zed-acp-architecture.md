# Zed's ACP Implementation — Architecture Deep Dive

**Source:** `/Users/amir36/Documents/workspace/src/github.com/zed-industries/zed`
**Workspace dep:** `agent-client-protocol = "=0.11.1"` (with `unstable` feature) — `Cargo.toml:499`
**Date:** 2026-05-12

This file documents how Zed implements the **client** side of ACP. bodhi-pi implements the
**server** (agent) side, so the patterns here describe what bodhi-pi's wire output must look like
to be a first-class citizen in the zed IDE and other ACP-aware editors. The two sides share the
same `agent_client_protocol` crate/SDK, so the type names line up 1:1.

## 1. Crate layout

```
crates/
├── acp_thread/          # protocol-agnostic representation of a conversation
│   └── src/
│       ├── acp_thread.rs   (5611 lines) — AcpThread entity: receives session updates,
│       │                                   stores entries, drives streaming text reveal
│       ├── connection.rs   (1037 lines) — AgentConnection trait + capability sub-traits
│       │                                   (AgentSessionList, AgentSessionModes,
│       │                                    AgentModelSelector, AgentSessionConfigOptions,
│       │                                    AgentSessionTruncate, AgentSessionSetTitle,
│       │                                    AgentSessionRetry, AgentTelemetry,
│       │                                    PermissionOptions, AuthRequired, ...)
│       ├── diff.rs         (454 lines)  — Pending vs Finalized diff rendering
│       ├── mention.rs      (996 lines)  — @-mention parsing and rich content blocks
│       └── terminal.rs     (255 lines)  — Terminal entity created via ACP terminal/create
│
├── agent_servers/       # ACP-over-stdio transport
│   └── src/
│       ├── agent_servers.rs (157 lines) — AgentServer trait + AgentServerDelegate
│       ├── acp.rs          (3780 lines) — AcpConnection: spawn child, handshake, dispatch loop,
│       │                                   ref-counted session map, history-replay race fix,
│       │                                   terminal_info meta bridging, AcpDebugLog
│       ├── custom.rs       (599 lines)  — per-agent settings (claude-acp, codex-acp, gemini, ...)
│       └── e2e_tests.rs    (450+ lines) — end-to-end against real subprocesses
│
└── acp_tools/           # Developer-facing ACP debug panel
    └── src/
        └── acp_tools.rs    (31535 lines) — UI to view the ACP debug log, filter by direction
```

`acp_thread` is the **portable representation** — it doesn't know whether it's talking to a stdio
subprocess or zed's own in-process native agent. Both paths feed it `acp::SessionUpdate`
notifications. `agent_servers` is the **stdio adapter**. `acp_tools` is the **debug UI**.

## 2. The `AgentConnection` trait

`connection.rs:47-192` defines the trait that any ACP-speaking agent implementation has to satisfy.
This is the production contract — what zed expects from claude-code-acp, codex-acp, opencode, and
(eventually) bodhi-pi:

```rust
pub trait AgentConnection {
    // identity
    fn agent_id(&self) -> AgentId;
    fn telemetry_id(&self) -> SharedString;
    fn agent_version(&self) -> Option<SharedString>;

    // session lifecycle (required)
    fn new_session(self: Rc<Self>, project, work_dirs, cx) -> Task<Result<Entity<AcpThread>>>;
    fn prompt(&self, user_message_id, params, cx) -> Task<Result<acp::PromptResponse>>;
    fn cancel(&self, session_id, cx);

    // session lifecycle (optional, gated by initialize-time capability flags)
    fn supports_load_session(&self) -> bool { false }
    fn load_session(...) -> Task<...> { /* default: unsupported */ }
    fn supports_resume_session(&self) -> bool { false }
    fn resume_session(...) -> Task<...> { /* default: unsupported */ }
    fn supports_close_session(&self) -> bool { false }
    fn close_session(...) -> Task<...> { /* default: unsupported */ }

    // auth
    fn auth_methods(&self) -> &[acp::AuthMethod];
    fn authenticate(&self, method, cx) -> Task<Result<()>>;
    fn terminal_auth_task(&self, method, cx) -> Option<Task<Result<SpawnInTerminal>>>;

    // optional capabilities (returns Some(...) only if agent advertised them)
    fn truncate(&self, session_id, cx)         -> Option<Rc<dyn AgentSessionTruncate>>;
    fn retry(&self, session_id, cx)            -> Option<Rc<dyn AgentSessionRetry>>;
    fn set_title(&self, session_id, cx)        -> Option<Rc<dyn AgentSessionSetTitle>>;
    fn model_selector(&self, session_id)       -> Option<Rc<dyn AgentModelSelector>>;
    fn session_modes(&self, session_id, cx)    -> Option<Rc<dyn AgentSessionModes>>;
    fn session_config_options(&self, sid, cx)  -> Option<Rc<dyn AgentSessionConfigOptions>>;
    fn session_list(&self, cx)                 -> Option<Rc<dyn AgentSessionList>>;
    fn telemetry(&self)                        -> Option<Rc<dyn AgentTelemetry>>;
}
```

Each `Option<Rc<dyn ...>>` is the local-side handle to a capability. Where the underlying agent is
ACP-over-stdio, those handles wrap `connection.send_request(acp::SetSession...)` calls.

The capability advertisement happens in `initialize`'s response:
- `agent_capabilities.load_session: true` → `supports_load_session()` returns true
- `session_capabilities.close.is_some()` → `supports_close_session()`
- `session_capabilities.list.is_some()` → `session_list()` returns Some
- `session_capabilities.resume.is_some()` → `supports_resume_session()`
- Per-session: `NewSessionResponse.modes` populated → `session_modes()` returns Some
- Per-session: `NewSessionResponse.models` populated → `model_selector()` returns Some
- Per-session: `NewSessionResponse.config_options` populated → `session_config_options()` returns Some

**Mutual exclusion (acp.rs:3142-3158, `config_state`):** if an agent emits `config_options`, zed
suppresses the older `modes` and `models` channels. `config_options` is the modern unified
selector surface; `modes`/`models` are kept for back-compat with older agents.

## 3. Stdio transport — `AcpConnection::stdio` (acp.rs:682-967)

When the user starts a chat against an external agent (claude-acp, codex-acp, bodhi-pi-cli, ...):

1. **Spawn**: build child via `ShellBuilder::new(System).non_interactive()`. Pipe stdin/stdout/stderr.
   Set `cwd` to the project root when local.
2. **Tap stdout/stdin with `AcpDebugLog`** (more on this in §10) — every JSON-RPC line is
   inspect-parsed into a `AcpDebugMessage` and pushed into a 2000-entry ring buffer + fan-out
   channel.
3. **Build a `Lines` transport** over the tapped streams and hand it to `Client.builder()` with
   the full handler set.
4. **Foreground dispatch channel**: every inbound request/notification handler closure must be
   `Send`. The handlers do nothing but `enqueue_request(...)` / `enqueue_notification(...)` onto
   an `mpsc::UnboundedSender<ForegroundWork>` (acp.rs:376-411). A separate foreground task drains
   the channel and runs the actual handler with a `&mut AsyncApp`. **This is the bridge between
   the SDK's `Send` callbacks and zed's `!Send` GPUI entities.**
5. **Race against the child exiting**: `futures::future::select(connection_rx, status_fut)` —
   if the child exits before producing a JSON-RPC handshake, raise
   `LoadError::Exited { status, stderr: <trailing stderr> }` (acp.rs:221-226 + 199-218 for the
   "trailing stderr" extraction). This is how zed surfaces npm/install errors visibly instead of
   spinning forever.
6. **Send `initialize`** with the full client capability advertisement
   (acp.rs:851-873) — fs read+write, terminal, terminal-auth in meta — and reject any
   `protocol_version < V1`.
7. **Wire the wait task** so a future exit (after handshake) `emit_load_error_to_all_sessions`,
   propagating the failure into every live `AcpThread`'s error stream.
8. **Detect session-list capability**: only construct the `AcpSessionList` proxy if
   `session_capabilities.list.is_some()` — otherwise the UI hides the picker.

The full handler set (acp.rs:591-670, `connect_client_future`):

```
Inbound REQUESTS handled by zed (agent → client):
  request_permission       — zed prompts the user (PermissionOptions UI)
  write_text_file          — zed writes to project buffer (respects unsaved state)
  read_text_file           — zed reads via project buffer (unsaved state visible)
  create_terminal          — zed spawns a terminal entity, returns terminal_id
  kill_terminal            — zed kills the inner shell process
  release_terminal         — zed removes the terminal entity
  terminal_output          — zed returns current output + exit_status snapshot
  wait_for_terminal_exit   — zed awaits the terminal's exit task

Inbound NOTIFICATIONS:
  session_notification     — the only inbound notification carries SessionUpdate
                             (see §5 for the dispatch tree)
```

## 4. Session ref-counting + concurrent-load race fix (acp.rs:1006-1141)

`open_or_create_session` is the most subtle piece of the whole crate. It guarantees:

- Two concurrent `load_session` calls for the same `session_id` share one `AcpThread` and dispatch
  the ACP `load_session` RPC **exactly once**.
- `session/update` notifications that arrive **during** history replay (and `load_session`
  responds *after* the agent has streamed back the entire history) find the thread waiting for
  them — not dropped on the floor.
- A `close_session` arriving while a `load_session` is still in flight decrements the pending
  ref-count cleanly; only the final `close` actually dispatches the close RPC.

The implementation:

```rust
fn open_or_create_session(self: Rc<Self>, session_id, project, work_dirs, title,
                          rpc_call: impl FnOnce(connection, session_id, cwd) -> Future<...>,
                          cx: &mut App)
    -> Task<Result<Entity<AcpThread>>> {

    // (a) Pending-task de-dup: concurrent loaders share the in-flight task.
    if let Some(pending) = self.pending_sessions.borrow_mut().get_mut(&session_id) {
        pending.ref_count += 1;
        let task = pending.task.clone();
        return cx.foreground_executor().spawn(async move { task.await... });
    }

    // (b) Already-loaded session: bump ref_count and hand out the existing entity.
    if let Some(session) = self.sessions.borrow_mut().get_mut(&session_id) {
        session.ref_count += 1;
        if let Some(thread) = session.thread.upgrade() { return Task::ready(Ok(thread)); }
    }

    // (c) Construct the AcpThread BEFORE awaiting the RPC. Pre-register in `sessions` so
    //     SessionUpdate notifications arriving during history replay can find it.
    let shared_task = cx.spawn({
        let session_id = session_id.clone();
        async move |cx| {
            let thread = cx.new(|cx| AcpThread::new(...));
            this.sessions.borrow_mut().insert(session_id.clone(), AcpSession {
                thread: thread.downgrade(),
                suppress_abort_err: false,
                session_modes: None,
                models: None,
                config_options: None,
                ref_count: 1,
            });

            let response = match rpc_call(this.connection.clone(), session_id.clone(), cwd).await {
                Ok(r) => r,
                Err(err) => {
                    // Roll back the pre-registered entry on RPC failure.
                    this.sessions.borrow_mut().remove(&session_id);
                    this.pending_sessions.borrow_mut().remove(&session_id);
                    return Err(Arc::new(err));
                }
            };

            // Fill in modes/models/config from the response and apply default config options.
            ...

            // CRITICAL: a close arriving during the RPC may have removed our `sessions`
            // entry. Detect this and fail the load instead of returning an orphaned thread.
            {
                let mut sessions = this.sessions.borrow_mut();
                let Some(session) = sessions.get_mut(&session_id) else {
                    return Err(Arc::new(anyhow!("session was closed before load completed")));
                };
                session.session_modes = modes;
                session.models = models;
                session.config_options = config_options.map(ConfigOptions::new);
                session.ref_count = pending.ref_count;
            }

            Ok(thread)
        }
    }).shared();

    self.pending_sessions.borrow_mut().insert(session_id, PendingAcpSession {
        task: shared_task.clone(),
        ref_count: 1,
    });

    cx.foreground_executor().spawn(async move { shared_task.await... })
}
```

`close_session` (acp.rs:1594-1660) mirrors this. It checks `pending_sessions` first (decrement
ref-count, only dispatch ACP close when pending hits zero), then `sessions` (same).

The regression tests at `acp.rs:2737-3092` codify the four failure modes this design protects
against:
1. Two concurrent loads should share one thread and one RPC.
2. History-replay notifications must reach the thread (the `sessions` entry must be live before
   the RPC awaits).
3. `close_session` during in-flight load must abort cleanly with `"session was closed before load
   completed"`.
4. `close_session` during in-flight load with another concurrent loader still active must NOT
   close — only the final ref drops the session.

**This is the single most important pattern bodhi-pi is missing.** See implementation.md §P0-2.

## 5. The session_update dispatch tree (acp.rs:3452-3606 + acp_thread.rs:1451-1527)

When a `session_notification` arrives, the work is split between **AcpConnection** (transport-level
state tracking: modes, config, session-list) and **AcpThread** (in-thread state: chunks, tool calls,
plans).

```
handle_session_notification(notification, cx, ctx) {
    let (thread, session_modes, config_opts_data) = ctx.sessions.borrow().get(&sid)...;

    // (a) Transport-level cache updates — happen BEFORE forwarding to the thread.
    if let CurrentModeUpdate { current_mode_id, .. } = &update {
        session_modes.borrow_mut().current_mode_id = current_mode_id;
    }
    if let ConfigOptionUpdate { config_options, .. } = &update {
        *config_opts_cell.borrow_mut() = config_options.clone();
        tx_cell.borrow_mut().send(()).ok();   // wake the watch::Receiver
    }
    if let SessionInfoUpdate(info_update) = &update {
        if let Some(session_list) = ctx.session_list.borrow().as_ref() {
            session_list.send_info_update(sid.clone(), info_update.clone());
        }
    }

    // (b) Pre-handle: terminal_info meta — synthesize a display-only terminal for agents
    //     that emit terminal output via meta (not via terminal/create).
    if let ToolCall(tc) = &update {
        if let Some(meta) = &tc.meta && let Some(terminal_info) = meta.get("terminal_info") {
            let terminal_id = TerminalId::new(terminal_info["terminal_id"]);
            let cwd = terminal_info["cwd"].as_str().map(PathBuf::from);
            thread.update(cx, |t, cx| {
                let builder = TerminalBuilder::new_display_only(...)?;
                let lower = cx.new(|cx| builder.subscribe(cx));
                t.on_terminal_provider_event(TerminalProviderEvent::Created {
                    terminal_id, label: tc.title.clone(), cwd, output_byte_limit: None,
                    terminal: lower,
                }, cx);
            });
        }
    }

    // (c) Forward the spec-stable part to AcpThread::handle_session_update.
    thread.update(cx, |t, cx| t.handle_session_update(update.clone(), cx))?;

    // (d) Post-handle: terminal_output / terminal_exit meta on ToolCallUpdate.
    if let ToolCallUpdate(tcu) = &update {
        if let Some(meta) = &tcu.meta {
            if let Some(term_out) = meta.get("terminal_output") {
                let data = term_out["data"].as_str().unwrap().as_bytes().to_vec();
                thread.update(cx, |t, cx| t.on_terminal_provider_event(
                    TerminalProviderEvent::Output { terminal_id, data }, cx));
            }
            if let Some(term_exit) = meta.get("terminal_exit") {
                let status = TerminalExitStatus::new()
                    .exit_code(term_exit["exit_code"].as_u64().map(|i| i as u32))
                    .signal(term_exit["signal"].as_str().map(String::from));
                thread.update(cx, |t, cx| t.on_terminal_provider_event(
                    TerminalProviderEvent::Exit { terminal_id, status }, cx));
            }
        }
    }
}
```

And then `AcpThread::handle_session_update` (acp_thread.rs:1451):

```rust
match update {
    UserMessageChunk(c)      => push_user_content_block (dedup against optimistic add),
    AgentMessageChunk(c)     => push_assistant_content_block(c, is_thought=false),
    AgentThoughtChunk(c)     => push_assistant_content_block(c, is_thought=true),
    ToolCall(tc)             => upsert_tool_call(tc, cx)?,
    ToolCallUpdate(tcu)      => update_tool_call(tcu, cx)?,
    Plan(plan)               => update_plan(plan, cx),
    SessionInfoUpdate(info)  => { update title if changed, fire TitleUpdated event },
    AvailableCommandsUpdate(c) => { cache + fire AvailableCommandsUpdated },
    CurrentModeUpdate(c)     => fire ModeUpdated event,
    ConfigOptionUpdate(c)    => fire ConfigOptionsUpdated event,
    UsageUpdate(u) if cx.has_flag::<AcpBetaFeatureFlag>() => { update token_usage + cost },
    _ => {}
}
```

**Two ergonomic patterns to lift:**

- **Optimistic-add dedup** (acp_thread.rs:1457-1468): when the client adds the user message
  locally before calling `session/prompt`, and the agent echoes it back via
  `UserMessageChunk`, the client skips the chunk if it's already present in the last user
  message.
- **Streaming text reveal** (acp_thread.rs:1689-1779): assistant text chunks aren't applied
  to the Markdown entity immediately. They're buffered, and a background task drains the
  buffer at a paced byte rate so the text "types out" smoothly even when the agent dumps a
  full message at once. The pacing target is configurable via `StreamingTextBuffer::REVEAL_TARGET`.

## 6. Tool-call upsert pattern (acp_thread.rs:1903-1971)

```rust
pub fn upsert_tool_call(&mut self, tool_call: acp::ToolCall, cx: &mut Context<Self>)
    -> Result<(), acp::Error> {
    let status = tool_call.status.into();
    self.upsert_tool_call_inner(tool_call.into(), status, cx)
}

pub fn upsert_tool_call_inner(&mut self, update: acp::ToolCallUpdate, status: ToolCallStatus,
                              cx: &mut Context<Self>) -> Result<(), acp::Error> {
    if let Some(ix) = self.index_for_tool_call(&id) {
        // Update existing entry in-place.
        call.update_fields(update.fields, update.meta, ...)?;
        call.status = status;
        cx.emit(AcpThreadEvent::EntryUpdated(ix));
    } else {
        // Insert new entry — full ToolCall constructor with kind/label/content/locations.
        let call = ToolCall::from_acp(update.try_into()?, status, ...)?;
        self.push_entry(AgentThreadEntry::ToolCall(call), cx);
    }
    self.resolve_locations(id, cx);   // (!) async path-to-buffer resolution + agent_location scroll
    Ok(())
}
```

The implicit ABI for bodhi-pi: **`ToolCall` is "create or replace whole record", `ToolCallUpdate`
is "patch by id"**. Either notification can carry any subset of `kind`, `title`, `status`, `content`,
`locations`, `rawInput`, `rawOutput`. Agents may emit just an id + status delta when streaming
progress. Today bodhi-pi emits `ToolCall` once with full args + status, then `ToolCallUpdate` with
`content` snapshots — which works, but it always re-sends `kind`/`status`/`rawInput` on every chunk
update because of the `agent.ts:1572-1582` snapshot pattern. Zed will deal with this but it's wasteful.

The **`locations` field** is critical for IDE integration. zed runs
`resolve_locations` after every upsert: it looks up the path in the project, opens (or finds) a
buffer, and — if the tool's locations include a final position — calls
`project.set_agent_location(Some(loc.into()), cx)` to **auto-scroll the editor to that line**.
bodhi-pi never emits locations, so this feature simply doesn't work in zed today.

## 7. Permission flow (acp.rs:3344-3381)

zed receives `request_permission` requests from the agent. The flow:

```rust
fn handle_request_permission(args: RequestPermissionRequest, responder, cx, ctx) {
    let thread = match session_thread(ctx, &args.session_id) {
        Ok(t) => t,
        Err(e) => return respond_err(responder, e),
    };

    cx.spawn(async move |cx| {
        let result: Result<_, acp::Error> = async {
            let task = thread.update(cx, |t, cx| {
                t.request_tool_call_authorization(
                    args.tool_call,                                   // a ToolCallUpdate
                    PermissionOptions::Flat(args.options),            // Vec<PermissionOption>
                    AuthorizationKind::PermissionGrant,               // vs SubagentSpawn etc.
                    cx,
                )
            }).flatten_acp()?;
            Ok(task.await)
        }.await;

        match result {
            Ok(outcome) => responder.respond(RequestPermissionResponse::new(outcome.into()))?,
            Err(e) => respond_err(responder, e),
        }
    }).detach();
}
```

`request_tool_call_authorization` (acp_thread.rs:2096-2128):

```rust
pub fn request_tool_call_authorization(&mut self, tool_call: ToolCallUpdate,
                                       options: PermissionOptions, kind: AuthorizationKind,
                                       cx: &mut Context<Self>)
    -> Result<Task<RequestPermissionOutcome>> {
    let (tx, rx) = oneshot::channel();
    let status = ToolCallStatus::WaitingForConfirmation { options, respond_tx: tx, kind };
    self.upsert_tool_call_inner(tool_call, status, cx)?;
    cx.emit(AcpThreadEvent::ToolAuthorizationRequested(tool_call_id.clone()));

    Ok(cx.spawn(async move |this, cx| {
        let outcome = match rx.await {
            Ok(o)                     => RequestPermissionOutcome::Selected(o),
            Err(oneshot::Canceled)    => RequestPermissionOutcome::Cancelled,
        };
        this.update(cx, |_, cx| cx.emit(AcpThreadEvent::ToolAuthorizationReceived(tool_call_id))).ok();
        outcome
    }))
}
```

So the **tool card itself doubles as the permission prompt UI**: the status flips to
`WaitingForConfirmation` with the option list embedded. When the user clicks an option, the UI
sends the result through `respond_tx`, which resolves the future the request-permission RPC is
awaiting.

`PermissionOptions` is rich (connection.rs:474-624):
- `Flat(Vec<PermissionOption>)` — old-style.
- `Dropdown(Vec<PermissionOptionChoice>)` — paired allow/deny choices.
- `DropdownWithPatterns { choices, patterns, tool_name }` — for `bash` etc., the user can check
  "Always allow `cargo build`" sub-patterns and they're persisted to settings.

## 8. Custom error mapping (acp.rs:1712-1771 + 1852-1864)

`prompt` is the hottest error path. zed:

1. Awaits the RPC.
2. If error code is `AuthRequired` → `Err(anyhow!(acp::Error::auth_required()))` — UI shows
   "Sign in" affordance.
3. If error code is `InternalError` with `.data` that deserializes as `{"details": <str>}` →
   - Magic strings `"This operation was aborted"` / `"The user aborted a request"` are squashed
     into `Ok(PromptResponse::new(StopReason::Cancelled))` when `suppress_abort_err` is set
     (which `cancel` sets — see acp.rs:1773-1779). This is a workaround for the
     gemini-cli race condition.
   - Otherwise, raise `details` as the error message (cleaner than the full error string).
4. Else propagate as-is.

`map_acp_error` (acp.rs:1852-1864) handles the inverse for `new_session`/`load_session`/etc.: if
the agent returned `AuthRequired`, build an `AuthRequired` typed error with the message attached as
`description`. This typed error survives through `anyhow::Error::downcast::<AuthRequired>` in the
UI layer.

**For bodhi-pi**, the actionable bits:
- `RequestError(-32000)` / `AuthRequired` should be raised when the user prompts without a model
  selected (today bodhi-pi returns `-32603` "no model selected"). zed's UI handler keys off the
  typed code, not the message.
- Cancellation should map to `PromptResponse { stopReason: "cancelled" }`, never an error. bodhi-pi
  already does this — good.

## 9. Terminal handling — three layers

ACP exposes terminals two ways. zed supports both:

**Layer A — `terminal/create` (full ACP spec, requires `terminal: true` capability):**
The agent calls `client.createTerminal({ command, args, env, cwd, output_byte_limit })`. zed
spawns a real terminal entity, attaches it to the project, returns a `terminal_id`. The agent
can then `terminal/output`, `terminal/wait_for_exit`, `terminal/kill`, `terminal/release`. The
terminal entity surfaces in zed's UI as an inline live-streaming card under the tool call.

Code: `acp.rs:3609-3780` (request handlers), `acp_thread/src/terminal.rs` (entity).

**Layer B — `terminal_info` / `terminal_output` / `terminal_exit` in ToolCall meta:**
For agents that own their own subprocess (e.g. claude-code-acp's Bash MCP tool), they can attach
synthetic terminal events to ToolCall meta:

```json
{
  "sessionUpdate": "tool_call",
  "title": "Bash: cargo build",
  "kind": "execute",
  "meta": {
    "terminal_info": { "terminal_id": "...", "cwd": "/path" }
  }
}
// then a series of tool_call_update with:
//   meta.terminal_output = { terminal_id, data }
// finally:
//   meta.terminal_exit = { terminal_id, exit_code, signal }
```

zed creates a **display-only** terminal entity (no PTY, just a writeable terminal model)
and pipes the output through it. UI is identical to Layer A.

**Layer C — `tool_call_update.content[].terminal`** (proposed/used by claude-acp):
Embed a `terminal` content block directly. zed renders it as a terminal card. This is what
opencode and claude-code-acp emit for their built-in bash.

**bodhi-pi**: currently has no bash. When `run_script` finishes, it returns text. For the
forthcoming `bash` tool (PARITY.md "deferred"), bodhi-pi should pick Layer A
(real `terminal/create` via host injection) or Layer B (synthesize the meta in core; host owns
the real subprocess). The CLAUDE.md guidance suggests host-injected `Terminal` capability
(orthogonal to ACP) — that's compatible with **Layer B**: core emits `terminal_info` meta and
the host streams `terminal_output` meta on `tool_call_update`.

## 10. Debug logging — `AcpDebugLog` (acp.rs:147-219)

```rust
struct AcpDebugLogState {
    messages: VecDeque<AcpDebugMessage>,             // ring buffer, MAX = 2000
    subscribers: Vec<async_channel::Sender<AcpDebugMessage>>,
}

impl AcpDebugLog {
    fn subscribe(&self) -> (Vec<AcpDebugMessage>, Receiver<AcpDebugMessage>) {
        // hands out the full backlog + a live stream
    }

    fn record_line(&self, direction, line) {
        // inspect-parses JSON-RPC: {id, method, params} → Request/Notification,
        //                          {id, result/error}  → Response,
        //                          (Stderr direction)  → Stderr
        // appends to ring buffer, fans out to subscribers
    }

    fn trailing_stderr(&self) -> Option<String> {
        // grabs the contiguous stderr block at the tail — used when child exits
        // before init, so the user sees "npm error notarget ..." in the error dialog
    }
}
```

The transport is **tapped** at the stream level (acp.rs:763-786): every readable line off stdout
is inspected and recorded before flowing into the JSON-RPC decoder; every writable line is
recorded before flowing to stdin. Stderr is read on its own background task and recorded with
direction `Stderr`.

The `acp_tools` crate (31535 lines) is a developer-facing panel that subscribes to this log and
renders it with filtering (by direction, by method) and pretty JSON.

**Equivalent for bodhi-pi server-side:** wrap the outbound `conn.sessionUpdate(...)` calls and
the inbound request handlers in a `AcpDebugLog`-like ring buffer. Surface via
`_bodhi-pi/debug/subscribe` ext method so test harnesses and the inevitable in-CLI `/debug` slash
can read it back.

## 11. Setting defaults flow (acp.rs:1143-1238)

After `new_session`/`load_session` returns, zed inspects the response's `config_options` (or
`modes`/`models` for old protocol). If the user has a saved `default_mode` / `default_model` /
`default_config_options` for this agent, zed automatically dispatches the corresponding
`set_session_mode` / `set_session_model` / `set_session_config_option` RPCs in the background and
updates the local cache. If the RPC fails, it rolls back the local cache to the initial value
(acp.rs:1208-1228). This is how zed implements "remember the last model I picked for this agent" —
it's purely client-side memory, and the agent doesn't need any per-host concept.

bodhi-pi's reference hosts (bodhi-pi-cli, ws-server, http, web) can adopt the same pattern locally
without any server changes.

## 12. Telemetry (connection.rs:212-220)

An optional trait — agents that want their internal thread state captured for telemetry events
expose `AgentTelemetry::thread_data` returning a serde_json blob. bodhi-pi could ship this as a
zero-cost `_bodhi-pi/session/export`-like surface keyed off existing JSONL exporter.

## 13. What zed expects from every ACP agent (cheat sheet)

| Behaviour | Required? | What zed does if missing |
|---|---|---|
| `initialize` with `protocol_version: 1` | yes | rejects with `UnsupportedVersion` |
| `agent_capabilities` populated | yes | reads `.load_session`, `.session_capabilities.{list,resume,close}`, `.prompt_capabilities.{image,audio,embeddedContext}`, `.mcp_capabilities.{http,sse}` |
| `agent_info: { name, version }` | recommended | telemetry_id falls back to agent_id; version is shown in UI footer |
| Streaming `agent_message_chunk` notifications during prompt | strongly recommended | non-streaming returns work but UX is poor |
| `tool_call` + `tool_call_update` for every tool the model uses | yes | otherwise the tool is invisible to the user |
| `available_commands_update` after session creation | recommended | slash menu is empty |
| `session_info_update` after title changes | recommended | sidebar title stale |
| `config_option_update` after auto-config changes | recommended | model picker stale |
| Spec-compliant `session/load` history replay (notifications BEFORE the response) | yes if `load_session: true` | regression test `test_load_session_replays_notifications_sent_before_response` covers this |
| Typed `AuthRequired` (-32000) when prompt needs auth | yes if any auth required | otherwise zed shows raw error |
| Cancellation returns `StopReason::Cancelled`, not an error | yes | zed has `suppress_abort_err` workaround for gemini-cli that swallows internal error strings |

bodhi-pi today gets the top half right and is missing several items in the bottom half (see
`02-bodhi-pi-vs-zed-comparison.md` for the line-by-line audit).
