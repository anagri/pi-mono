# Terminal/Shell-Exec Interface Research — informing bodhi-pi's terminal design

Date: 2026-05-14. Read-only research; no code changed. Goal: pick a TS terminal interface for bodhi-pi (TS-based ACP agent across cli/http/ws/browser/chrome-ext) that is idiomatic in 2026 and works in both Node and the browser.

---

## A. ACP terminal surface (Zed + ACP spec)

ACP defines a **client-owned, agent-driven** terminal. The agent calls `terminal/*` methods on the client; the client (e.g. Zed) actually spawns the process and streams output back. Five methods, no streaming notifications — the agent polls `terminal/output` or awaits `terminal/wait_for_exit`. Source: `/Users/amir36/Documents/workspace/src/github.com/agentclientprotocol/agent-client-protocol/docs/protocol/terminals.mdx` and `schema/schema.json`.

**Capability gate** (in `InitializeResponse.clientCapabilities`):
```json
{ "clientCapabilities": { "terminal": true } }
```

**Methods** (all `x-side: client`):

| method | params | result |
|---|---|---|
| `terminal/create` | `sessionId`, `command` (string, required), `args?` (string[]), `env?` (`{name,value}[]`), `cwd?` (abs path), `outputByteLimit?` (uint64) | `{ terminalId }` — returns immediately, process runs in background |
| `terminal/output` | `sessionId`, `terminalId` | `{ output: string, truncated: boolean, exitStatus?: { exitCode\|null, signal\|null } }` |
| `terminal/wait_for_exit` | `sessionId`, `terminalId` | `{ exitCode?, signal? }` (blocks until exit) |
| `terminal/kill` | `sessionId`, `terminalId` | `{}` — kills process but keeps id valid |
| `terminal/release` | `sessionId`, `terminalId` | `{}` — frees the slot |

Notable design choices:
- `command` + `args[]` (no merged shell string); `env` is `[{name,value}]` array, not a map.
- `outputByteLimit` truncates from the **start** of output, on a UTF-8 char boundary.
- No streaming notification — output is pulled. Live display is achieved by embedding the `terminalId` inside a `tool_call` content item (`{ "type": "terminal", "terminalId": "..." }`), and the client renders live.
- Timeouts are not first-class: the agent composes them from `create` + setTimeout + `kill` + `output`.
- Cancellation: `kill` (and explicit `release`).

**Zed's seam**: handlers live in `crates/agent_servers/src/acp.rs` — `handle_create_terminal`, `handle_kill_terminal`, `handle_release_terminal`, `handle_terminal_output`, `handle_wait_for_terminal_exit` (around lines 3609–3760). They delegate to `acp_thread::Terminal` (`crates/acp_thread/src/terminal.rs`) which wraps Zed's existing `terminal::Terminal` (alacritty-backed PTY). Zed builds the shell via `ShellBuilder::new(...).redirect_stdin_to_dev_null().build(command, args)` — i.e. stdin is intentionally disabled to keep things non-interactive.

**Reference-only for bodhi-pi**: bodhi-pi inverts ACP (agent owns FS and tools), so we will NOT delegate `terminal/*` to the ACP client. Useful as a vocabulary check: any field present in ACP is a fair candidate for our own schema.

---

## B. Common interface shape across 2026 frameworks

### Mastra (`packages/core/src/workspace/tools/execute-command.ts`, `sandbox/types.ts`)

The richest in-tree TS reference — a zod-validated tool plus a pluggable `Sandbox` provider interface. Three sandbox tools: `execute_command`, `get_process_output`, `kill_process`.

```ts
// Tool input (Mastra)
z.object({
  command: z.string(),                      // shell command (pipes/redirects allowed)
  timeout: z.number().nullish(),            // seconds (NOT ms) — preprocesses numeric strings
  cwd: z.string().nullish(),
  tail: z.number().nullish(),               // last N lines for foreground (default DEFAULT_TAIL_LINES)
  // when sandbox.processes exists, also:
  background: z.boolean().optional(),       // detach + return PID
})
```

```ts
// Underlying Sandbox.executeCommand (provider contract)
executeCommand?(
  command: string,
  args?: string[],
  options?: {
    timeout?: number;             // ms (note unit-mismatch vs tool)
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    onStdout?: (data: string) => void;
    onStderr?: (data: string) => void;
    abortSignal?: AbortSignal;
  }
): Promise<CommandResult>;

// CommandResult / ExecutionResult
{ success: boolean; exitCode: number; stdout: string; stderr: string;
  executionTimeMs: number; timedOut?: boolean; killed?: boolean;
  command?: string; args?: string[]; }
```

Streaming model is **dual**: the underlying sandbox supports `onStdout/onStderr` callbacks; the tool re-emits via a workflow `writer.custom({type:'data-sandbox-stdout',...})`. Background mode returns `Started background process (PID: ...)` and stores the handle for later `get_process_output` / `kill_process`. Notable polish: it strips trailing `| tail -N` from the command and applies tail programmatically so output streams in real time. Provider examples include LocalSandbox (Node child_process / execa), MastraSandbox base, and ComputeSDK providers like E2B, Daytona, Vercel.

### Anthropic Bash tool (`bash_20250124`)

Schema-less tool — built into the model. Inputs: `command: string`, `restart?: bool`. **Persistent bash session** (state survives across calls — `cd`, env vars). Output is one merged string; no separate stdout/stderr; no streaming. The host process is responsible for the session and for implementing timeouts, sanitization, and allowlisting. Anthropic's docs explicitly call out: "No streaming — results returned after completion".

### OpenAI Agents SDK shell / `shell_call`

Request shape (`shell_call.action`): `{ commands: string[], timeout_ms: number, max_output_length: number }` — note: `commands` is an array, not a single command (each item is a command line). Response (`shell_call_output`): `{ stdout, stderr, outcome: { type: "exit", exit_code } | { type: "timeout" }, max_output_length }`. Batched, not streamed. Hosted mode runs in OpenAI-managed ephemeral containers (no network unless allow-listed, filesystem rooted at `/mnt/data`); local mode hands commands back to the caller.

### opencode (sst/opencode)

`bash` tool: `command: string` plus a required `description: string` (5–10 words). Permission system parses the command via tree-sitter to identify operations and ask for granular allowlist approval. Shell families supported: bash, zsh, pwsh, cmd. Source at `packages/opencode/src/tool/shell.ts`.

### Cline / Roo-Code (`execute_command`)

Params: `command: string` (required), `requires_approval: boolean` (required), `timeout: integer` seconds (optional, only when yolo mode). Notably **no explicit `cwd` param** — the working directory is injected via system prompt context (`{{CWD}}`). Default hard timeout 30s in Cline (reported as a UX bug). VS Code's terminal API is the runtime; real-time output is captured via shell-integration sequences (OSC 633).

### LangChain ShellTool (TS — `@langchain/openai`)

Input: `ShellInput`. Execute returns a `ShellResult` whose output array entries are `{ stdout, stderr, outcome: { type:"exit", exit_code:number } | { type:"timeout" } }`. Action includes `commands: string[]` and `timeout_ms?: number` — clearly modelled on OpenAI's shape.

### Aider

Aider doesn't expose a model-callable shell tool by default — it has its own `/run` chat command for user-invoked shell execution and pipes output back into the conversation; no schema in the agent-tool sense.

### Pattern summary

| field | ACP | Mastra | Claude | OpenAI | opencode | Cline | LangChain |
|---|---|---|---|---|---|---|---|
| `command` (string) | ✓ (+args[]) | ✓ | ✓ | ✓ (array) | ✓ | ✓ | ✓ (array) |
| `cwd` | ✓ | ✓ | session-state | – | – | system-prompt | – |
| `env` | ✓ (kv list) | ✓ (map) | session-state | – | – | – | – |
| `timeout` | composed | seconds | host-managed | `timeout_ms` | – | seconds | `timeout_ms` |
| `stdin` | – (redirected to /dev/null) | – | – | – | – | – | – |
| `background`/async | release/kill | `background: true` | – | – | – | – | – |
| separate stdout/stderr | merged stream | ✓ | merged | ✓ | ✓ | merged | ✓ |
| `exitCode` | ✓ (+signal) | ✓ | – (text) | ✓ | ✓ | – (text) | ✓ |
| `durationMs` | – | ✓ (`executionTimeMs`) | – | – | – | – | – |
| `truncated`/output cap | `outputByteLimit` | `tail` + token-cap | host | `max_output_length` | – | – | – |
| streaming | pull / poll | callbacks + stream events | no | no | yes (chunks) | yes (OSC 633) | no |
| cancellation | `kill` | `abortSignal` + `kill_process` | host | timeout only | yes | host | timeout |
| stateful session | per-id | per-id (background) | persistent shell | stateless | stateless | stateless | stateless |

**Convergent "good" shape (2026)**:
- Inputs almost everyone has: `command: string`, `cwd?: string`, `timeoutMs?: number` (ms beats seconds; only Mastra & Cline use seconds and Mastra's *internal* layer uses ms — pick ms).
- Inputs the leaders have: `env?: Record<string,string>` (Mastra/ACP), `background?: boolean` (Mastra only — useful for dev servers/watchers).
- Outputs everyone has: `stdout`, `stderr`, `exitCode` (or merged-text equivalent). The richer ones add `durationMs`, `timedOut`, `killed`, `truncated`.
- Streaming is becoming table-stakes (Mastra, Cline, opencode, WebContainer); batch-only (Claude Bash, OpenAI shell) is the older shape.
- `stdin` is universally absent — non-interactive is the assumption; Zed even pipes stdin to `/dev/null`.
- Cancellation: `AbortSignal` (Node-idiomatic) or explicit `kill(id)`.

---

## C. Browser-runtime considerations

bodhi-pi must run inside `browser` and `chrome-ext` runtimes — there's no `child_process` there. The viable options:

1. **WebContainer (StackBlitz)** — only mature in-browser POSIX-ish shell. API:
   ```ts
   spawn(command: string, args?: string[], options?: SpawnOptions): Promise<WebContainerProcess>
   // WebContainerProcess:
   //   exit: Promise<number>
   //   output: ReadableStream<string>   // merged terminal output (PTY)
   //   input: WritableStream<string>
   //   kill(): void
   //   resize({cols,rows}): void
   ```
   No native `timeout`; merged output stream (jsh terminal — no separate stderr); no `env` option (env is set by `mount({'.env':...})` files); separate `cwd` not directly on spawn (you `cd` first or pass `cwd` via SpawnOptions). Powers bolt.new, bolt.diy. Cross-origin-isolation headers required (`COOP`/`COEP`). Heavy: ~10–20 MB boot, persistent virtual fs. Licensed for OSS but commercial use needs StackBlitz approval. Drawback for bodhi-pi: license, weight, and that we don't actually need a node container — only an agent shell.

2. **`agent-infra/sandbox`** style — Dockerised remote sandbox surfaced over HTTP/MCP. Solves browser-runtime cleanly by offloading entirely (the "browser" tab just talks to a remote sandbox), but introduces a server dependency we don't currently have.

3. **No-shell / "deny in browser"** — return a `terminal_unsupported` capability flag in the browser runtime and let the model adapt. Simplest, matches our existing fs story where some runtimes are read-only.

4. **JS-only emulator** (e.g. xterm.js + a wasm `sh` like `wasmer-sh`, or pure-JS `jsh`) — possible but niche; nothing standard.

5. **WS bridge to a host** — the browser/chrome-ext talks to a bodhi-pi cli/http process that owns the shell. This matches bodhi-pi's existing runtime story (cli/http/ws hosts) and lets the agent surface the same `Terminal` interface everywhere, with the browser implementation being a thin RPC client.

**Recommendation for B/C**: ship a `Terminal` interface with a Node implementation backed by `child_process` (cli/http/ws/node-tests), and a browser-runtime implementation that **either** (a) RPCs to a bodhi-pi host over the existing WS transport, or (b) reports `terminal: false` capability. WebContainer is an optional 3rd adapter for users who want a fully in-browser experience.

---

## D. Recommendation — candidate TS interface

Synthesising the convergent shape above, here's the proposed bodhi-pi terminal contract. It's deliberately closer to Mastra's split than to ACP — ACP's 5-method poll model is overkill when we own the agent. We keep one `exec` for the happy path and `spawn` for background processes.

```ts
// packages/bodhi-pi/src/terminal/types.ts
export interface TerminalExecInput {
  command: string;                              // shell line; pipes/redirects ok
  cwd?: string;                                 // absolute or runtime-relative
  env?: Record<string, string>;                 // merged onto inherited env
  timeoutMs?: number;                           // hard kill after N ms
  signal?: AbortSignal;                         // cooperative cancellation
  // Streaming hooks (optional — omit for batch mode):
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  // Output cap (post-process; truncates from start, char-boundary):
  outputByteLimit?: number;
}

export interface TerminalExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;                      // null when signal-terminated
  signal?: string | null;                       // e.g. 'SIGTERM'
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
}

export interface TerminalSpawnInput extends Omit<TerminalExecInput, 'onStdout' | 'onStderr'> {}
export interface TerminalHandle {
  pid: string;                                  // opaque; not always OS pid
  exit: Promise<TerminalExecResult>;
  output: AsyncIterable<{ stream: 'stdout' | 'stderr'; data: string }>;
  kill(signal?: 'SIGTERM' | 'SIGKILL'): Promise<void>;
}

export interface Terminal {
  readonly capabilities: { exec: boolean; spawn: boolean; cancel: boolean; env: boolean; cwd: boolean };
  exec(input: TerminalExecInput): Promise<TerminalExecResult>;       // foreground, awaited
  spawn?(input: TerminalSpawnInput): Promise<TerminalHandle>;        // optional: background
}
```

Rationale per field:
- **`command: string`** (not `command + args[]`) — matches Mastra, Claude, opencode, Cline; lets the model use pipes/redirects naturally. ACP's split-args style is awkward for LLMs that emit single-string shell lines.
- **`cwd`/`env`** — table stakes in ACP and Mastra; Claude/opencode get away without because of stateful sessions, which we don't want (statelessness composes better across our runtimes).
- **`timeoutMs`** — ms not seconds. Aligns with Mastra's underlying sandbox layer, OpenAI's `timeout_ms`, and Node's `signal: AbortSignal.timeout(ms)`.
- **`signal: AbortSignal`** — the Node-2026 idiom. Cancellation in cli/http/ws flows already uses AbortSignal; reusing it avoids a parallel `kill()` API for foreground.
- **`onStdout`/`onStderr`** — covers streaming without committing to an iterator; same shape Mastra exposes from its provider layer. Hosts that don't need streaming just omit the callbacks.
- **`outputByteLimit` + `truncated`** — borrowed from ACP. Mastra's `tail` line-mode is nice but byte-mode is simpler and language-agnostic; we can layer a tail helper on top.
- **`exitCode: number | null` + `signal`** — exactly ACP's `TerminalExitStatus`; matches Node's child_process semantics.
- **`durationMs` + `timedOut`** — borrowed from Mastra. Cheap to surface; useful for the model.
- **Split `exec` (await) vs `spawn` (background)** — Mastra-style. Avoids ACP's 5-RPC dance. `spawn` is optional so the browser adapter can omit it.
- **`capabilities`** — surface what the adapter can do; the agent code branches once at session-start rather than catching errors per call. Matches bodhi-pi's existing capability gating in fs.

Runtime adapters:
- **Node adapter** (`cli/http/ws`): `child_process.spawn` + AbortController + a small streaming buffer with byte cap. All capabilities `true`.
- **Browser adapter v1**: `capabilities.exec = false`, throws a typed `TerminalUnsupportedError`. Tool not surfaced to the model.
- **Browser adapter v2 (optional)**: WS bridge to a Node host that holds the actual `Terminal` — same interface, transport is `bodhi-pi`'s existing WS RPC. Adapter advertises whatever the host advertises.
- **WebContainer adapter (optional, future)**: wraps `WebContainerProcess`. Merged-output PTY means `stderr` is always empty and `stdout` gets the lot; surface that via a `capabilities.separateStderr = false` flag so the model knows.

Names are intentionally narrow: no `terminal/create`/`release`/`output`/`wait_for_exit` ceremony. We're the agent — we own the process — we don't need a 5-RPC handshake to ourselves. If we ever need to expose this *through* ACP (e.g. let a remote ACP client display live output), we can map our `Terminal` onto ACP's content type `{ type: "terminal", terminalId }` and emit `session/update` events; that mapping is straightforward and doesn't constrain the interface.

---

## Sources

- ACP terminal spec: /Users/amir36/Documents/workspace/src/github.com/agentclientprotocol/agent-client-protocol/docs/protocol/terminals.mdx
- ACP schema: /Users/amir36/Documents/workspace/src/github.com/agentclientprotocol/agent-client-protocol/schema/schema.json (defs CreateTerminalRequest, TerminalOutputResponse, KillTerminalRequest, ReleaseTerminalRequest, WaitForTerminalExitRequest, TerminalExitStatus)
- Zed handlers: /Users/amir36/Documents/workspace/src/github.com/zed-industries/zed/crates/agent_servers/src/acp.rs:3609 (handle_create_terminal et al.)
- Zed terminal entity: /Users/amir36/Documents/workspace/src/github.com/zed-industries/zed/crates/acp_thread/src/terminal.rs
- Zed thread create_terminal: /Users/amir36/Documents/workspace/src/github.com/zed-industries/zed/crates/acp_thread/src/acp_thread.rs:2794
- Mastra tool: /Users/amir36/Documents/workspace/src/github.com/mastra-ai/mastra/packages/core/src/workspace/tools/execute-command.ts
- Mastra kill_process: /Users/amir36/Documents/workspace/src/github.com/mastra-ai/mastra/packages/core/src/workspace/tools/kill-process.ts
- Mastra sandbox types: /Users/amir36/Documents/workspace/src/github.com/mastra-ai/mastra/packages/core/src/workspace/sandbox/types.ts
- Mastra tool-name mapping: /Users/amir36/Documents/workspace/src/github.com/mastra-ai/mastra/mastracode/src/tool-names.ts
- Claude bash tool: https://docs.claude.com/en/docs/agents-and-tools/tool-use/bash-tool
- OpenAI shell tool: https://developers.openai.com/api/docs/guides/tools-shell
- LangChain ShellOptions: https://reference.langchain.com/javascript/interfaces/_langchain_openai.ShellOptions.html
- opencode bash: https://deepwiki.com/sst/opencode/5.3-built-in-tools-reference
- Cline execute_command: https://github.com/cline/cline/blob/main/src/core/prompts/system-prompt/tools/execute_command.ts
- Roo-Code: https://docs.roocode.com/advanced-usage/available-tools/execute-command
- WebContainer API: https://webcontainers.io/api
- bolt.diy/agent-infra sandbox refs: https://github.com/agent-infra/sandbox
