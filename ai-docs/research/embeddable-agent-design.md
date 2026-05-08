# bodhi-pi — Design

**Package:** `@bodhiapp/bodhi-pi`
**Status:** Design accepted
**Date:** 2026-05-07

A self-contained, embeddable coding agent that talks to its host through narrow, dependency-injected interfaces. Runs unchanged under a Node CLI, a browser worker, and a web server.

Sibling to `packages/coding-agent`. Depends only on `@mariozechner/pi-agent-core` and `@mariozechner/pi-ai`. No TUI, no `node:fs`, no `child_process`, no workspace package coupling in core.

For deferred decisions see [`ai-docs/plans/deferred.md`](../plans/deferred.md). For things deliberately out of scope see [`ai-docs/plans/skipped.md`](../plans/skipped.md).

---

## 1. Decisions

| Area | Decision |
|---|---|
| **Name / package** | `bodhi-pi`, published as `@bodhiapp/bodhi-pi` |
| **Host↔Agent wire protocol** | **ACP (Agent Client Protocol)** — for `initialize`, `session/*`, `session/prompt`, `session/cancel`, `session/update` events |
| **Filesystem** | **Injected `Filesystem` interface, in-process.** Not delegated over ACP. Host wires concrete impl at boot. |
| **Terminal / shell** | **Injected `Terminal` interface, in-process.** Not delegated over ACP. Browser hosts inject `just-bash/browser` (limited browser-side bash); Node hosts inject a real bash impl. |
| **Permissions** | Injected `Permissioner` interface; surfaced over ACP `session/request_permission` when ACP wire is in use. |
| **Persistence** | Injected `SessionStore` interface (JSONL on Node, IndexedDB/OPFS in browser, DB in server). |
| **Sessions / fork / clone / compaction** | **Port from `coding-agent`** and adapt to use injected interfaces. Same feature set, different I/O boundary. |
| **Skills / extensions** | **Standalone JavaScript ESM only.** No TypeScript at runtime, no jiti, no Node-only APIs in the extension contract. Same extension runs under Node and browser. |
| **Development model** | TDD-first. Conformance suites for every interface; golden-trace tests for the agent loop; ACP wire-validation against the upstream schema. |

---

## 2. Architecture

```
                  ┌────────────────────────────────────────────────┐
                  │                     Host                       │
                  │   (CLI shell, browser worker, web server)      │
                  │                                                │
                  │   provides via injection:                      │
                  │     Filesystem, Terminal, Permissioner,        │
                  │     SessionStore, ModelAuth, Clock, Env        │
                  └───────────────────────┬────────────────────────┘
                                          │
                            HostBindings (typed, in-process)
                                          │
                  ┌───────────────────────▼────────────────────────┐
                  │                bodhi-pi core                   │
                  │                                                │
                  │   AgentSession — tool-loop orchestration       │
                  │   Built-in tools (read/write/edit/list/...)    │
                  │   Skill / extension runtime (standalone JS)    │
                  │   Compaction, sessions, fork, clone            │
                  │                                                │
                  │   depends only on: pi-agent-core, pi-ai        │
                  └────────────────────┬───────────────────────────┘
                                       │
                  AgentEvents.onSessionUpdate(...)  ← streamed events
                                       │
                  ┌────────────────────▼───────────────────────────┐
                  │   Optional ACP wire adapter                    │
                  │   (stdio JSON-RPC / WebSocket / HTTP-SSE)      │
                  └────────────────────────────────────────────────┘
```

Built-in tools never touch `node:fs` or `child_process`. They route through the injected `Filesystem` and `Terminal`. The host owns I/O; the agent owns reasoning.

---

## 3. Public API

```ts
export interface HostBindings {
  fs: Filesystem;
  terminal?: Terminal;          // omit on hosts with no shell capability
  permission: Permissioner;
  sessionStore: SessionStore;
  modelAuth: ModelAuth;
  clock: () => Date;
  env: (key: string) => string | undefined;
}

export interface BodhiPiAgent {
  initialize(): Promise<AgentCapabilities>;
  newSession(opts: NewSessionOpts): Promise<SessionId>;
  loadSession(id: SessionId): Promise<void>;
  closeSession(id: SessionId): Promise<void>;
  prompt(sessionId: SessionId, input: PromptInput): Promise<PromptResult>;
  cancel(sessionId: SessionId): Promise<void>;
  setMode(sessionId: SessionId, mode: string): Promise<void>;
  fork(sessionId: SessionId): Promise<SessionId>;
  clone(sessionId: SessionId): Promise<SessionId>;
  compact(sessionId: SessionId): Promise<void>;

  onSessionUpdate(cb: (e: SessionUpdate) => void): Disposable;
}

export function createBodhiPiAgent(host: HostBindings, options?: BodhiPiOptions): BodhiPiAgent;
```

The same `BodhiPiAgent` powers all three runtime targets:

- **Node CLI host** — calls `agent.prompt(...)` directly; renders `onSessionUpdate` events through its own UI.
- **Browser worker host** — same API in a Web Worker; UI thread talks to the worker via `postMessage` / `MessagePort`.
- **Web server host** — same API behind a WebSocket (long-lived) or HTTP/SSE (stateless; agent rehydrates per request via `SessionStore`).

---

## 4. Filesystem interface

```ts
export interface Filesystem {
  readTextFile(path: string, opts?: { line?: number; limit?: number }): Promise<string>;
  writeTextFile(path: string, content: string): Promise<void>;
  list(path: string): Promise<DirEntry[]>;
  stat(path: string): Promise<FileStat>;
  delete(path: string, opts?: { recursive?: boolean }): Promise<void>;
  exists(path: string): Promise<boolean>;

  // Optional capabilities — agents must degrade when absent.
  readBinaryFile?(path: string): Promise<Uint8Array>;
  writeBinaryFile?(path: string, data: Uint8Array): Promise<void>;
  watch?(path: string, cb: (event: WatchEvent) => void): Disposable;
  rename?(from: string, to: string): Promise<void>;
}

export interface FilesystemCapabilities {
  read: boolean; write: boolean; list: boolean; stat: boolean;
  delete: boolean; exists: boolean;
  binary?: boolean; watch?: boolean; atomicRename?: boolean;
}
```

**Path semantics:**
- All paths absolute, POSIX-style (`/`-separated).
- Root is host-defined: `/` on Node, the picked directory on Chrome FS-Access, the OPFS root, or an S3 prefix.
- No symlink-following guarantees.
- No atomic-write guarantee unless host advertises `atomicRename`.

**Reference impls to ship:**
- `Filesystem` over `node:fs/promises` — for Node CLI / web server hosts.
- `Filesystem` over OPFS (`navigator.storage.getDirectory()`) — for browser worker, sandboxed.
- `Filesystem` over Chrome File System Access API (`showDirectoryPicker`) — for browser worker, user-selected folder.
- In-memory `Filesystem` — for tests.

All four pass the same conformance test suite.

---

## 5. Terminal interface

```ts
export interface Terminal {
  create(req: {
    command: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
  }): Promise<TerminalHandle>;
}

export interface TerminalHandle {
  output(): Promise<{ stdout: string; stderr: string; exitCode: number | null }>;
  waitForExit(): Promise<{ exitCode: number; signal: string | null }>;
  kill(signal?: string): Promise<void>;
  release(): Promise<void>;
}
```

The bash tool is registered **only when** the host injects a `Terminal`. Browser hosts that ship `just-bash/browser` register it; sandboxed hosts that omit `Terminal` don't expose bash to the model at all (no runtime errors, no hallucinated calls).

**Reference impls:**
- Node CLI — wrap `node:child_process.spawn`.
- Browser — `just-bash/browser`, a limited browser-side bash supporting safe built-ins (no OS spawn).
- Web server — gated `child_process.spawn` with allow-list; or omit entirely.

---

## 6. Permission interface

```ts
export interface Permissioner {
  request(req: {
    kind: "tool" | "fs.write" | "shell" | "network";
    detail: unknown;
    risk: "low" | "medium" | "high";
  }): Promise<"allow" | "allow_session" | "deny">;
}
```

When wrapped in the ACP wire adapter, this is exposed as ACP `session/request_permission`. CLI hosts implement with a TUI prompt; browsers with a modal; servers with a queue or webhook.

---

## 7. Session store

```ts
export interface SessionStore {
  create(meta: SessionMeta): Promise<SessionId>;
  load(id: SessionId): Promise<SessionRecord>;
  append(id: SessionId, entry: SessionEntry): Promise<void>;
  list(filter?: SessionFilter): Promise<SessionMeta[]>;
  fork(id: SessionId, fromEntryId?: string): Promise<SessionId>;
  clone(id: SessionId): Promise<SessionId>;
  delete(id: SessionId): Promise<void>;
}
```

Storage is the host's choice: JSONL files (Node), IndexedDB (browser main thread), OPFS (browser worker), or DB (server). Entry shape ports from coding-agent (`SessionMessageEntry`, `CompactionEntry`, `BranchSummaryEntry`, etc.) — same semantics, store-agnostic.

---

## 8. Extensions

Single-file ESM modules that default-export a factory:

```js
export default function ({ tools, events, fs, terminal, ui, host }) {
  tools.register({ name: "lint", schema: { /* ... */ }, handler: async (args) => { /* ... */ } });
  events.onTurnEnd(() => { /* ... */ });
}
```

- **Pure JavaScript only.** No TypeScript at runtime, no jiti, no virtual modules.
- The factory context exposes the same surface across all hosts.
- **Loaders are pluggable per runtime:** Node uses dynamic `import()` of file paths; browser uses `import()` of blob URLs or fetched module text (optionally sandboxed via `iframe` + `MessageChannel`); server hosts may load from a registry behind an isolate.
- Skill discovery (SKILL.md format and skill markdown blocks) ports from coding-agent.

---

## 9. ACP wire adapter

A thin adapter, separate package or sub-module, that exposes `BodhiPiAgent` as an ACP server:

| Direction | ACP method | Maps to |
|---|---|---|
| client→agent | `initialize` | `agent.initialize()` |
| client→agent | `session/new` | `agent.newSession(...)` |
| client→agent | `session/load` | `agent.loadSession(...)` |
| client→agent | `session/list` | `host.sessionStore.list(...)` |
| client→agent | `session/close` | `agent.closeSession(...)` |
| client→agent | `session/prompt` | `agent.prompt(...)` |
| client→agent | `session/cancel` | `agent.cancel(...)` |
| agent→client (notification) | `session/update` | `agent.onSessionUpdate(...)` events |
| agent→client | `session/request_permission` | `host.permission.request(...)` results bridged out |

ACP's `fs/*` and `terminal/*` methods are intentionally **not implemented**. bodhi-pi uses its injected interfaces in-process; it does not call back to the ACP client for file or shell I/O. This is documented in `ai-docs/plans/skipped.md`.

Transports: stdio (default), WebSocket, HTTP/SSE. Wire validation against the upstream ACP `schema.json` is part of the test suite.

---

## 10. TDD strategy

| Layer | Test |
|---|---|
| **Filesystem conformance** | One suite, runs against every concrete `Filesystem` impl (Node, OPFS, FS-Access, in-memory). |
| **Terminal conformance** | Same pattern for `Terminal` impls. |
| **SessionStore conformance** | Replay / append / list / fork / clone semantics. |
| **Agent loop golden traces** | `(input, model-stub-tape) → (event sequence, final state)`. Model layer mocked deterministically. |
| **ACP wire compatibility** | Validate every emitted message against upstream `schema.json`. Black-box client test using `@agentclientprotocol/sdk`. |
| **Host-binding end-to-end** | Per concrete host: `create session → prompt → assert observable side-effect via the host's own filesystem/terminal`. Catches abstraction leaks in either direction. |

Tests are written first; implementation follows.

---

## 11. Runtime targets

| Runtime | Filesystem | Terminal | SessionStore |
|---|---|---|---|
| **Node CLI host** | `node:fs/promises` impl | `child_process.spawn` impl | JSONL files |
| **Browser worker — user folder** | Chrome File System Access (`FileSystemDirectoryHandle` walker) | `just-bash/browser` (limited) | IndexedDB or OPFS |
| **Browser worker — sandboxed** | OPFS (`FileSystemSyncAccessHandle` in dedicated worker) | `just-bash/browser` (limited) | OPFS |
| **Web server — long-lived WS** | server-local fs or S3 | gated `child_process.spawn` or omitted | DB-backed |
| **Web server — stateless HTTP/SSE** | server-local fs or S3 | optional | DB-backed; agent rehydrates per call |

Same core, five host wirings.

---

## 12. Milestones

See [`ai-docs/milestones.md`](../milestones.md) for the current milestone status (completed, in-progress, and planned).

---

## 13. References

- [Agent Client Protocol — docs](https://agentclientprotocol.com/)
- [ACP — File System spec](https://agentclientprotocol.com/protocol/file-system)
- [ACP — Schema](https://agentclientprotocol.com/protocol/schema)
- [`@agentclientprotocol/sdk`](https://www.npmjs.com/package/@agentclientprotocol/sdk)
- [Chrome — File System Access API](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access)
- [MDN — Origin Private File System](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system)
- Internal: `packages/coding-agent/src/core/agent-session.ts`, `packages/coding-agent/src/core/tools/index.ts`, `packages/coding-agent/docs/sdk.md`, `packages/coding-agent/docs/rpc.md`
