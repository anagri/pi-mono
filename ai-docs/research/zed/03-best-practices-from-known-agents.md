# Best Practices from Known ACP Agents

**Date:** 2026-05-12
**Reference implementations surveyed:**

| Agent                                                    | Language   | Repo                                         | Wraps                            | Lines                                        |
| -------------------------------------------------------- | ---------- | -------------------------------------------- | -------------------------------- | -------------------------------------------- |
| claude-code-acp                                          | TypeScript | `zed-industries/claude-code-acp`             | `@anthropic-ai/claude-agent-sdk` | ~2k                                          |
| codex-acp                                                | Rust       | `zed-industries/codex-acp`                   | `codex-core`                     | ~5k                                          |
| opencode                                                 | TypeScript | `sst/opencode` (`packages/opencode/src/acp`) | opencode's own SDK               | ~1.5k                                        |
| zed (the client side, but its expectations leak through) | Rust       | `zed-industries/zed`                         | n/a — it's the consumer          | ~10k across acp_thread/acp_servers/acp_tools |

This document distills the **production patterns** common to all three. Each pattern is keyed
back to its source so future maintainers of bodhi-pi can crib the design quickly.

## 1. Two-tier event translation

All three reference agents share the same architectural split:

```
┌────────────────────────────────────────────────────────────────────┐
│                     SDK / Core (Claude, codex-core, opencode SDK)  │
│  – emits internal, vendor-specific events                          │
│  – e.g. stream_event{partial_assistant_message}, ExecCommandBegin  │
└────────────────────────────────────────────────────────────────────┘
                              ↓
        ┌────────────────────────────────────────────────┐
        │   Translation layer (claude-code-acp,          │
        │   codex-acp's PromptState, opencode's          │
        │   message.part.updated handler)                │
        │   – pattern-matches each event variant         │
        │   – emits zero or more spec-stable             │
        │     SessionUpdate notifications                │
        └────────────────────────────────────────────────┘
                              ↓
        ┌────────────────────────────────────────────────┐
        │    AgentSideConnection.sessionUpdate(...)      │
        │    – the spec boundary, stable                 │
        └────────────────────────────────────────────────┘
```

**Why two tiers:** the SDK events are not version-stable across SDK upgrades; the ACP layer is.
By having a translation layer (not a direct wire-up), the SDK can change without breaking ACP
clients.

bodhi-pi has the equivalent (`subscribeToAgent` in `agent.ts:1535-1645` reading pi-agent-core
events) — just incomplete. See gaps in `02-bodhi-pi-vs-zed-comparison.md` §3.

## 2. Tool-call construction templates

All three reference agents have a **per-tool builder** that constructs the `ToolCall` /
`ToolCallUpdate` payload from the tool's input args. Excerpting:

### claude-code-acp — `toolInfoFromToolUse()` per tool

```ts
// pseudo-code lifted from the deepwiki summary
function toolInfoFromToolUse(toolUse, agent): ToolCallFields {
  switch (toolUse.name) {
    case "Read":
    case "mcp__acp__Read":
      return {
        kind: "read",
        title: input.lines
          ? `Read ${input.file_path} (${input.lines})`
          : `Read File`,
        locations: [{ path: input.file_path, line: input.offset }],
        content: [],
      };
    case "Edit":
    case "mcp__acp__Edit":
      return {
        kind: "edit",
        title: `Edit \`${input.file_path}\``,
        content: [{ type: "diff", path: input.file_path,
                    oldText: input.old_string, newText: input.new_string }],
        locations: [{ path: input.file_path }],
      };
    case "Bash":
    case "mcp__acp__Bash":
      return {
        kind: "execute",
        title: `\`${input.command}\``,
        content: [{ type: "text", text: input.description ?? input.command }],
        locations: [],
      };
    case "TodoWrite":
      // SPECIAL: returns Plan notification, not tool_call
      return null;
  }
}
```

### codex-acp — `parse_command_tool_call()` / `extract_tool_call_content_from_changes()`

For exec commands, codex-acp parses the command string to detect intent:

```rust
// pseudo-Rust from the deepwiki summary
fn parse_command_tool_call(command: &str) -> ToolCallFields {
  let argv = shlex::split(command);
  match argv.as_slice() {
    ["cat", path, ..]       => { kind: Read,    title: format!("Read {path}"),    locations: vec![path] }
    ["sed", "-i", _, path]  => { kind: Edit,    title: format!("Edit {path}"),    locations: vec![path] }
    ["rg", pattern, path?]  => { kind: Search,  title: format!("Search {pattern}"), locations: ... }
    ["grep", pattern, ..]   => { kind: Search,  title: format!("Search {pattern}"), ... }
    _                        => { kind: Execute, title: format!("`{command}`"),    locations: vec![] }
  }
}
```

For patches:
```rust
fn extract_tool_call_content_from_changes(changes) -> (Vec<Location>, Vec<ToolCallContent>) {
  // For each Patch::Create/Update/Delete:
  //   - location.path = file
  //   - content.push(ToolCallContent::Diff { path, old_text, new_text })
  //   - if Create: old_text = None; if Delete: new_text = None
}
```

### opencode — `toToolKind()` + `toLocations()` + per-state content

opencode does it slightly differently — the tool's name maps to `kind` via `toToolKind`, then
the content is dispatched per **tool state** (`running` / `completed` / `error`):

```ts
case "tool":
  const kind = toToolKind(part.tool);
  const locations = toLocations(part.tool, part.state.input);
  if (part.state.status === "running") {
    if (part.tool === "bash") emit_content = [{ type: "text", text: output }];
  } else if (part.state.status === "completed") {
    if (part.tool === "edit") emit_content = [{ type: "diff", filePath, oldText, newText }];
    else if (part.tool === "todowrite") emit_plan = parseTodos(output);
    else emit_content = [{ type: "text", text: output }];
  } else if (part.state.status === "error") {
    emit_content = [{ type: "text", text: errorMessage }];
  }
```

### Recommendation for bodhi-pi

Adopt the claude-code-acp / opencode pattern: a single function
`buildToolCallFields(toolName, args, state) → { title, kind, locations, content }` that owns
all per-tool customization. Move the existing `toolKindFor` and `formatLocationHint` into it.
This keeps `agent.ts` thin and `tools/index.ts` becomes the single source of truth for tool UX.

```ts
// pseudo-code suggested for packages/bodhi-pi/src/tools/index.ts
export function toolCallFieldsFor(
  toolName: string,
  rawInput: unknown,
  state?: ToolCallState,
): Pick<acp.ToolCall, "kind" | "title" | "locations"> & { content?: acp.ToolCallContent[] } {
  switch (toolName) {
    case "read":   return readFields(rawInput);
    case "write":  return writeFields(rawInput, state);
    case "edit":   return editFields(rawInput, state);
    case "ls":     return lsFields(rawInput);
    case "find":   return findFields(rawInput);
    case "grep":   return grepFields(rawInput);
    case "run_script": return runScriptFields(rawInput);
    default:       return { kind: "other", title: toolName, locations: [] };
  }
}
```

## 3. Permission gating (`session/request_permission`)

The hottest cross-agent pattern. All three implement it differently but converge on a
**`canUseTool` / approval-event seam** that fires before destructive tool execution:

### claude-code-acp: `canUseTool` callback in SDK

```ts
// passed into Claude SDK
canUseTool: async (toolUse) => {
  if (toolUse.name === "ExitPlanMode" || /* destructive ops */) {
    const response = await this.client.requestPermission({
      sessionId,
      toolCall: { toolCallId, rawInput, title: toolInfoFromToolUse(toolUse) },
      options: [
        { kind: "allow_always", name: "Allow Always" },
        { kind: "allow_once",   name: "Allow" },
        { kind: "reject_once",  name: "Deny" },
      ],
    });
    if (response.outcome.kind === "selected") {
      const chosen = response.outcome.optionId;
      if (chosen === "allow_always") {
        session.permissionMode.set(toolUse.name, "allow");
      }
      return { behavior: chosen.startsWith("allow") ? "allow" : "deny" };
    }
    return { behavior: "deny" };
  }
  return { behavior: "allow" };
}
```

### codex-acp: ApprovalRequestEvent → request_permission

codex-core fires `ExecApprovalRequestEvent` / `ApplyPatchApprovalRequestEvent` whenever its
internal approval policy says "ask the user". The bridge handler maps these to ACP:

```rust
fn exec_approval(&mut self, event: ExecApprovalRequestEvent) {
  let tool_update = ToolCallUpdate {
    tool_call_id: event.call_id.into(),
    fields: ToolCallUpdateFields {
      status: Some(ToolCallStatus::Pending),
      kind:   Some(ToolKind::Execute),
      title:  Some(parse_command_tool_call(&event.command).title),
      locations: ...,
      content: ...,
    },
  };
  let outcome = self.client.request_permission(RequestPermissionRequest {
    session_id, tool_call: tool_update,
    options: vec![
      PermissionOption { id: "yes",        name: "Yes",        kind: AllowOnce },
      PermissionOption { id: "always",     name: "Always",     kind: AllowAlways },
      PermissionOption { id: "no_feedback", name: "No, provide feedback", kind: RejectOnce },
    ],
  }).await?;
  let decision = match outcome {
    Selected("yes")        => ReviewDecision::Approved,
    Selected("always")     => ReviewDecision::ApprovedForSession,
    Selected(_)|Cancelled  => ReviewDecision::Abort,
  };
  self.thread.submit(Op::ExecApproval { call_id, decision }).await;
}
```

### opencode: `permission.asked` event subscription

opencode's SDK fires `permission.asked` events for everything that needs approval. The ACP
bridge subscribes once and re-broadcasts as `requestPermission`:

```ts
this.sdk.permission.on("asked", async (req) => {
  const outcome = await this.connection.client.requestPermission({
    sessionId, toolCall: buildToolCall(req), options: [...]
  });
  await this.sdk.permission.reply(req.id, mapOutcome(outcome));
});
```

### Common shape — the `PermissionOption` set

All three converge on roughly:

```
options:
  - { id: "allow_once",   name: "Allow",        kind: "allow_once"  }
  - { id: "allow_always", name: "Always",       kind: "allow_always"}
  - { id: "reject_once",  name: "Deny",         kind: "reject_once" }
```

zed's `PermissionOptions::Flat` (`connection.rs:474-624`) accepts this shape. zed also supports
`Dropdown` and `DropdownWithPatterns` for richer UIs but most agents stick with Flat.

### Recommendation for bodhi-pi

Implement a `PermissionGate` injection (parallel to `Filesystem`, `Persistence`, `KvStore`)
that the ACP layer calls into before invoking destructive tools. The default no-op host (web,
test) returns "allow" so behaviour is unchanged. The new opt-in hosts (cli, ws-server, http)
plumb it to `client.requestPermission`.

```ts
// suggested signature
export interface PermissionGate {
  requestApproval(args: {
    sessionId: string;
    toolName: string;
    rawInput: unknown;
    toolCallId: string;
  }): Promise<"allow_once" | "allow_always" | "reject">;
}
```

The ACP host implementation:
```ts
{
  async requestApproval({ sessionId, toolName, rawInput, toolCallId }) {
    const fields = toolCallFieldsFor(toolName, rawInput);
    const resp = await connection.requestPermission({
      sessionId,
      toolCall: { toolCallId, rawInput, ...fields },
      options: [
        { id: "allow_once",   name: "Allow",  kind: "allow_once"   },
        { id: "allow_always", name: "Always", kind: "allow_always" },
        { id: "reject_once",  name: "Deny",   kind: "reject_once"  },
      ],
    });
    if (resp.outcome.kind !== "selected") return "reject";
    return resp.outcome.optionId as any;
  }
}
```

Gate this per-tool by `Tool.destructive: boolean` annotated in the tool registry.

## 4. Diff content for edits

All three reference agents emit **diff-shaped** content for edit/write tool calls:

```json
{
  "type": "diff",
  "path": "/abs/path/file.ts",
  "oldText": "...",
  "newText": "..."
}
```

zed's `acp_thread/src/diff.rs:Diff::Pending → Diff::Finalized` state machine renders this as a
multi-buffer diff inline in the tool card.

bodhi-pi's `edit` tool already has `oldText` and `newText`; `write` has `newText` and can
read `oldText` from `Filesystem` before write. Two-line change to `notifications.ts` and
`agent.ts`. See implementation.md §P1-1.

## 5. Filesystem proxying via `client.fs.*`

claude-code-acp's MCP server's `Read` tool calls `agent.client.readTextFile()`. The agent
forwards to `client.readTextFile()`, which zed implements (`acp.rs:3232-3281`,
`handle_read_text_file`) by routing through the **project buffer system** — so unsaved edits
are visible.

codex-acp's `AcpFs::read_to_string()` does the same: checks
`client_capabilities.read_text_file`, if yes calls `client.read_text_file`, else falls back to
local stdlib `fs::read_to_string`.

opencode uses `connection.client.fs.readTextFile` / `writeTextFile` for permission-related file
ops.

**bodhi-pi's stance** (CLAUDE.md): `fs/*` outbound is deliberately absent. The host injects
`Filesystem`. The trade-off: in zed, edit previews don't honour unsaved buffer state.

For bodhi-pi-cli running as a zed external agent, this is awkward. The user opens a file in
zed, makes unsaved changes, asks bodhi-pi to edit — bodhi-pi reads the on-disk version (not the
buffer version), edits, writes back, and clobbers the user's unsaved changes.

**Recommendation:** add an opt-in `useAcpFs` flag in the agent config. When true, the
host-injected `Filesystem` is **replaced** by a proxy that forwards to `client.readTextFile` /
`client.writeTextFile`. Defaults to off (preserves the current behavior in web/cli/ws hosts).
zed-specific stdio host turns it on. See implementation.md §P1-3.

## 6. Authentication patterns

### Common pattern: advertise → terminal-spawn → re-prompt

All three agents follow the same flow:

1. **`initialize` advertises one or more `authMethods`**:
   ```json
   {
     "id": "claude-login",
     "name": "Log in with Claude Code",
     "description": "Run `claude login` in the terminal",
     "kind": "EnvVar",      // or "OAuth", "ApiKey"
     "_meta": { "terminal-auth": { "command": "claude", "args": ["login"] } }
   }
   ```

2. **If `clientCapabilities._meta["terminal-auth"]: true`**, the meta carries the spawn args
   so zed renders a "Sign in" button that runs the command in a new terminal.

3. **`authenticate({ methodId })`** is called by the client when the user picks a method.
   - claude-code-acp: returns `{}` (terminal flow does the actual work)
   - codex-acp: launches its sign-in
   - opencode: throws "not implemented"

4. **In `prompt()`**, if auth state is unsatisfied, raise `RequestError.authRequired()` (code
   `-32000`). zed's `flatten_acp` downgrades this to a typed `acp::Error::auth_required`,
   surfaced in UI with a "Sign in" affordance.

5. After successful auth, the next `prompt()` succeeds. No re-init needed.

### Recommendation for bodhi-pi

bodhi-pi is **provider-pluggable** (`pi-providers` registry). The auth flow needs to
fan-out per provider. Suggested initial implementation:

```ts
// in agent.ts initialize()
const configuredProviders = await this.kvStore?.get("auth_providers") ?? [];
const authMethods: acp.AuthMethod[] = [];
for (const provider of allProviders()) {
  if (configuredProviders.includes(provider.id)) continue;  // already configured
  authMethods.push({
    id: `bodhi-pi-login-${provider.id}`,
    name: `Log in to ${provider.name}`,
    description: `Sign in with ${provider.name}`,
    kind: "ApiKey",
    _meta: { provider: provider.id },
  });
}
return { /* ..., */ authMethods };
```

And `authenticate()`:
```ts
async authenticate({ methodId }) {
  const providerId = methodId.replace(/^bodhi-pi-login-/, "");
  // delegate to host's AuthRunner (new injection)
  await this.authRunner.signIn(providerId);
  this.eventBus.emit({ type: "auth_change" });
  return {};
}
```

And in `prompt()`:
```ts
if (this.currentModel == null) {
  throw new RequestError(-32000, "Auth required: select a model first");
}
```

## 7. Session ref-counting

zed's `open_or_create_session` (acp.rs:1006-1141) shares one thread across concurrent loaders
and ref-counts close. This is **the** pattern bodhi-pi needs to replicate on the server side
once `bodhi-pi-ws-server` and `bodhi-pi-http` go multi-tenant.

Codex-acp and claude-code-acp **don't** need this because they're stdio (single client). They
both assume one-prompt-at-a-time and serialize via single-flight. opencode's server is also
single-tenant.

So for bodhi-pi, the lift comes from zed itself, not the reference agents. Implementation
sketch:

```ts
class SessionRefMap {
  private entries = new Map<string, { state: SessionState, refCount: number }>();

  open(sessionId: string): SessionState {
    const existing = this.entries.get(sessionId);
    if (existing) { existing.refCount += 1; return existing.state; }
    const state = SessionState.load(sessionId);
    this.entries.set(sessionId, { state, refCount: 1 });
    return state;
  }
  close(sessionId: string): boolean {
    const e = this.entries.get(sessionId);
    if (!e) return false;
    e.refCount -= 1;
    if (e.refCount === 0) {
      this.entries.delete(sessionId);
      return true;  // last ref — caller should release resources
    }
    return false;
  }
}
```

## 8. Cancellation discipline

All three agents handle cancellation the same way:

1. `session/cancel` sets an `is_cancelled` flag on the session.
2. The current `prompt()` loop checks `is_cancelled` after every `await` boundary and bails.
3. On bail, `prompt()` returns `{ stopReason: "cancelled" }` (NOT an error).
4. Any in-flight tool call gets a `tool_call_update` with `status: "cancelled"` (or similar).

bodhi-pi does step 1 and partially step 3. Steps 2 and 4 are uneven — `find` / `grep` /
`run_script` don't propagate the abort signal to their internals. Fix by passing the
session's `AbortSignal` to each tool's `execute()` and checking it inside long-running loops.

## 9. Streaming text reveal

zed (client-side, acp_thread.rs:1689-1779) implements **paced byte reveal** for assistant
text. The agent sends chunks at whatever rate, zed buffers them, and a background task drains
at a target byte rate so text "types out" smoothly.

This is purely client-side — bodhi-pi doesn't need to do anything for zed to get smooth
reveal. But for `bodhi-pi-cli` / `bodhi-pi-ws-frontend`, the **client implementation should
also implement paced reveal** to give the same UX. (Lift from zed's implementation directly.)

## 10. Debug log surface

zed's `AcpDebugLog` (acp.rs:147-219) ring-buffers 2000 JSON-RPC messages and stderr lines.
The `acp_tools` crate (31k lines) is a developer panel that subscribes and renders them. The
common gripe with ACP development is "session got stuck and I have no idea why" — the debug
log is the answer.

None of the reference **agents** ship an equivalent (it's a client concern). But for
bodhi-pi, given the multi-host story, a server-side debug log is invaluable:

```ts
// in agent.ts, wrap conn.sessionUpdate and request handlers
class AcpDebugLog {
  private messages: Array<{ direction: "in"|"out", line: string, ts: number }> = [];
  private static MAX = 2000;

  record(direction: "in"|"out", payload: unknown) {
    const line = JSON.stringify(payload);
    this.messages.push({ direction, line, ts: Date.now() });
    if (this.messages.length > AcpDebugLog.MAX) this.messages.shift();
  }
  snapshot() { return [...this.messages]; }
}
```

Surface via a `_bodhi-pi/debug/snapshot` ext method, then have `bodhi-pi-cli` add a
`/debug` slash command that dumps it.

## 11. Mid-session refresh of derived state

Three patterns to wire correctly:

| Trigger                                  | Notification to emit        | When others emit                                           |
| ---------------------------------------- | --------------------------- | ---------------------------------------------------------- |
| Settings change affecting model picker   | `config_option_update`      | claude-code re-emits on model swap; codex on settings save |
| Settings change affecting slash commands | `available_commands_update` | opencode re-emits on extension hot-reload                  |
| Title generated/updated mid-session      | `session_info_update`       | claude-code emits after auto-title                         |
| Usage incremented                        | `usage_update` (beta)       | codex emits per turn                                       |
| Plan updated by TodoWrite                | `plan`                      | claude-code + opencode + codex all do                      |

bodhi-pi today has wires for `config_option_update`. Add wires for the others when their
internal trigger fires.

## 12. Default settings application client-side

zed applies user-saved defaults (last picked model, mode, config options) automatically after
`new_session`/`load_session`. This is **client-side memory**, not a server feature.

**Trick learned from zed's `apply_default_settings`** (acp.rs:1143-1238): build the local
optimistic state, fire-and-forget the `set_session_*` RPC, **roll back the local state on
error**. This is the right pattern for the reference hosts (cli, web, ws-frontend, chrome-ext)
to adopt for "remember my picks".

## 13. Stdio entrypoint for zed

claude-code-acp / codex-acp / opencode all ship a binary that:
1. Reads ACP over `stdin`, writes over `stdout`.
2. Logs to `stderr` (not stdout — that would corrupt JSON-RPC).
3. Reads env vars (`ANTHROPIC_API_KEY`, `CODEX_API_KEY`, etc.) and config files.
4. Exits cleanly when stdin closes.

zed's `agent_servers/src/custom.rs:359-468` shows how zed registers each:

```rust
// for claude-code-acp
{
  name: "claude",
  command: "claude-code-acp",
  args: vec![],
  env: vec![
    ("ANTHROPIC_API_KEY", api_key),
    ("ACP_PERMISSION_MODE", permission_mode),
    ("FORCE_ESLINT_NO_TTY", "true"),
  ],
}
```

bodhi-pi needs an equivalent `bin/bodhi-pi-acp` in `bodhi-pi-cli` (or a new dedicated
`bodhi-pi-acp-stdio` package). Most of the logic is shared with the existing CLI. The work is
small (~50 lines + entrypoint).

## 14. Tool-call ID strategy

All three agents follow the same pattern:
- The ID is generated by the agent (typically `${toolName}-${counter}` or UUID).
- It's stable across the `tool_call` → `tool_call_update`(s) → `tool_call_update`(final) chain.
- It can be referenced in `_meta` for client-side correlation (e.g., to a terminal_id).

bodhi-pi (`agent.ts:1567`) uses `event.toolCallId` from pi-agent-core. ✅ Already correct.

## 15. _meta extensibility

Every cross-agent feature that's not in the core ACP spec ends up in `_meta`:
- claude-code uses `_meta.claudeCode = { toolName, toolResponse }` on `tool_call_update`.
- codex uses `_meta.terminal_info = { terminal_id, cwd }` to inject terminal cards.
- opencode uses `_meta._opencode = { ... }`.

bodhi-pi's `_bodhi-pi` namespace is consistent with this convention (`agent.ts:560-825`). ✅

**Lesson:** never put bodhi-pi-specific data in spec-stable fields; always wrap in
`_meta._bodhi-pi`. The current codebase already does this — keep enforcing it.

## 16. Summary — pattern-by-pattern adoption priority

| #   | Pattern                         | Source                | Effort            | Value                         |
| --- | ------------------------------- | --------------------- | ----------------- | ----------------------------- |
| 1   | Two-tier event translation      | All                   | already in place  | n/a                           |
| 2   | Per-tool field builder          | claude-code, opencode | 1 day             | high UX                       |
| 3   | `requestPermission` flow        | All                   | 2 days            | **critical**                  |
| 4   | Diff content for edits          | All                   | 0.5 day           | high UX                       |
| 5   | Optional `client.fs.*` proxying | claude-code, codex    | 1 day             | medium (opt-in for zed)       |
| 6   | Auth methods + typed errors     | All                   | 1 day             | high                          |
| 7   | Session ref-counting            | zed (client)          | 1 day             | **critical for multi-tenant** |
| 8   | Cancellation discipline         | All                   | 0.5 day           | medium                        |
| 9   | Streaming text reveal           | zed (client)          | n/a (client side) | n/a                           |
| 10  | Debug log surface               | (server-side novel)   | 0.5 day           | high (debug velocity)         |
| 11  | Mid-session refresh emissions   | All                   | 0.5 day           | medium                        |
| 12  | Default-settings client memory  | zed (client)          | host-side         | medium                        |
| 13  | stdio entrypoint for zed        | All                   | 0.5 day           | high (zed integration)        |
| 14  | Tool-call IDs                   | All                   | done              | n/a                           |
| 15  | `_meta` discipline              | All                   | done              | n/a                           |

P0 priorities (do first): #3 (permissions), #7 (ref-counting), #13 (stdio bin), #6 (auth).
P1 priorities (do next): #2 (tool fields), #4 (diff content), #5 (opt-in fs proxy), #10 (debug log).
P2 priorities: the rest.

See `implementation.md` for the full execution plan.
