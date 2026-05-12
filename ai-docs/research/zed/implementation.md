# Implementation Plan — Raising bodhi-pi to Production-Grade ACP

**Date:** 2026-05-12
**Owner:** TBD
**Pre-reqs:** `01-zed-acp-architecture.md`, `02-bodhi-pi-vs-zed-comparison.md`,
`03-best-practices-from-known-agents.md`

This file converts the analysis into a sequenced, line-of-code-anchored plan. Each work item
includes:

- **Goal** — what changes for the user
- **Where** — file paths and line ranges
- **API** — the public type/method shape (new or modified)
- **Acceptance** — test names that prove the work landed
- **Host parity** — what each of the five reference hosts (cli, web, ws-server/frontend, http,
  chrome-ext) needs to do, per CLAUDE.md's "Runtime-host parity rule"

Work is sequenced **P0 → P1 → P2**. Within each tier, items are ordered by dependency.

---

## P0 — Production blockers

### P0-1. `session/request_permission` flow

**Goal:** before bodhi-pi runs a destructive tool (write/edit/run_script and the upcoming
bash), it asks the client for approval. zed surfaces the prompt in the tool card; cli surfaces
it in a y/n REPL question; web/chrome surface it in a dialog.

**Where:**
- `packages/bodhi-pi/src/acp/agent.ts:1593-1623` (`subscribeToAgent` → `tool_execution_start`
  case) — intercept before forwarding to ACP
- `packages/bodhi-pi/src/tools/index.ts` — annotate each `Tool` with
  `destructive: boolean`
- New file: `packages/bodhi-pi/src/permissions/permission-gate.ts` — the injection interface
- `packages/bodhi-pi-cli/src/agent.ts` — wire host implementation
- `packages/bodhi-pi-cli/src/repl/render.ts` — render the prompt in REPL

**API (new):**
```ts
// packages/bodhi-pi/src/permissions/permission-gate.ts
export type PermissionDecision =
  | { kind: "allow_once" }
  | { kind: "allow_always" }
  | { kind: "reject" };

export interface PermissionGate {
  /**
   * Called BEFORE a destructive tool runs. Implementations forward to
   * `client.requestPermission` (ACP host) or auto-allow (test/web hosts that own approval
   * separately). Implementations MUST treat thrown errors as `{ kind: "reject" }`.
   */
  request(args: {
    sessionId: string;
    toolCallId: string;
    toolName: string;
    rawInput: unknown;
  }): Promise<PermissionDecision>;
}

/** No-op gate that allows everything. Used by tests and hosts that pre-approve. */
export const ALWAYS_ALLOW: PermissionGate = {
  request: async () => ({ kind: "allow_once" }),
};
```

**Integration shape inside `BodhiPiAcpAgent`:**
```ts
// new private field on BodhiPiAcpAgent
private permissionGate: PermissionGate;     // injected via constructor
private sessionAllowList: Map<string, Set<string>> = new Map();
// sessionId → set of toolName for which the user said "always" in this session

// in subscribeToAgent, before forwarding tool_execution_start:
if (toolIsDestructive(event.toolName) && !this.alwaysAllowedFor(sessionId, event.toolName)) {
  const decision = await this.permissionGate.request({
    sessionId, toolCallId: event.toolCallId,
    toolName: event.toolName, rawInput: event.args,
  });
  if (decision.kind === "reject") {
    piAgent.injectToolResult(event.toolCallId, "Tool execution denied by user");
    return;  // skip forwarding tool_call
  }
  if (decision.kind === "allow_always") {
    this.rememberAlwaysAllow(sessionId, event.toolName);
  }
}
// then forward as today
```

**ACP host implementation** (used by stdio/cli/zed):
```ts
// in BodhiPiAcpAgent.initialize, capture the connection
const gate: PermissionGate = {
  async request({ sessionId, toolCallId, toolName, rawInput }) {
    const fields = toolCallFieldsFor(toolName, rawInput);  // see P1-2
    const resp = await this.conn.requestPermission({
      sessionId,
      toolCall: { toolCallId, rawInput, ...fields },
      options: [
        { id: "allow_once",   name: "Allow",  kind: "allow_once"   },
        { id: "allow_always", name: "Always", kind: "allow_always" },
        { id: "reject_once",  name: "Deny",   kind: "reject_once"  },
      ],
    });
    if (resp.outcome.kind !== "selected") return { kind: "reject" };
    return { kind: resp.outcome.optionId as any };
  }
};
```

**Tool annotations:**
```ts
// packages/bodhi-pi/src/tools/index.ts
const DESTRUCTIVE_TOOLS = new Set(["write", "edit", "run_script"]);
export function toolIsDestructive(name: string): boolean {
  return DESTRUCTIVE_TOOLS.has(name);
}
```

**Acceptance tests** (new in `packages/bodhi-pi/src/acp/agent.permission.test.ts`):
- `prompt() asks permission before write tool runs and forwards user choice`
- `prompt() skips permission when user previously said always-allow this session`
- `prompt() injects "denied" tool result when user rejects`
- `prompt() respects ALWAYS_ALLOW gate (legacy behaviour)`
- `prompt() handles ACP client returning cancelled outcome as reject`

**Host parity:**
- **cli**: implements `PermissionGate.request` by reading a y/n line from the REPL prompt;
  shows the tool name + a snippet of `rawInput`.
- **web** (in-process worker): default `ALWAYS_ALLOW` (UI runs in main thread; permission
  must be approved before the worker call by the React layer).
- **ws-server** (per-tab): plumbs to the connected ACP client via WebSocket.
- **http**: plumbs to the ACP client (when called as ACP) or `ALWAYS_ALLOW` (when called as
  REST).
- **chrome-ext**: plumbs to a content-script popup.

**Effort:** ~2 days incl. tests + host wiring.

---

### P0-2. Session ref-counting + close-during-load race

**Goal:** two clients can open the same session and bodhi-pi shares one in-memory state;
closing one tab doesn't drop the session for the other. Required for `bodhi-pi-ws-server`
multi-tenancy.

**Where:**
- `packages/bodhi-pi/src/acp/agent.ts:440-558` (loadSession, resumeSession, closeSession)
- New file: `packages/bodhi-pi/src/sessions/session-ref-map.ts`

**API:**
```ts
// packages/bodhi-pi/src/sessions/session-ref-map.ts
interface Entry {
  state: SessionState;
  refCount: number;
}

interface PendingEntry {
  promise: Promise<SessionState>;
  refCount: number;
}

export class SessionRefMap {
  private sessions = new Map<string, Entry>();
  private pending = new Map<string, PendingEntry>();

  /**
   * Open (or share) a session.
   * - If already open: bump refCount, return existing state immediately.
   * - If pending load: bump pending refCount, await the shared promise.
   * - Otherwise: invoke `loader`, register the promise as pending, settle into `sessions`.
   *
   * On loader failure, pending entry is removed; existing `sessions` entry (if any) is left
   * alone. On `close` during pending load, the load is allowed to complete but the entry
   * is removed immediately after so the next `open` will reload.
   */
  open(sessionId: string, loader: () => Promise<SessionState>): Promise<SessionState> { /* ... */ }

  /**
   * Decrement refCount. Returns true iff this was the last reference and the caller should
   * release resources (run shutdown event, etc.).
   */
  close(sessionId: string): boolean { /* ... */ }

  /** Test/debug helpers. */
  get(sessionId: string): SessionState | undefined { return this.sessions.get(sessionId)?.state; }
  refCount(sessionId: string): number { return this.sessions.get(sessionId)?.refCount ?? 0; }
}
```

**Integration:** swap the existing `private sessions: Map<string, SessionState>` field for
`private sessionRefs: SessionRefMap`. `loadSession`/`resumeSession` go through `open(...)`,
`closeSession` goes through `close(...)`.

**Acceptance tests** (new `packages/bodhi-pi/src/sessions/session-ref-map.test.ts` +
`packages/bodhi-pi/src/acp/agent.ref-counting.test.ts`):
- `two concurrent loadSession calls for same id share one SessionState and call store.load once`
- `close after one of two loaders still has refCount=1; session stays alive`
- `close on a single-ref session removes the entry and emits session_shutdown`
- `close during pending load aborts the load cleanly`
- `closeSession on unknown id is a no-op (no throw)`
- `history replay during pending load reaches the AcpThread` (validates load → emit
  notifications → return-response ordering)

**Host parity:** all five hosts get this for free; behaviour is server-internal.

**Effort:** 1 day.

---

### P0-3. `bodhi-pi-acp-stdio` entrypoint for zed integration

**Goal:** zed users can add a `bodhi-pi` entry under `agent_servers` in their settings and
talk to bodhi-pi directly.

**Where:** new file `packages/bodhi-pi-cli/src/acp-stdio.ts` (+ `bin` entry in package.json).
Alternative: new dedicated package `packages/bodhi-pi-acp-stdio`. Recommend reusing
bodhi-pi-cli for now.

**Implementation sketch:**
```ts
// packages/bodhi-pi-cli/src/acp-stdio.ts
import { AgentSideConnection, nodeStreams } from "@agentclientprotocol/sdk";
import { createBodhiPiAgent } from "@earendil-works/bodhi-pi";
import { buildHostConfig } from "./config.js";   // pulls cwd, kvStore, fs, etc.

async function main(): Promise<void> {
  const cfg = await buildHostConfig({ /* args from argv if any */ });
  const transport = nodeStreams(process.stdin, process.stdout);  // SDK helper
  const conn = new AgentSideConnection(
    (conn) => createBodhiPiAgent({ ...cfg, conn }),  // factory pattern
    transport,
  );
  process.stdin.on("end", () => process.exit(0));
  // Logging MUST go to stderr only; stdout is reserved for JSON-RPC.
  process.on("uncaughtException", (e) => { process.stderr.write(`fatal: ${e.stack}\n`); process.exit(1); });
}
main().catch((e) => { process.stderr.write(`bodhi-pi-acp: ${e.stack ?? e}\n`); process.exit(1); });
```

**package.json change:**
```json
{
  "bin": {
    "bodhi-pi-cli": "dist/cli.js",
    "bodhi-pi-acp": "dist/acp-stdio.js"
  }
}
```

**zed setup doc** (add to bodhi-pi README):
```jsonc
// ~/.config/zed/settings.json
{
  "agent_servers": {
    "bodhi-pi": {
      "command": "bodhi-pi-acp",
      "args": [],
      "env": {}
    }
  }
}
```

**Acceptance tests** (new
`packages/bodhi-pi-cli/e2e/acp-stdio.test.ts`): spawn the bin as a subprocess, send a JSON-RPC
`initialize` over stdin, assert the response shape. Probably 3-5 e2e cases covering init,
new session, prompt with a stub model.

**Host parity:** N/A — this is the new ACP host.

**Effort:** 1 day incl. e2e test harness.

---

### P0-4. Typed `AuthRequired` error

**Goal:** when `prompt()` fails because no model is selected or the active model's provider
has no auth, raise `-32000` (typed `AuthRequired`) instead of `-32603`. zed renders a
"Sign in" button; cli prompts for `/login`.

**Where:**
- `packages/bodhi-pi/src/acp/agent.ts:1340-1348` (the existing
  `if (currentModelId === null)` block)
- `packages/bodhi-pi/src/acp/agent.ts:1234` (`compact skipped: no API key`)
- `packages/bodhi-pi/src/acp/agent.ts:1232` (`no API key available for provider`)

**Change:**
```ts
// before
throw new RequestError(-32603, "no model selected; ...");

// after — typed code
import { RequestError } from "@agentclientprotocol/sdk";
const AUTH_REQUIRED = -32000;

throw new RequestError(
  AUTH_REQUIRED,
  models.length > 0
    ? `Select a model (one of: ${models.map(m => m.id).join(", ")})`
    : `Configure provider auth via /login <provider> <api-key>`,
);
```

Also wrap in `_meta.bodhi_pi.cause = "no_model" | "no_api_key"` so clients can branch.

**Acceptance:**
- Add `prompt() without model raises -32000 AuthRequired` to existing
  `agent.test.ts`.
- Update the existing `no model selected` test to expect `-32000`.

**Effort:** 30 min + test rewrite.

---

### P0-5. Cancellation discipline in built-in tools

**Goal:** when the user cancels mid-tool, the tool itself stops. Currently `find`, `grep`, and
`run_script` keep running until natural completion even after `piAgent.abort()`.

**Where:**
- `packages/bodhi-pi/src/tools/find.ts`
- `packages/bodhi-pi/src/tools/grep.ts`
- `packages/bodhi-pi/src/tools/run-script.ts`
- `packages/bodhi-pi/src/tools/walk.ts` (the walker behind find/grep)

**API change** (`packages/bodhi-pi/src/tools/index.ts` Tool interface, if it doesn't already
plumb signal):
```ts
execute(args, ctx: { fs: Filesystem; signal?: AbortSignal; ... }): Promise<...>
```

**Implementation:** every loop in walk.ts / grep.ts / run-script.ts checks `signal?.aborted`
at iteration boundaries and bails with a "cancelled" result.

**Acceptance:**
- New tests in `walk.test.ts`, `grep.ts` (no test file currently — add
  `grep.test.ts`):
  - `walk aborts on signal between directories`
  - `grep aborts on signal between matches`
  - `run-script aborts the child process on signal`
- Add `cancel during long grep stops the tool` to `agent.test.ts`.

**Host parity:** transparent.

**Effort:** 1 day.

---

## P1 — High-value ergonomics

### P1-1. Diff content blocks for `edit` and `write`

**Goal:** zed's tool card shows a colored inline diff for every edit. cli could surface the
same via a chalk-rendered diff.

**Where:**
- `packages/bodhi-pi/src/acp/notifications.ts:60-67` (`agentToolContentForAcp`) — split per
  tool type
- `packages/bodhi-pi/src/acp/agent.ts:1593-1623` (`tool_execution_update` case) — call the
  new builder

**Approach:** build the diff content at the agent.ts layer (where we know which tool fired)
rather than in notifications.ts (which only sees raw text). Wire-shape:

```ts
// new: per-tool content builder
function buildToolContent(
  toolName: string,
  rawInput: unknown,
  rawOutput: unknown,
): acp.ToolCallContent[] {
  if (toolName === "edit") {
    const inp = rawInput as { path: string; oldText: string; newText: string };
    return [{
      type: "diff",
      diff: { path: inp.path, oldText: inp.oldText, newText: inp.newText },
    }];
  }
  if (toolName === "write") {
    const inp = rawInput as { path: string; content: string };
    return [{
      type: "diff",
      diff: { path: inp.path, oldText: null, newText: inp.content },
    }];
  }
  // fall through to text shape for read/ls/find/grep/run_script
  return /* existing text shape */;
}
```

**Acceptance:**
- `notifications.test.ts`: new cases for `edit emits diff content with oldText/newText`,
  `write emits diff content with oldText=null for new files`.

**Effort:** 0.5 day.

---

### P1-2. Per-tool field builder

**Goal:** rich titles, kinds, and locations in `tool_call` notifications. Eliminates the
existing `formatLocationHint` stub.

**Where:**
- `packages/bodhi-pi/src/tools/index.ts:58-74` (replace `toolKindFor`)
- New: `packages/bodhi-pi/src/tools/acp-fields.ts`
- `packages/bodhi-pi/src/acp/notifications.ts:69-73` (delete `formatLocationHint`)
- `packages/bodhi-pi/src/acp/agent.ts:1572-1583` (use new builder)

**API:**
```ts
// packages/bodhi-pi/src/tools/acp-fields.ts
export interface ToolCallFields {
  title: string;
  kind: acp.ToolKind;
  locations: acp.ToolCallLocation[];
}

export function toolCallFieldsFor(name: string, rawInput: unknown): ToolCallFields {
  switch (name) {
    case "read":   return readFields(rawInput);
    case "write":  return writeFields(rawInput);
    case "edit":   return editFields(rawInput);
    case "ls":     return lsFields(rawInput);
    case "find":   return findFields(rawInput);
    case "grep":   return grepFields(rawInput);
    case "run_script": return runScriptFields(rawInput);
    default:       return { title: name, kind: "other", locations: [] };
  }
}

// per-tool implementations:
function readFields(args): ToolCallFields {
  const path = String((args as any)?.path ?? "");
  const offset = (args as any)?.offset as number | undefined;
  const limit = (args as any)?.limit as number | undefined;
  const range = offset != null && limit != null ? ` [${offset}:${offset + limit}]` : "";
  return {
    title: `Read ${path}${range}`,
    kind: "read",
    locations: path ? [{ path, line: offset }] : [],
  };
}

function editFields(args): ToolCallFields {
  const path = String((args as any)?.path ?? "");
  return {
    title: `Edit ${path}`,
    kind: "edit",
    locations: path ? [{ path }] : [],
  };
}

// ... and so on for write/ls/find/grep/run_script
```

**Acceptance:** new file `packages/bodhi-pi/src/tools/acp-fields.test.ts` with one case per
tool covering title, kind, locations.

**Effort:** 0.5 day.

---

### P1-3. Opt-in `client.fs.*` proxy (`useAcpFs`)

**Goal:** when running as a zed agent, read and write through the editor's project buffers so
unsaved changes are visible.

**Where:**
- `packages/bodhi-pi/src/acp/agent.ts` ctor — accept `useAcpFs: boolean` flag
- New: `packages/bodhi-pi/src/filesystem/acp-proxy-filesystem.ts`
- `packages/bodhi-pi-cli/src/acp-stdio.ts` — set `useAcpFs: true`

**API:**
```ts
// packages/bodhi-pi/src/filesystem/acp-proxy-filesystem.ts
export class AcpProxyFilesystem implements Filesystem {
  constructor(private conn: AgentSideConnection, private fallback: Filesystem) {}

  async readFile(path: string): Promise<string> {
    if (!this.conn.clientCapabilities.fs.readTextFile) return this.fallback.readFile(path);
    const resp = await this.conn.readTextFile({ path });
    return resp.content;
  }
  async writeFile(path: string, content: string): Promise<void> {
    if (!this.conn.clientCapabilities.fs.writeTextFile) return this.fallback.writeFile(path, content);
    await this.conn.writeTextFile({ path, content });
  }
  // delegate stat, ls, glob, exists, etc. to fallback — no ACP equivalents
  stat(p) { return this.fallback.stat(p); }
  ls(p) { return this.fallback.ls(p); }
  // ...
}
```

**Integration:** `createBodhiPiAgent` wraps the injected `filesystem` with
`AcpProxyFilesystem` when `useAcpFs && clientCapabilities.fs.*` are true.

**Acceptance:**
- `acp-proxy-filesystem.test.ts`: readFile calls conn.readTextFile when supported, falls
  back when not, propagates errors.
- `agent.test.ts`: new case `useAcpFs: true + client lacks readTextFile capability falls back
  to fallback fs`.

**Host parity:** only `bodhi-pi-acp-stdio` opts in by default; web/cli/ws/http/chrome stay
on the host-injected fs.

**Effort:** 1 day.

---

### P1-4. Auth methods + provider-aware `authenticate`

**Goal:** zed shows a "Sign in" picker that lists configured providers.

**Where:**
- `packages/bodhi-pi/src/acp/agent.ts:399-417` (initialize) — populate `authMethods`
- `packages/bodhi-pi/src/acp/agent.ts:419-421` (authenticate) — branch on provider id
- New: `packages/bodhi-pi/src/auth/auth-runner.ts` — injection point for the actual signin

**API:**
```ts
// packages/bodhi-pi/src/auth/auth-runner.ts
export interface AuthRunner {
  /**
   * Prompts the user for a credential for the given provider and persists it (via
   * KvStore.set("auth/<provider>", apiKey, { secret: true })). Returns when complete.
   * Throws if cancelled or unsupported.
   */
  signIn(providerId: string): Promise<void>;
}

export const NEVER_AUTH: AuthRunner = {
  signIn: async (id) => { throw new Error(`auth not supported in this host (${id})`); },
};
```

**Integration:**
```ts
// in initialize, list providers with NO auth yet
const auths = await this.kvStore?.list({ prefix: "auth/" }) ?? [];
const configured = new Set(auths.map(a => a.key.replace(/^auth\//, "")));
const methods: acp.AuthMethod[] = [];
for (const prov of this.providers.list()) {
  if (configured.has(prov.id)) continue;
  methods.push({
    id: `bodhi-pi-login-${prov.id}`,
    name: `Log in to ${prov.name}`,
    description: prov.signInDescription,
    kind: "ApiKey",
    _meta: { provider: prov.id },
  });
}
return { /*...*/, authMethods: methods };
```

```ts
async authenticate({ methodId }) {
  const m = /^bodhi-pi-login-(.+)$/.exec(methodId);
  if (!m) throw new RequestError(-32602, `unknown auth method: ${methodId}`);
  const providerId = m[1];
  try {
    await this.authRunner.signIn(providerId);
    this.events.emit({ type: "auth_change", providerId });
    return {};
  } catch (e) {
    throw new RequestError(-32603, `auth failed for ${providerId}: ${String(e)}`);
  }
}
```

**Acceptance:**
- `agent.test.ts`: `initialize advertises auth methods only for providers without keys`,
  `initialize advertises no methods when all providers configured`.
- `agent.auth.test.ts` (new): `authenticate dispatches to AuthRunner.signIn(providerId)`,
  `authenticate translates AuthRunner errors to RequestError`.

**Host parity:**
- **cli**: `AuthRunner` reads `process.stdin` (a prompt) and writes to kvStore.
- **web**: opens a React modal (host-specific UI hook).
- **ws-server**: forwards via WebSocket to ws-frontend.
- **http**: returns "manual setup required" — auth done out-of-band.
- **chrome-ext**: opens an extension popup with provider options.

**Effort:** 1 day for core + 0.5 day for cli implementation; web/ws/chrome can stub.

---

### P1-5. Server-side debug log

**Goal:** a ring buffer of inbound/outbound JSON-RPC messages, surfacable for debugging stuck
sessions.

**Where:** new `packages/bodhi-pi/src/acp/debug-log.ts` + a wrapper in `agent.ts` around
`conn.sessionUpdate` and request handlers.

**API:**
```ts
// packages/bodhi-pi/src/acp/debug-log.ts
export interface AcpDebugMessage {
  direction: "in" | "out";
  ts: number;
  method?: string;
  payload: unknown;
}

export class AcpDebugLog {
  private static MAX = 2000;
  private messages: AcpDebugMessage[] = [];

  record(msg: AcpDebugMessage): void {
    this.messages.push(msg);
    if (this.messages.length > AcpDebugLog.MAX) this.messages.shift();
  }
  snapshot(opts?: { limit?: number; direction?: "in" | "out" }): AcpDebugMessage[] {
    let res = this.messages;
    if (opts?.direction) res = res.filter(m => m.direction === opts.direction);
    if (opts?.limit) res = res.slice(-opts.limit);
    return [...res];
  }
  clear(): void { this.messages = []; }
}
```

**Wire-in:** wrap every `conn.sessionUpdate(notif)` call site in `agent.ts` to also call
`debugLog.record({ direction: "out", ts: Date.now(), payload: notif })`. Wrap each request
handler entry to record inbound.

**Surface:** add a new ext method:
```
_bodhi-pi/debug/snapshot — params: { limit?: number, direction?: "in"|"out" }
                          response: { messages: AcpDebugMessage[] }
_bodhi-pi/debug/clear    — params: {}, response: {}
```

Add to `EXT_*` constants in `acp/constants.ts`.

**Host:** `bodhi-pi-cli` adds a `/debug` slash that calls `_bodhi-pi/debug/snapshot --limit 100`
and pretty-prints.

**Acceptance:**
- New `packages/bodhi-pi/src/acp/debug-log.test.ts`: ring buffer respects MAX, snapshot is a
  copy, filter works.
- `agent.test.ts`: prompting fires N out-direction records for the assistant chunks; the ext
  method returns them.

**Effort:** 0.5 day.

---

### P1-6. `agent_thought_chunk` for reasoning models

**Goal:** thinking content from o1/claude-thinking/deepseek-r1/qwen3 lands in zed's
`<thinking>` folded block instead of being dropped.

**Where:** `packages/bodhi-pi/src/acp/agent.ts:1554-1562` — add a
`case "reasoning_delta"` branch in the `message_update` event handler.

```ts
case "reasoning_delta":
  await this.conn.sessionUpdate({
    sessionId,
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text: event.delta },
  });
  break;
```

**Acceptance:** new test in `agent.test.ts`: `prompt with a thinking model emits
agent_thought_chunk for reasoning deltas`.

**Effort:** 30 min + finding/stubbing a reasoning provider in the test.

---

### P1-7. `available_commands_update` on settings/extensions change

**Goal:** the slash menu in zed/cli/web stays in sync when commands or skills are added,
removed, or modified mid-session.

**Where:** `packages/bodhi-pi/src/acp/agent.ts:339-346` (the existing event subscription) —
add cases for `commands_change` and `skills_change`. May require new event types in
`events/types.ts` if they don't exist.

**Implementation:**
```ts
// in setupEventSubscriptions
events.on("commands_change", async ({ sessionId }) => {
  const session = this.sessionRefs.get(sessionId);
  if (!session) return;
  await this.conn.sessionUpdate({
    sessionId,
    sessionUpdate: "available_commands_update",
    availableCommands: advertiseSlashable(session.commands, session.skills),
  });
});
```

Triggers:
- `_bodhi-pi/session/settings/set` mutates `commands.*` → emit
- Extension hot-reload → emit
- `commands/discovery.ts` re-scan → emit (when project gains a new
  `.bodhi-pi/commands/foo.md`)

**Acceptance:** `agent.test.ts`: `settings change for commands re-emits
available_commands_update`.

**Effort:** 0.5 day.

---

### P1-8. `usage_update` notifications

**Goal:** zed (with `AcpBetaFeatureFlag`) shows token usage per session. cli could also
surface this.

**Where:** `packages/bodhi-pi/src/acp/agent.ts:1554-1562` `message_end` case.

```ts
case "message_end":
  if (event.usage) {
    await this.conn.sessionUpdate({
      sessionId,
      sessionUpdate: "usage_update",
      used: event.usage.totalTokens ?? 0,
      size: this.modelContextWindow(session.runtime.currentModelId) ?? 0,
      ...(event.usage.costUSD != null
        ? { cost: { amount: event.usage.costUSD, currency: "USD" } }
        : {}),
    });
  }
  break;
```

**Acceptance:** new test in `agent.test.ts`: `prompt with usage data emits usage_update`.

**Effort:** 30 min.

---

## P2 — Lower-priority polish

### P2-1. `session_info_update` on load

When `loadSession`/`resumeSession` finds a `session_info` entry with a `name`, emit a
`session_info_update` notification during replay so the sidebar gets the title for free.

**Where:** `packages/bodhi-pi/src/acp/agent.ts:460-505` (the replay loop).

**Effort:** 30 min.

---

### P2-2. Delta-only `tool_call_update.content`

Stop re-sending the entire growing buffer on each update; emit only the new bytes. Add a
`_meta._bodhi-pi.contentMode: "append" | "replace"` hint so clients know.

**Where:** `packages/bodhi-pi/src/acp/notifications.ts:60-67` and call sites.

**Effort:** 1 day (involves accumulator refactor; do alongside P1-1).

---

### P2-3. MCP server passthrough

When `NewSessionRequest.mcpServers` arrives, spawn each via the extension runner and merge
their tools into the session.

**Where:** `packages/bodhi-pi/src/acp/agent.ts:423-438`, `packages/bodhi-pi/src/extensions/`.

This is significant — separate work item, not in this round.

**Effort:** 1-2 weeks. Skip for now.

---

### P2-4. Terminal/* outbound (when `bash` lands)

Once the deferred `bash` tool is built (PARITY.md row 7), wire it via Layer B (meta-based
terminal_info / terminal_output / terminal_exit on tool_call_update). This is the same wire
shape codex-acp uses and zed renders cleanly.

**Where:** `packages/bodhi-pi/src/tools/bash.ts` (new) + `agent.ts` tool-execution branch.

**Effort:** 2-3 days once tool design is settled.

---

### P2-5. `Plan` notifications for `TodoWrite`-style tools

When bodhi-pi gains a planning tool, convert its output into a `Plan` SessionUpdate (entries
with status). Until then, defer.

**Effort:** N/A — depends on tool.

---

### P2-6. Default-settings client memory (per-host)

Each ACP-consuming host stores the last picked model/thinking-level per session and
auto-applies after `loadSession`. This is purely host-side; bodhi-pi server doesn't change.

**Where:**
- `packages/bodhi-pi-cli/src/repl/repl.ts` — read `~/.config/bodhi-pi-cli/defaults.json`
- `packages/bodhi-pi-ws-frontend/...` — read localStorage
- `packages/bodhi-pi-chrome-ext/...` — read extension storage

**Effort:** 0.5 day per host.

---

## Dependency graph

```
P0-2 (ref-counting) ─── needed by ──┐
                                     ├── P0-1 (permissions)
P1-2 (tool field builder) ──────────┘ ── P1-1 (diff content) ──┐
                                                                ├── tighter UX
P1-5 (debug log) ───────────────── parallel ─── P1-6 ─── P1-7  ┘

P0-3 (stdio bin) ── parallel ────── P0-4 (auth error) ── enables P1-4 (auth methods)
                                                                  │
                                                                  └── P1-3 (acp fs proxy)
                                                                       (most valuable for zed
                                                                        where stdio bin runs)
P0-5 (cancellation) ──────────────── independent
```

Critical path: **P0-2 → P0-1 → P0-3 → P1-2 → P1-1**. P0-4/P0-5/P1-5/P1-6/P1-7/P1-8 can be
interleaved by separate authors.

## Test surface summary

New test files:
1. `packages/bodhi-pi/src/permissions/permission-gate.test.ts`
2. `packages/bodhi-pi/src/sessions/session-ref-map.test.ts`
3. `packages/bodhi-pi/src/acp/agent.permission.test.ts`
4. `packages/bodhi-pi/src/acp/agent.ref-counting.test.ts`
5. `packages/bodhi-pi/src/acp/agent.auth.test.ts`
6. `packages/bodhi-pi/src/acp/debug-log.test.ts`
7. `packages/bodhi-pi/src/filesystem/acp-proxy-filesystem.test.ts`
8. `packages/bodhi-pi/src/tools/acp-fields.test.ts`
9. `packages/bodhi-pi/src/tools/grep.test.ts` (only test missing today for that tool)
10. `packages/bodhi-pi-cli/e2e/acp-stdio.test.ts`

Modified test files:
- `packages/bodhi-pi/src/acp/agent.test.ts` (touched by P0-4, P1-6, P1-7, P1-8, P2-1)
- `packages/bodhi-pi/src/acp/notifications.test.ts` (touched by P1-1)
- `packages/bodhi-pi/src/tools/index.test.ts` (touched by P1-2)
- `packages/bodhi-pi/src/tools/walk.test.ts` (touched by P0-5)
- `packages/bodhi-pi/src/tools/run-script.test.ts` (touched by P0-5)

## Documentation deliverables

1. Update `packages/bodhi-pi/PARITY.md` — flip "deferred" rows to "shipped" as items land;
   add a new column "ACP-level" denoting whether the feature exposes itself on the ACP wire.
2. Update `packages/bodhi-pi/CLAUDE.md`:
   - "Authentication" section once P1-4 lands.
   - "Permission gating" section once P0-1 lands.
   - "Debug log" section once P1-5 lands.
   - "Optional ACP fs proxy" section once P1-3 lands.
3. New `packages/bodhi-pi-cli/README.md` zed integration section pointing at
   `bodhi-pi-acp` bin and settings.json snippet.
4. Update root `ai-docs/research/zed/README.md` "TL;DR" table as items get checked off.

## Acceptance-of-acceptance

This plan is "done" when:
- All P0 items have green CI tests against `bodhi-pi`, `bodhi-pi-cli`, and at least one
  multi-tenant host (`bodhi-pi-ws-server`).
- A zed user can install bodhi-pi via `npm i -g @earendil-works/bodhi-pi-cli`, add the
  settings.json snippet, and have a working agent with permission prompts, diff previews, and
  unsaved-buffer awareness.
- `PARITY.md` rows for ACP-server gaps go to "shipped" (with this implementation document
  linked in their notes).

## Suggested `.rules` additions

Per the repo's rules-hygiene policy, two patterns from this analysis are non-obvious enough to
crystallize as rules in `packages/bodhi-pi/CLAUDE.md` once they've been validated in code
review:

1. **Outbound ACP requests** — bodhi-pi has a deliberate split between host-injected
   capabilities (`Filesystem`, `Terminal`, `KvStore`) and outbound ACP requests (`fs/*`,
   `terminal/*`). The rule: "When adding an outbound ACP request, also add a host-injected
   fallback. Tests must cover both code paths." This emerged from P1-3.
2. **Session ref-counting** — "Any new state stored per-session in `BodhiPiAcpAgent` must live
   in `SessionState` and be released via `SessionRefMap.close()`'s last-ref hook, never on
   raw `closeSession()`." This emerged from P0-2.

Both rules satisfy the three criteria (non-obvious, repeatedly hit during this analysis,
specific).
