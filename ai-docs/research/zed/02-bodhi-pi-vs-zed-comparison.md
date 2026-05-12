# bodhi-pi (server) vs zed (client) — Side-by-Side ACP Audit

**Date:** 2026-05-12
**bodhi-pi version:** `@bodhiapp/bodhi-pi@0.0.1` (src/version.ts) — ACP SDK `^0.21.0`
**zed dep:** `agent-client-protocol = "=0.11.1"` (`unstable` feature)

bodhi-pi is the **agent** (server). zed is the **editor** (client). They share the same
`agent-client-protocol` schema, so the names match — but each side implements the opposing
half. This file walks every ACP surface and notes:

- **✅ Compatible** — bodhi-pi emits what zed expects
- **⚠ Partial** — bodhi-pi emits something, but with reduced fidelity vs claude-code/codex/opencode
- **❌ Missing** — bodhi-pi doesn't implement; zed has a graceful fallback or a degraded UX
- **🛡 Architectural** — deliberate divergence by bodhi-pi's design (see CLAUDE.md "ACP `fs/*`
  methods are deliberately absent")

## 0. Capability negotiation — `initialize`

| Capability                                             | bodhi-pi emits (`agent.ts:399-417`) | zed reads                          | Status                                                                                                                                       |
| ------------------------------------------------------ | ----------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `protocolVersion: 1`                                   | yes                                 | requires `>= V1`                   | ✅                                                                                                                                            |
| `agentInfo.name`, `agentInfo.version`                  | `"bodhi-pi"`, `BODHI_PI_VERSION`    | shown in UI, telemetry_id          | ✅                                                                                                                                            |
| `agentCapabilities.loadSession: true`                  | yes                                 | drives `supports_load_session()`   | ✅                                                                                                                                            |
| `agentCapabilities.sessionCapabilities.list`           | `{}`                                | drives `session_list()`            | ✅                                                                                                                                            |
| `agentCapabilities.sessionCapabilities.close`          | `{}`                                | drives `supports_close_session()`  | ✅                                                                                                                                            |
| `agentCapabilities.sessionCapabilities.resume`         | `{}`                                | drives `supports_resume_session()` | ✅                                                                                                                                            |
| `agentCapabilities.promptCapabilities.image`           | `false`                             | `prompt_capabilities` on AcpThread | ✅ (deferred)                                                                                                                                 |
| `agentCapabilities.promptCapabilities.audio`           | `false`                             | same                               | ✅                                                                                                                                            |
| `agentCapabilities.promptCapabilities.embeddedContext` | `false`                             | same                               | ⚠ — `embeddedContext: true` would let zed include @-mentioned files inline; bodhi-pi could opt in once it tolerates `ContentBlock::Resource` |
| `agentCapabilities.mcpCapabilities.http`               | `false`                             | gates MCP server passing           | ❌ — never accepts MCP servers from clients; means zed-side context-servers aren't pluggable into bodhi-pi                                    |
| `agentCapabilities.mcpCapabilities.sse`                | `false`                             | same                               | ❌                                                                                                                                            |
| `agentCapabilities._meta["bodhi-pi"]`                  | `{ version }`                       | clients can negotiate ext methods  | ✅                                                                                                                                            |
| `authMethods: []`                                      | always empty                        | drives auth UI                     | ⚠ — should advertise *something*, even a single login method, when `getApiKey === undefined && kvStore === undefined`. See §5.               |

**Verdict:** bodhi-pi's `initialize` is structurally correct. The two real gaps are MCP capability
advertisement and auth methods.

## 1. Session lifecycle

### 1.1 `session/new` — `NewSessionRequest → NewSessionResponse`

| Field                              | bodhi-pi (`agent.ts:423-438`)                    | zed expects                                                              | Status                                  |
| ---------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------ | --------------------------------------- |
| `request.cwd`                      | used as-is                                       | provides `work_dirs.ordered_paths().next()`                              | ✅                                       |
| `request.mcpServers`               | **ignored**                                      | zed sends `mcp_servers_for_project(project, cx)` from `acp.rs:3095-3140` | ❌ — see §4                              |
| `response.sessionId`               | from `SessionStore.create()`                     | required                                                                 | ✅                                       |
| `response.modes` / `currentMode`   | not set                                          | wrapped if present, else falls back to `config_options`                  | ✅ (intentional — `config_options` path) |
| `response.models` / `currentModel` | not set                                          | same                                                                     | ✅ (intentional)                         |
| `response.config_options`          | `[Model, Thinking?]` via `buildAllConfigOptions` | wrapped as `AcpSessionConfigOptions`                                     | ✅                                       |

### 1.2 `session/load` — `LoadSessionRequest → LoadSessionResponse`

| Aspect                                                                                                      | bodhi-pi (`agent.ts:440-518`)                                                                              | zed expects                                           | Status                                                                        |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------- |
| History replay BEFORE response                                                                              | yes — `conn.sessionUpdate(...)` for every replayed entry, then `return { configOptions }`                  | required by spec; tested in `acp.rs:2826-2888`        | ✅                                                                             |
| User message replay → `user_message_chunk`                                                                  | yes                                                                                                        | same                                                  | ✅                                                                             |
| Assistant message replay → `agent_message_chunk`                                                            | yes                                                                                                        | same                                                  | ✅                                                                             |
| Assistant tool calls replay → `tool_call` (status `completed`) + `tool_call_update` (status from `isError`) | yes (`agent.ts:480-505`)                                                                                   | upserts in-place, `resolve_locations` fires           | ✅                                                                             |
| Agent **thoughts** replay → `agent_thought_chunk`                                                           | ❌ no thought blocks in extractText                                                                         | bodhi-pi doesn't model reasoning content at all today | ⚠ — Anthropic / reasoning models will lose thinking tokens on reload          |
| Available-commands replay → `available_commands_update`                                                     | yes via `advertiseSlashable`                                                                               | shown in slash menu                                   | ✅                                                                             |
| Title replay → `session_info_update` with `title`                                                           | ❌ — title-from-`session_info` is replayed only if pulled via `_bodhi-pi/session/stats`, never auto-emitted | shown in sidebar                                      | ⚠ — bodhi-pi has `session_info` entries with `name`; should auto-emit on load |
| `request.mcpServers`                                                                                        | ignored                                                                                                    | should be re-applied to the session                   | ❌                                                                             |

### 1.3 `session/resume` — `ResumeSessionRequest → ResumeSessionResponse`

bodhi-pi's `resumeSession` (`agent.ts:520-534`) rehydrates without replaying history. Zed treats
resume identically to load for the per-session state but expects no notifications during the call
— bodhi-pi complies. ✅

### 1.4 `session/list` — `ListSessionsRequest → ListSessionsResponse`

bodhi-pi (`agent.ts:536-549`) wraps `SessionStore.list({cwd, cursor})` and emits `{sessions[],
nextCursor?}` with ISO-timestamped `updatedAt`. ✅

**Watch surface:** zed exposes `AgentSessionList::watch` returning a
`Receiver<SessionListUpdate>` with two variants: `Refresh` (full reload) and `SessionInfo
{ session_id, update }` (one row patched). bodhi-pi has no inbound channel to push refresh hints
— clients have to poll. ⚠

### 1.5 `session/close`

bodhi-pi (`agent.ts:551-558`) drops the in-memory state and emits `session_shutdown`. **No
ref-counting.** ⚠ — single-host today, but `bodhi-pi-ws-server` / `bodhi-pi-http` are
multi-tenant; a second tab on the same session ID will silently steal state from the first. See
implementation.md §P0-2.

### 1.6 `session/cancel`

bodhi-pi (`agent.ts:1647-1652`) sets `cancelled = true` and calls `piAgent.abort()`. The current
prompt resolves with `stopReason: "cancelled"`. ✅

### 1.7 `session/prompt`

The hot path. Maps cleanly to zed's expectations:

| Step                                                                     | bodhi-pi                                                                                            | zed expects                                                                                             | Status                                                                                                                                             |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Optimistic user-message echo                                             | ❌ does NOT re-emit the prompt as `user_message_chunk`                                               | zed dedups via `already_in_user_message` check; bodhi-pi could optionally emit, but no harm in skipping | ✅                                                                                                                                                  |
| Assistant text streaming → `agent_message_chunk`                         | yes (`agent.ts:1554-1562`)                                                                          | streamed reveal                                                                                         | ✅                                                                                                                                                  |
| Tool execution start → `tool_call(status: in_progress)`                  | yes (`agent.ts:1572-1583`)                                                                          | upsert                                                                                                  | ✅                                                                                                                                                  |
| Tool execution update → `tool_call_update(status: in_progress, content)` | yes (`agent.ts:1593-1602`)                                                                          | upsert                                                                                                  | ✅                                                                                                                                                  |
| Tool execution end → `tool_call_update(status: completed                 | failed, content)`                                                                                   | yes (`agent.ts:1614-1623`)                                                                              | upsert                                                                                                                                             | ✅ |
| Reasoning/thinking chunks → `agent_thought_chunk`                        | ❌ — pi-agent-core surfaces them via `assistantMessageEvent` but bodhi-pi only forwards `text_delta` | shown as folded `<thinking>` block                                                                      | ⚠ — see §3.1                                                                                                                                       |
| Plan updates → `Plan`                                                    | ❌ — not emitted                                                                                     | shown as a TODO card                                                                                    | ❌ — not on roadmap; both claude-code and codex emit this for `TodoWrite`                                                                           |
| `PromptResponse.stopReason`                                              | maps via `mapStopReason` ("stop"→"end_turn", "length"→"max_tokens", "aborted"→"cancelled")          | mapped 1:1 to `acp::StopReason`                                                                         | ✅                                                                                                                                                  |
| `PromptResponse.userMessageId`                                           | passes through `params.messageId ?? null`                                                           | tracked for `truncate` capability                                                                       | ✅                                                                                                                                                  |
| Error path on overflow                                                   | retries once with auto-compact, otherwise `RequestError(-32603)`                                    | `prompt()` propagates as-is                                                                             | ⚠ — overflow is currently a `-32603` (internal). Most agents map this to an `AuthRequired`-style typed error or surface via `usage_update` instead |

## 2. Outbound ACP requests (agent → client)

This is the **largest single delta** between bodhi-pi and every other ACP agent. bodhi-pi makes
**zero** outbound requests. Other agents use these heavily.

| Outbound request             | bodhi-pi emits? | What zed does on receive                                                                   | Why others emit                                                                                                                                          |
| ---------------------------- | --------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fs/read_text_file`          | ❌ 🛡 deliberate  | `handle_read_text_file` reads from project buffers (unsaved-state aware)                   | claude-code-acp's edit tool calls `client.readTextFile()` first so a "deleted on disk but modified in buffer" file still gives the agent the user's view |
| `fs/write_text_file`         | ❌ 🛡 deliberate  | `handle_write_text_file` writes through project buffers, runs format-on-save, triggers LSP | claude-code-acp's edit tool calls `client.writeTextFile()` so the diff renders against the user's unsaved buffer and the edit lands in the live editor   |
| `terminal/create`            | ❌ (no bash yet) | spawns terminal entity                                                                     | claude-code-acp's Bash tool uses this for foreground commands                                                                                            |
| `terminal/output`            | ❌               | returns current content + exit status                                                      | for status polls inside Bash tool                                                                                                                        |
| `terminal/wait_for_exit`     | ❌               | awaits exit task                                                                           | for blocking Bash calls                                                                                                                                  |
| `terminal/kill`              | ❌               | kills the inner shell                                                                      | for cancellation                                                                                                                                         |
| `terminal/release`           | ❌               | drops the terminal entity                                                                  | for cleanup                                                                                                                                              |
| `session/request_permission` | ❌               | `handle_request_permission` → `request_tool_call_authorization` → UI prompt                | claude-code, codex, opencode ALL use this before destructive tool runs                                                                                   |

The 🛡 `fs/*` items are bodhi-pi's deliberate architectural choice (CLAUDE.md: "ACP `fs/*` methods
are deliberately absent — orthogonal to our host-injected `Filesystem`"). The trade-off is real:
in browser hosts where the host owns FSA access anyway, the `Filesystem` injection is the
right primitive; but **zed users editing in zed will not see unsaved-buffer awareness from
bodhi-pi** the way they do from claude-code-acp. This is fine as long as the docs are
explicit about it. See implementation.md §P1-3 for an opt-in mode.

The `request_permission` gap is **not** architectural — it's missing. bodhi-pi runs every tool
the model requests without confirmation. See implementation.md §P0-1.

## 3. SessionUpdate notification fidelity

### 3.1 `agent_thought_chunk` (reasoning/thinking)

zed's `handle_session_update` (acp_thread.rs:1473-1475) maps thought chunks to a separate
`AssistantMessageChunk::Thought` variant rendered as a folded `<thinking>` block. claude-code-acp
emits these from SDK `thinking` blocks; codex-acp emits from `ReasoningContentDeltaEvent`.

bodhi-pi today only emits `agent_message_chunk` (no thought chunks). pi-agent-core surfaces
reasoning via `assistantMessageEvent.type === "reasoning_delta"` but bodhi-pi's `message_update`
case only handles `text_delta`. Result: when the user picks a reasoning model (o1, claude with
thinking enabled, qwen3, deepseek-r1, ...), the thinking content is dropped in zed.

**Fix:** add a `case "reasoning_delta"` branch in `subscribeToAgent` and emit
`agent_thought_chunk`.

### 3.2 `tool_call` title field

bodhi-pi's title (`agent.ts:1577`):
```ts
`${event.toolName} ${formatLocationHint(event.args)}`.trim()
```
`formatLocationHint` (`notifications.ts:69-73`) returns `args.path` if it's a string, else `""`.

claude-code-acp renders titles like `Read README.md`, `Edit (3 hunks)`, `Bash: cargo build`.
codex-acp parses ExecCommandBeginEvent into a `parse_command_tool_call` with kind detection
(`Read`/`Edit`/`Search`/`Execute`) and a friendly title. opencode uses tool-specific titles.

bodhi-pi could lift fidelity cheaply by special-casing the seven built-in tools:
- `read` → `Read <path>` (with `[<offset>:<offset+limit>]` if `limit`)
- `write` → `Write <path>`
- `edit` → `Edit <path>` (and include the diff snippet via `replaceAll` / `oldText` length in the body)
- `ls` → `List <path>`
- `find` → `Find <pattern> in <path>`
- `grep` → `Grep "<pattern>" in <path>`
- `run_script` → `Run <path> ${args.join(" ")}`

### 3.3 `tool_call.kind` mapping

bodhi-pi (`tools/index.ts:58-74`):
```ts
read       → "read"
write      → "edit"
edit       → "edit"
ls         → "search"
find       → "search"
grep       → "search"
run_script → "execute"
default    → "other"
```

This is correct. ✅

### 3.4 `tool_call.locations` (NOT currently emitted)

zed's `resolve_locations` (acp_thread.rs:2038-2094) auto-scrolls the editor to the last
`location` in the array after every upsert. bodhi-pi's built-in tools all know which path they
touched — `read`/`edit`/`write` have `path` as their first arg, `grep` knows which file
matched, etc. Emitting `locations: [{ path, line? }]` would land **immediate IDE
auto-navigation in zed** for free.

Wire-shape:
```json
{
  "sessionUpdate": "tool_call",
  "toolCallId": "...",
  "title": "Read src/foo.ts",
  "kind": "read",
  "status": "in_progress",
  "locations": [{ "path": "/abs/path/to/src/foo.ts" }],
  "rawInput": { ... }
}
```

For `edit`, ideally emit `line` too — the line where `oldText` starts in `newText`. The
mid-flight `tool_call_update` can update the line as edits stream.

### 3.5 `tool_call_update.content` shape

bodhi-pi (`notifications.ts:60-67`) emits content as:
```json
[{ "type": "content", "content": { "type": "text", "text": "..." } }]
```

This is the **plain text content variant**. zed accepts it. But there are two richer variants:
- `{ "type": "diff", "diff": { "path", "oldText", "newText" } }` — for edit/write, zed renders
  a multi-buffer diff inline (see `acp_thread/src/diff.rs` — `Diff::finalized` / `Diff::Pending`)
- `{ "type": "terminal", "terminalId": "..." }` — for bash, zed embeds the terminal output card

claude-code-acp emits diff content for its Edit tool. codex-acp emits diff for patch_apply.
opencode emits diff for its edit tool.

**For bodhi-pi:** the `edit` tool already knows `oldText` and `newText`. Emitting a diff content
block instead of plain text would render the change as a colored diff in zed's tool card. Same
for `write` (oldText = previous file content, or `null` for new files).

### 3.6 `tool_call_update` payload size

bodhi-pi's `agentToolContentForAcp` builds a fresh string from the entire partial-result content
array on every `tool_execution_update`. For a `grep` with 5000 matches, that's 5000 progressive
snapshots growing from 1 line to 5000 lines — O(n²) wire bytes. claude-code-acp / codex-acp
emit **delta-only** content (just the new bytes since the previous update). zed's
`update_tool_call` (acp_thread.rs:1880+) supports both — but if you emit content, it's a full
replacement.

**Fix:** add a `mode: "append" | "replace"` hint in meta, or just emit smaller bounded
windows. For now this is a perf rather than correctness issue.

### 3.7 `available_commands_update`

bodhi-pi (`agent.ts:2037-2050`) emits this once per `newSession`/`loadSession`/`resumeSession`
via `advertiseSlashable`. ✅

**Missing:** mid-session refresh. When `_bodhi-pi/session/settings/set defaultModel ... --project`
mutates settings, or when an extension is added at runtime, the slash menu stays stale until
the next session reload. claude-code-acp re-emits `available_commands_update` whenever the
slash registry changes. The event bus is already present (`auth_change`, `settings_change`,
`model_select` → `config_option_update`). Wire `commands_change` similarly.

### 3.8 `session_info_update`

bodhi-pi emits this from `handleSessionSetName` (`agent.ts:892-912`). ✅

But it's never emitted from `loadSession` even when the session has a name. zed's
`AcpSessionList` would happily render the title in the sidebar if the load response carried it,
or if a `session_info_update` arrived during replay. Today both pathways are missing.

### 3.9 `current_mode_update`

bodhi-pi does **not** advertise `modes` (it uses `config_options` instead). N/A.

### 3.10 `config_option_update`

bodhi-pi (`agent.ts:339-346`) emits this on `auth_change`, `settings_change` (filtered by
`affectsPickerKey`), `model_select`. ✅ Tight and idiomatic.

### 3.11 `usage_update` (beta)

bodhi-pi never emits this. zed gates the feature on `AcpBetaFeatureFlag` and tracks usage when
present:
```json
{
  "sessionUpdate": "usage_update",
  "used": 18432,
  "size": 200000,
  "cost": { "amount": 0.0142, "currency": "USD" }
}
```

pi-agent-core surfaces `Usage` on every assistant message; bodhi-pi could emit a `usage_update`
after each `message_end` for free.

### 3.12 `plan` (TODO lists)

claude-code-acp converts the `TodoWrite` tool into a `Plan` notification. codex-acp does similar
for its planning surface. bodhi-pi doesn't have a planning tool. Defer.

## 4. MCP server passthrough

zed (`acp.rs:3095-3140`) collects every configured MCP server from the project's
`ContextServerStore` and includes them in `NewSessionRequest.mcpServers` and
`LoadSessionRequest.mcpServers`. The agent is expected to **boot the MCP servers itself** during
session creation and expose their tools to the model.

bodhi-pi (`agent.ts:425, 442`) **silently ignores** `params.mcpServers`. Its `mcpCapabilities`
advertises `{ http: false, sse: false }`, so zed (correctly) doesn't try to pass HTTP servers.
But zed will still pass stdio MCP servers (the default ACP behaviour) and bodhi-pi will discard
them.

For bodhi-pi, MCP support is non-trivial — its extension system (`src/extensions/`) is the
analog. But there is a **bridge** opportunity: when `params.mcpServers` arrives, bodhi-pi could
spawn each one as an extension-like runner and merge their tools. This is significant work — see
implementation.md §P2-5.

## 5. Auth methods

bodhi-pi returns `authMethods: []` from `initialize`. The host can't surface a login button. The
agent's `authenticate()` method (`agent.ts:419-421`) returns `{}` — a no-op success.

**Today, bodhi-pi's auth flow is:** the user types `/login <provider> <api-key>` and bodhi-pi
writes to `KvStore` (Phase I/J). This is a slash command; zed can't see it.

Compare to claude-code-acp:
- `initialize` advertises one auth method: `"claude-login"` with description "Log in with Claude
  Code".
- If `client.capabilities.terminal-auth: true`, the method has meta `{ command, args, env }`
  → zed renders a `Sign in` button that spawns `claude login` in a new terminal.
- `authenticate()` itself is unimplemented (the terminal flow does the work).
- On every operation, if there's no `.claude.json`, raise `RequestError.authRequired()` — zed
  catches the typed code and re-prompts.

bodhi-pi has a generic version of this: it has multiple providers. The auth flow could be:
- Advertise one auth method per known provider with no auth yet (`authMethods: [{ id:
  "openai-login", name: "Log in to OpenAI", description, kind: "EnvVar" }, ...]`).
- `authenticate({ method })` extracts the provider, opens a host-specific picker (terminal? env
  var prompt? OAuth web flow?). Today bodhi-pi has no host hook for this — `authenticate`
  needs to fan out to a new `AuthRunner` injected via config.
- `prompt()` raises `RequestError(-32000, "Auth required for ${provider}")` when the selected
  model's provider has no key. zed currently sees `-32603` and shows a raw error.

This is significant work, but the **zero-cost first step** is just:
1. Emit one synthetic `authMethods: [{ id: "bodhi-pi-login", ... }]` when no auth is configured.
2. Make `prompt()` raise `RequestError(-32000, ...)` instead of `-32603` when
   `currentModelId === null`.

That alone makes zed's UI render a "Sign in" button and a typed error. See implementation.md §P1-4.

## 6. Error code shapes

`@agentclientprotocol/sdk`'s `RequestError` constructor takes a JSON-RPC code. The well-known
codes:

| Code   | Name                  | bodhi-pi uses for                                                             | zed/spec reads as                                            |
| ------ | --------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------ |
| -32600 | Invalid Request       | —                                                                             | invalid params                                               |
| -32601 | Method Not Found      | unknown ext methods (`agent.ts:562`)                                          | unsupported method                                           |
| -32602 | Invalid Params        | param validation everywhere                                                   | param shape problem                                          |
| -32603 | Internal Error        | session-not-loaded, store can't fork, compact failures, **no model selected** | runtime failure; if `.data` is `{details}` zed extracts      |
| -32000 | (custom) AuthRequired | NEVER USED                                                                    | typed `AuthRequired` (matched on `err.code == AuthRequired`) |

Today bodhi-pi conflates "no model selected" / "no auth" / "store doesn't support feature" all
into `-32603`. zed handles `-32603` generically (raw error string) but special-cases
`-32000 AuthRequired` into the "sign in" UI. **Split these in bodhi-pi's error path.**

## 7. Concurrency / state-machine gotchas

| Pattern                                         | bodhi-pi                                                                                              | zed                                     | Notes                                                                                                                                       |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Multiple concurrent prompts to the same session | rejects with `-32603` if `cancelled` is reset mid-loop (race)                                         | issues sequentially via single-flight   | bodhi-pi assumes one prompt at a time. The `agent.ts:1352` `cancelled = false` reset on every prompt entry assumes serial entry. Test gap.  |
| Tool execution during cancel                    | `piAgent.abort()` propagates to tool's `signal`?                                                      | n/a (server-side concern)               | bodhi-pi's built-in tools don't yet propagate abort to `node:fs` or `picomatch` walks. If a `find` is mid-walk, abort lets it keep running. |
| Session close during prompt                     | `closeSession` drops state immediately, the in-flight prompt's `appendEntry` to dead store will throw | reject the close until prompt resolves? | bodhi-pi should ref-count, but at minimum it should reject `closeSession` while a prompt is active or stall on `waitForIdle`.               |
| Session reload during prompt                    | not gated                                                                                             | rejected                                | same as above.                                                                                                                              |

## 8. The five reference hosts vs zed

bodhi-pi's five host packages (cli, web, ws-server/ws-frontend, http, chrome-ext) each terminate
ACP at a different transport boundary:

| Host                                          | Transport                            | ACP visible to        | zed-compatible?                                                               |
| --------------------------------------------- | ------------------------------------ | --------------------- | ----------------------------------------------------------------------------- |
| `bodhi-pi-cli`                                | stdio (REPL UI on top)               | nothing — embedded    | n/a                                                                           |
| `bodhi-pi-web`                                | in-process MessagePort to Web Worker | the worker            | n/a                                                                           |
| `bodhi-pi-ws-server` + `bodhi-pi-ws-frontend` | WebSocket frames carrying ACP JSON   | the frontend (custom) | partial — zed could in theory talk to it via `ws://` but no spec for that yet |
| `bodhi-pi-http`                               | MCP-Streamable-HTTP                  | external clients      | partial — same as ws                                                          |
| `bodhi-pi-chrome-ext`                         | message-passing                      | the extension popup   | n/a                                                                           |

To make bodhi-pi **usable as a zed external agent**, the missing piece is a thin
`bodhi-pi-acp-stdio` bin in `bodhi-pi-cli` (or a new package) that:
- exposes a `bin/bodhi-pi-acp` entry point
- inside, wires `AgentSideConnection` over `process.stdin` / `process.stdout`
- registers itself in zed via `~/.config/zed/settings.json` under `agent_servers`

This is **5-10 lines** of new code given the existing `AgentSideConnection` plumbing. See
implementation.md §P0-3.

## 9. Summary scorecard

| Area                                                                       | Score              | What zed users get today                                                                     |
| -------------------------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------- |
| `initialize` capability advertisement                                      | 9/10               | Full session list / load / close / config_options. Missing: meaningful auth methods.         |
| `session/new`, `/load`, `/resume`, `/list`, `/close`, `/cancel`, `/prompt` | 8/10               | All present and spec-compliant. Missing: ref-counting on close, MCP passthrough.             |
| Streaming notifications                                                    | 7/10               | Text + tool calls stream cleanly. Missing: thought chunks, plan, usage_update, diff content. |
| `request_permission` flow                                                  | 0/10               | bodhi-pi runs every tool unconditionally. No tool approval UI.                               |
| `fs/*` / `terminal/*` outbound                                             | 0/10 (intentional) | No unsaved-buffer awareness; no live terminal cards. Documented as architectural choice.     |
| Auth error typing                                                          | 3/10               | `prompt()` raises `-32603` instead of `-32000 AuthRequired` when no model.                   |
| Tool-call ergonomics (titles, locations, diffs)                            | 4/10               | Plain titles, no locations, text-only content blocks.                                        |
| Concurrency safety                                                         | 5/10               | Cancel works, close-during-prompt is racy, no ref counting.                                  |
| Debug/observability                                                        | 2/10               | No JSON-RPC tap, no debug log, no replay surface.                                            |
| stdio bin entrypoint                                                       | 0/10               | Not packaged for direct zed consumption.                                                     |

Items at 4 or below are addressed in `implementation.md`. Items at 5-7 have lower-priority
follow-ups. Items at 8+ are good for now.
