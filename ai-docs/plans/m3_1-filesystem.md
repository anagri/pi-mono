# Plan — Milestone M3.1: Filesystem interface + 6 built-in FS tools

## Context

Until now, bodhi-pi sessions have been pure chat — text in, text out. The agent has no way to inspect or modify the host's environment. M3.1 changes that: the agent gains the ability to **read, write, edit, list, find, and grep files** through a host-injected `Filesystem` interface.

This is foundational. Filesystem is the prerequisite for skills (`SKILL.md` / `AGENTS.md` walk), prompt templates (file-loaded slash commands), settings layering (`~/.bodhi-pi/settings.json` + project-level merge), extensions (loaded from disk), and disk-backed `SessionStore` (M2.3). It is also the first milestone where bodhi-pi makes substantive use of `pi-agent-core`'s tool-call mechanics, and the first time tool execution surfaces over the ACP wire as `tool_call` / `tool_call_update` `session/update` notifications.

Three architectural choices the user has confirmed for this milestone:

1. **Single mandatory `Filesystem` interface, host-injected.** Same no-fallback pillar as `SessionStore`. The factory throws if absent.
2. **We do NOT implement ACP `fs/read_text_file` / `fs/write_text_file`.** Those are a *different* protocol mechanism — they let an agent fetch files from the *client* (e.g., browser-side IDE files). bodhi-pi's agent owns the filesystem the host hands it and accesses it directly. This is intentional and orthogonal to ACP.
3. **All six tools land in this single milestone.** `read`, `write`, `edit`, `ls`, `find`, `grep` — a complete coding-agent-parity FS toolset, with `find` and `grep` implemented in pure JS (no shelling out to `fd` / `rg`).

We defer permission gating (`session/request_permission`) to a later milestone — writes happen unconditionally for now.

## Decisions (confirmed)

- **Mandatory `BodhiPiConfig.filesystem: Filesystem`** — no default fallback. Factory throws if missing. Same pattern as `sessionStore`.
- **Reference helper: `createInMemoryFilesystem(): Filesystem`** — hand-rolled Map-backed impl, ~100 lines, zero new dependencies. (We do **not** pull in `@zenfs/core` for this milestone — see "Why not ZenFS" below.)
- **Single `Filesystem` interface**, not coding-agent's per-tool `*Operations` pattern. coding-agent splits into `ReadOperations`, `WriteOperations`, `EditOperations`, etc., because each tool ships a Node-`fs` default. Since bodhi-pi has no defaults, the per-tool split is pure ceremony and we collapse it to one interface.
- **Pure-JS `find` and `grep`.** Walk directories via `Filesystem.list` + `Filesystem.stat`; match with `picomatch` for globs and native `RegExp` for grep. Browser-portable; no `child_process` dependence.
- **Tools registered once per session** at `newSession` / `loadSession` time, passed to `pi-agent-core` via `Agent.state.tools`. Same lifecycle as the model.
- **All six tools always registered** — no capability-conditional gating in this milestone. (Capability-conditional registration arrives with `Terminal` in M4.1.)
- **Tool replay during `session/load`.** The deferred-from-M2.1 tool-call replay lands here. Persisted tool calls / tool results stream back as `tool_call` notifications with `status: "completed"`, then their tool-result `content` is attached.
- **Path policy:** all tool paths are normalised to absolute via `path.resolve(cwd, userPath)`. No traversal guard in this milestone — hosts that need sandboxing wrap our `Filesystem` impl. (We mirror coding-agent's behaviour here exactly: see `path-utils.ts:54-60` — no `..` guard, deliberate.)
- **No permission round-trip.** `write` and `edit` execute immediately. Permissions land as a dedicated future milestone; hosts that want gating today can wrap `Filesystem` with their own write-blocker.

## Why not ZenFS for the in-memory reference impl

ZenFS is a fine library, but for this milestone:

- It's LGPL-3.0-or-later. We track that as an open license question (`ai-docs/plans/deferred.md`); pulling it as a runtime dep of bodhi-pi forces a decision now we'd rather defer.
- The seven primitives we need (`readTextFile`, `writeTextFile`, `list`, `stat`, `exists`, `mkdir`, `remove`) are ~100 lines of TypeScript over a `Map<string, Entry>`. Writing it ourselves is faster than wiring ZenFS isolation per test.
- Production hosts that *want* ZenFS (e.g., the future browser-worker host using OPFS via `@zenfs/dom`) write a ~30-line adapter from ZenFS's `fs.promises` to our `Filesystem` interface. The cost is paid once in the host, not in bodhi-pi.

We keep the `@zenfs/core` evaluation in `ai-docs/plans/deferred.md` for the browser-worker host milestone (Phase 13).

## ACP scope cut-list

| Method / notification | Direction | M3.1 status | Capability flag |
|---|---|---|---|
| `session/prompt` | client→agent | already done — extend so tool calls surface as notifications | n/a |
| `session/update` — `tool_call` | agent→client | **new in M3.1** — emitted when tool execution starts | n/a |
| `session/update` — `tool_call_update` | agent→client | **new in M3.1** — emitted when tool execution progresses / completes | n/a |
| `session/load` | client→agent | already done — extend to also replay persisted tool calls as `tool_call` notifications | `loadSession` (already advertised) |
| `session/request_permission` | agent→client | **deferred** — writes happen unconditionally | n/a |
| `fs/read_text_file`, `fs/write_text_file` | agent→client | **out of scope** — different mechanism (client-mediated FS); we do not implement | n/a |

`initialize` capabilities **do not change** in this milestone. Tools are always available; nothing new to advertise.

## The `Filesystem` interface

A single, narrow façade. Methods are async and use absolute paths.

```ts
// src/filesystem/filesystem.ts

export interface DirEntry {
	name: string;
	isFile: boolean;
	isDirectory: boolean;
}

export interface FileStat {
	isFile: boolean;
	isDirectory: boolean;
	size: number;
	mtimeMs: number;
}

export interface Filesystem {
	/** Read a UTF-8 text file. Rejects if the path is missing or is a directory. */
	readTextFile(absolutePath: string): Promise<string>;

	/** Overwrite (or create) a UTF-8 text file. Caller must ensure parent dir exists. */
	writeTextFile(absolutePath: string, content: string): Promise<void>;

	/** Direct children of the directory. Rejects if path is not a directory. */
	list(absolutePath: string): Promise<DirEntry[]>;

	/** stat — rejects if path doesn't exist. */
	stat(absolutePath: string): Promise<FileStat>;

	/** Cheap existence check. Never rejects; returns false on any error. */
	exists(absolutePath: string): Promise<boolean>;

	/** Create directory. `recursive: true` is no-op if it exists. */
	mkdir(absolutePath: string, opts?: { recursive?: boolean }): Promise<void>;

	/** Delete file or directory. `recursive: true` removes a non-empty dir. */
	remove(absolutePath: string, opts?: { recursive?: boolean }): Promise<void>;
}
```

Decisions baked in:
- **UTF-8 text only.** Binary / image / streaming reads are deferred. The `read` tool is restricted to text in M3.1; image-mime sniff (coding-agent's `read.ts:51-55`) is not ported.
- **Absolute paths only.** Tool layer normalises `userPath → path.resolve(cwd, userPath)` before calling. The interface does no path arithmetic.
- **No batching, no streaming.** Every call is a discrete promise. `find` / `grep` walk via repeated `list` calls — slower in big trees, but trivially portable.
- **No `chmod` / `symlink` / `chown` / `realpath`.** Hosts that need them add bodhi-pi-private extension methods later if some tool demands it.

## In-memory reference implementation

```ts
// src/filesystem/in-memory-filesystem.ts

import path from "node:path";
import type { DirEntry, Filesystem, FileStat } from "./filesystem.js";

type Entry =
	| { type: "file"; content: string; mtimeMs: number }
	| { type: "dir"; mtimeMs: number };

export function createInMemoryFilesystem(): Filesystem {
	const entries = new Map<string, Entry>();
	entries.set("/", { type: "dir", mtimeMs: Date.now() });

	const norm = (p: string) => path.posix.normalize(p);

	function ensureParentDir(p: string) {
		const parent = path.posix.dirname(p);
		const e = entries.get(parent);
		if (!e || e.type !== "dir") {
			throw Object.assign(new Error(`ENOENT: parent dir missing: ${parent}`), { code: "ENOENT" });
		}
	}

	return {
		async readTextFile(p) {
			const e = entries.get(norm(p));
			if (!e) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
			if (e.type !== "file") throw Object.assign(new Error(`EISDIR: ${p}`), { code: "EISDIR" });
			return e.content;
		},
		async writeTextFile(p, content) {
			const np = norm(p);
			ensureParentDir(np);
			entries.set(np, { type: "file", content, mtimeMs: Date.now() });
		},
		async list(p) {
			const np = norm(p);
			const e = entries.get(np);
			if (!e) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
			if (e.type !== "dir") throw Object.assign(new Error(`ENOTDIR: ${p}`), { code: "ENOTDIR" });
			const prefix = np === "/" ? "/" : `${np}/`;
			const out: DirEntry[] = [];
			for (const [k, v] of entries) {
				if (k === np) continue;
				if (!k.startsWith(prefix)) continue;
				const rest = k.slice(prefix.length);
				if (rest.includes("/")) continue;
				out.push({ name: rest, isFile: v.type === "file", isDirectory: v.type === "dir" });
			}
			return out.sort((a, b) => a.name.localeCompare(b.name));
		},
		async stat(p) {
			const e = entries.get(norm(p));
			if (!e) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
			return {
				isFile: e.type === "file",
				isDirectory: e.type === "dir",
				size: e.type === "file" ? e.content.length : 0,
				mtimeMs: e.mtimeMs,
			};
		},
		async exists(p) {
			return entries.has(norm(p));
		},
		async mkdir(p, opts) {
			const np = norm(p);
			if (entries.has(np)) {
				if (opts?.recursive) return;
				throw Object.assign(new Error(`EEXIST: ${p}`), { code: "EEXIST" });
			}
			if (opts?.recursive) {
				const parts = np.split("/").filter(Boolean);
				let cur = "";
				for (const part of parts) {
					cur += `/${part}`;
					if (!entries.has(cur)) entries.set(cur, { type: "dir", mtimeMs: Date.now() });
				}
				return;
			}
			ensureParentDir(np);
			entries.set(np, { type: "dir", mtimeMs: Date.now() });
		},
		async remove(p, opts) {
			const np = norm(p);
			const e = entries.get(np);
			if (!e) return;
			if (e.type === "dir" && !opts?.recursive) {
				const prefix = np === "/" ? "/" : `${np}/`;
				for (const k of entries.keys()) {
					if (k !== np && k.startsWith(prefix)) {
						throw Object.assign(new Error(`ENOTEMPTY: ${p}`), { code: "ENOTEMPTY" });
					}
				}
			}
			entries.delete(np);
			if (opts?.recursive) {
				const prefix = np === "/" ? "/" : `${np}/`;
				for (const k of [...entries.keys()]) if (k.startsWith(prefix)) entries.delete(k);
			}
		},
	};
}
```

## The 6 tools

All tools live under `src/tools/`. Each module exports a TypeBox schema (matching coding-agent's pattern) and a factory `createXTool(deps): Tool` that returns a `pi-agent-core`-compatible tool object.

We use `typebox` (^1.1.24) for schemas — same package coding-agent uses (`packages/coding-agent/src/core/tools/read.ts:7`) and that pi-agent-core re-exports types from. **Note:** this is `typebox`, not `@sinclair/typebox` — they are different packages.

We use `picomatch` for glob matching in `find` (and optional glob filter in `grep`). It's ~30 KB, zero deps, MIT, and battle-tested.

Constants ported verbatim from coding-agent (`src/core/tools/truncate.ts:11-13`):

```ts
const READ_MAX_LINES = 2000;
const READ_MAX_BYTES = 50_000;
const FIND_MAX_RESULTS = 1000;
const FIND_MAX_BYTES = 50_000;
const GREP_MAX_MATCHES = 100;
const GREP_MAX_BYTES = 50_000;
const GREP_MAX_LINE_LENGTH = 500;
const LS_MAX_ENTRIES = 500;
const LS_MAX_BYTES = 50_000;
```

### `read`

- Schema: `{ path: string, offset?: integer (default 0), limit?: integer (default 2000) }`
- Behaviour: read file → split lines → slice `[offset, offset+limit)` → join → truncate to `READ_MAX_BYTES`
- ToolKind hint: `"read"`
- Output: text content with optional truncation marker
- Source pattern: `packages/coding-agent/src/core/tools/read.ts:205-358`

### `write`

- Schema: `{ path: string, content: string }`
- Behaviour: `mkdir(parent, recursive: true)` → `writeTextFile(path, content)`
- ToolKind hint: `"edit"` (matches coding-agent's classification)
- Output: short confirmation `"Wrote N bytes to <path>"`. We do **not** emit a `diff` tool-content block in M3.1 (deferred to permissions milestone).
- Source pattern: `packages/coding-agent/src/core/tools/write.ts:181-281`
- We do **not** port `withFileMutationQueue` — `pi-agent-core` serialises tool calls per session, so concurrent writes within a session are already impossible; cross-session contention is the host's problem.

### `edit`

- Schema: `{ path: string, edits: Array<{ oldText: string, newText: string }> }`
- Behaviour: `readTextFile(path)` → for each edit, find unique `oldText` and replace with `newText`; error if not found or not unique → `writeTextFile(path, newContent)`
- ToolKind hint: `"edit"`
- Output: short confirmation summarising N edits applied
- Source pattern: `packages/coding-agent/src/core/tools/edit.ts:31-51` (schema), main execute body

### `ls`

- Schema: `{ path: string, limit?: integer (default 500) }`
- Behaviour: `list(path)` → for each entry, `stat` to get size & type → format as `"name<TAB>type<TAB>size"` → truncate to `LS_MAX_ENTRIES` / `LS_MAX_BYTES`
- ToolKind hint: `"search"`
- Source pattern: `packages/coding-agent/src/core/tools/ls.ts:99-160`

### `find`

- Schema: `{ pattern: string, path: string, limit?: integer (default 1000) }` — `pattern` is a glob (e.g., `**/*.ts`)
- Behaviour: pure-JS recursive walk via `list` + `stat`; match each candidate against `picomatch(pattern)`; truncate to `FIND_MAX_RESULTS` / `FIND_MAX_BYTES`
- ToolKind hint: `"search"`
- Source pattern: `packages/coding-agent/src/core/tools/find.ts:112-185` (schema + result-shaping; we replace the `fd` shell-out with the JS walker)

### `grep`

- Schema: `{ pattern: string, path: string, glob?: string, ignoreCase?: boolean, literal?: boolean, context?: integer, limit?: integer (default 100) }`
- Behaviour:
  1. Walk dir tree (same JS walker as `find`); optionally filter via `picomatch(glob)`.
  2. For each text file, `readTextFile` → split lines → match each line against `RegExp(pattern, ignoreCase ? "i" : "")` (or `literal`-quoted).
  3. Emit `path:line:text` for each match; cap line text at `GREP_MAX_LINE_LENGTH`.
  4. Stop after `GREP_MAX_MATCHES` or `GREP_MAX_BYTES`.
- ToolKind hint: `"search"`
- Source pattern: `packages/coding-agent/src/core/tools/grep.ts:122-245` (schema + result-shaping; we replace the `rg` shell-out with the JS line-matcher)
- Skip non-text files via a tiny binary-sniff (first 512 bytes, look for NUL byte). Defer fancier MIME detection.

## Tool registration & path policy

A new module wires the six tools to a per-session `Filesystem`:

```ts
// src/tools/index.ts

import path from "node:path";
import type { Filesystem } from "../filesystem/filesystem.js";

export interface ToolDeps {
	filesystem: Filesystem;
	cwd: string;
}

/** Returns the array passed to pi-agent-core's `Agent.state.tools`. */
export function createBuiltinTools(deps: ToolDeps): Tool[] {
	return [
		createReadTool(deps),
		createWriteTool(deps),
		createEditTool(deps),
		createLsTool(deps),
		createFindTool(deps),
		createGrepTool(deps),
	];
}

/** Internal helper used by every tool to normalise user-supplied paths. */
export function resolvePath(cwd: string, userPath: string): string {
	return path.resolve(cwd, userPath);
}
```

The exact `Tool` shape comes from `pi-agent-core` (`packages/agent/src/types.ts` exports `AgentTool` / similar); the implementation reads it directly from the workspace package rather than redefining.

`BodhiPiAcpAgent` constructs the tools at the same lifecycle points where it constructs the per-session `pi-agent-core` `Agent`:

- In `newSession`: `tools = createBuiltinTools({ filesystem: config.filesystem, cwd: params.cwd })`, threaded into `createAgentSession({ initialState: { model, tools } })`.
- In `loadSession` / `resumeSession`: same, with the rehydrated `cwd` from the `SessionRecord`.

## ACP wire surface — emitting tool execution

bodhi-pi today subscribes to `pi-agent-core`'s `text_delta` events and forwards them as ACP `agent_message_chunk` notifications (`packages/bodhi-pi/src/acp/agent.ts:237-249`). We extend that subscription to also handle tool execution events.

`pi-agent-core` emits structured tool events through its `subscribe()` callback. For each tool call:

1. **Start:** emit `session/update` with `sessionUpdate: "tool_call"`, fields `{ toolCallId, title: "Read /path", kind: "read" | "edit" | "search", status: "in_progress", rawInput: <args>, locations?: [{ path }] }`.
2. **Completion:** emit `session/update` with `sessionUpdate: "tool_call_update"`, fields `{ toolCallId, status: "completed" | "failed", content: [{ type: "content", content: { type: "text", text: <result> } }], rawOutput: <result> }`.
3. On failure, `status: "failed"` and `content` carries the error message text.

The exact pi-agent-core event names will be verified during implementation by reading `packages/agent/src/types.ts:374` (the `AgentEvent` union) and following `coding-agent`'s subscription site for reference.

`tool_call` and `tool_call_update` SDK shapes confirmed at `/tmp/acp-sdk-inspect/package/dist/schema/types.gen.d.ts:4885-4930` and `:4994-5037`.

## Tool replay during `session/load`

M2.1 deferred tool/toolResult replay "to M3.x when tools exist" (`packages/bodhi-pi/src/acp/agent.ts:144`). Now is M3.x. Extending `loadSession`:

For each persisted entry whose `message.role` is `assistant` carrying tool-use blocks, OR `toolResult`:

- Emit `tool_call` with `status: "completed"` and `content` reconstructed from the persisted tool result.
- The `toolCallId` is the original ID stored in the message.

`SessionEntry`'s `message` already carries the full `AgentMessage` from `pi-agent-core`, so the data is there — we just walk content blocks and translate the tool-use / tool-result variants into ACP notifications. No new `SessionEntry` variant needed for M3.1.

The `extractText` helper in `acp/agent.ts:323` is generalised to also return tool-call structures.

## Architecture delta

```
BodhiPiConfig {
    models: Model<Api>[]
    defaultModelId: string
    getApiKey: (provider) => string | undefined
    sessionStore: SessionStore
+   filesystem: Filesystem            // mandatory; no default
}

BodhiPiAcpAgent {
    sessions = Map<sessionId, {
        piAgent: PiAgent,
        currentModelId: string,
        cwd: string,
+       tools: Tool[],                // built per session from filesystem + cwd
    }>

    initialize       // unchanged in M3.1
    newSession       // also constructs tools from filesystem+cwd
    loadSession      // also constructs tools; replays tool_call notifications
    resumeSession    // also constructs tools (no replay)
    listSessions     // unchanged
    closeSession     // unchanged
    extMethod        // unchanged
    setSessionConfigOption   // unchanged
    prompt           // tool execution events forwarded as tool_call / tool_call_update
    cancel           // unchanged
}
```

## Files

### New

- `packages/bodhi-pi/src/filesystem/filesystem.ts` — `Filesystem` interface + `DirEntry` / `FileStat` types.
- `packages/bodhi-pi/src/filesystem/in-memory-filesystem.ts` — `createInMemoryFilesystem()` reference helper.
- `packages/bodhi-pi/src/tools/index.ts` — `createBuiltinTools({ filesystem, cwd })` + `resolvePath` helper + shared truncation constants.
- `packages/bodhi-pi/src/tools/read.ts`, `write.ts`, `edit.ts`, `ls.ts`, `find.ts`, `grep.ts` — one tool per file.
- `packages/bodhi-pi/src/tools/walk.ts` — internal directory-tree walker shared by `find` and `grep` (post-order traversal via `Filesystem.list` + `stat`, with `picomatch` glob filter).
- `packages/bodhi-pi/test/fs.test.ts` — integration tests (aimock + ACP) for all 6 tools, error paths, and tool-call replay.
- `packages/bodhi-pi/e2e/fs.e2e.ts` — e2e tests against real LLM exercising end-to-end read/write/grep round-trips.

### Modified

- `packages/bodhi-pi/src/index.ts` — export `Filesystem`, `DirEntry`, `FileStat`, `createInMemoryFilesystem`. Tool internals stay private.
- `packages/bodhi-pi/src/acp/agent.ts` — add mandatory `filesystem` to `BodhiPiConfig`; build `tools` per session; subscribe to tool events in `prompt`; replay tool calls in `loadSession`.
- `packages/bodhi-pi/test/chat.test.ts` — pass `filesystem: createInMemoryFilesystem()` in every existing test's `BodhiPiConfig`.
- `packages/bodhi-pi/e2e/chat.e2e.ts` — same.
- `packages/bodhi-pi/package.json` — add `typebox` (^1.1.24) and `picomatch` (+ `@types/picomatch` devDep) as direct deps.
- `packages/bodhi-pi/CHANGELOG.md` — M3.1 entry.

### Untouched

- `packages/bodhi-pi/src/sessions/*` — no schema change.
- `packages/bodhi-pi/test/helpers/in-process-connection.ts` — unchanged.
- `vitest.config.ts`, `vitest.e2e.config.ts`, env files, root configs.

## Test plan

### Integration (`test/fs.test.ts`) — new file

Each test creates a fresh `createInMemoryFilesystem()`, seeds it as needed, and drives the agent through one ACP round-trip. aimock returns scripted tool calls.

| # | Name | What it asserts |
|---|---|---|
| 1 | `read returns file contents` | aimock returns `tool_call(read, {path: "/notes.txt"})` then `"done"`; FS pre-seeded with `/notes.txt`; assert one `tool_call` notification with `kind: "read"`, one `tool_call_update` with `status: "completed"` and content matching the file text. |
| 2 | `read of missing file fails gracefully` | aimock calls `read("/no.txt")`; assert `tool_call_update` with `status: "failed"` and error text. |
| 3 | `write creates a new file` | aimock calls `write({path: "/out.txt", content: "hi"})`; assert `filesystem.exists("/out.txt") === true`, content match, `tool_call_update` status completed. |
| 4 | `write creates parent directories` | path `/sub/dir/out.txt`, parent doesn't exist; assert it's created and write succeeds. |
| 5 | `edit replaces unique substring` | seed `/code.txt = "foo bar baz"`; aimock calls `edit(path, [{oldText: "bar", newText: "BAR"}])`; assert FS contents now `"foo BAR baz"`. |
| 6 | `edit fails on non-unique match` | seed file with two occurrences; assert `tool_call_update` failed with informative error. |
| 7 | `ls lists directory entries` | seed FS with 3 files + 1 subdir; assert formatted output enumerates all 4 entries with correct types. |
| 8 | `find returns matching files` | seed 5 `.ts` and 3 `.md` files in a tree; aimock calls `find(pattern: "**/*.ts", path: "/")`; assert 5 results returned. |
| 9 | `find respects limit` | seed 50 matching files, limit=10; assert 10 results + truncation marker. |
| 10 | `grep finds matches with file:line` | seed 3 files containing `"needle"` on different lines; assert exactly 3 lines emitted in `path:line:text` format. |
| 11 | `grep with glob filter` | seed `.ts` and `.md` matches; pass `glob: "**/*.ts"`; assert only `.ts` matches returned. |
| 12 | `grep skips binary files` | seed a file with embedded NUL bytes; assert it's skipped. |
| 13 | `tool calls replay on session/load` | run a session with one write tool call; close it; load it in a fresh client; assert `tool_call` notification with `status: "completed"` is emitted in correct order with the user/agent message chunks. |

Each test uses `createBodhiPiAgent({ ..., filesystem })` with a per-test `Filesystem`. aimock fixture style follows existing `chat.test.ts`. No `if-else` in tests — `expect(value, "diagnostic").toBe(...)` with helper narrowing.

Existing tests in `chat.test.ts` get a one-line edit per test to pass `filesystem: createInMemoryFilesystem()`.

### E2E (`e2e/fs.e2e.ts`) — new file

Real LLMs (Anthropic Haiku + OpenAI gpt-5-mini). Side-effect assertions, not exact-text:

| # | Name | What it asserts |
|---|---|---|
| 1 | `Haiku writes a file then reads it back` | one session, two prompts: (1) `"Write the text 'hello world' to /out.txt"`, (2) `"Read /out.txt and reply with its exact contents"`. Assert `filesystem.readTextFile("/out.txt") === "hello world"` after step 1; assert step-2 response contains `"hello world"`. |
| 2 | `Haiku finds a string with grep` | seed FS with three files, one containing `"banana"`. Prompt: `"Use grep to find which file contains 'banana' and reply with just the file path."`. Assert response contains the seeded path. |

Existing 4 e2e tests each get one-line `filesystem: createInMemoryFilesystem()` edit. Total e2e tests after M3.1: 6.

## CHANGELOG entry

```
## [Unreleased]

### Added
- M3.1 — Filesystem interface + 6 built-in FS tools. New mandatory
  `BodhiPiConfig.filesystem: Filesystem` (no default fallback). Ships
  `createInMemoryFilesystem()` as a public reference helper. Tools `read`,
  `write`, `edit`, `ls`, `find`, `grep` are always registered per session
  and route every FS call through the injected `Filesystem`. `find` and
  `grep` are pure-JS (no `fd` / `rg` shell-out). Tool execution surfaces
  over the wire as ACP `tool_call` / `tool_call_update` `session/update`
  notifications. `session/load` now replays persisted tool calls in
  addition to user/agent message chunks. We deliberately do NOT implement
  ACP `fs/read_text_file` / `fs/write_text_file` — those are a separate
  client-mediated FS mechanism, orthogonal to bodhi-pi's host-injected
  Filesystem.
```

## Implementation steps

1. Add `typebox` and `picomatch` (+ `@types/picomatch`) to `packages/bodhi-pi/package.json`; `npm install`.
2. Create `src/filesystem/filesystem.ts` (interface + types).
3. Create `src/filesystem/in-memory-filesystem.ts` (`createInMemoryFilesystem`).
4. Create `src/tools/walk.ts` (shared dir walker).
5. Create the 6 tool files: `src/tools/{read,write,edit,ls,find,grep}.ts` and `src/tools/index.ts`.
6. Wire `BodhiPiConfig.filesystem` into `src/acp/agent.ts`:
   - Mandatory check in `createBodhiPiAgent`.
   - Build `tools` in `newSession`, `loadSession`, `resumeSession`.
   - Pass `tools` into `createAgentSession({ initialState: { model, messages, tools } })`.
   - In `prompt`, extend the existing event subscription to forward tool execution events as `tool_call` / `tool_call_update`.
   - In `loadSession`, walk persisted entries to also replay tool calls.
7. Update `src/index.ts` exports.
8. Update existing tests (`chat.test.ts` + `chat.e2e.ts`) to pass `filesystem`.
9. Write `test/fs.test.ts` (13 integration tests above).
10. Write `e2e/fs.e2e.ts` (2 e2e tests above).
11. Update `CHANGELOG.md`.
12. Update `ai-docs/context.md` §4 progress table + §7 next-milestone preview to point at the next pickable item.
13. Gate-checks (see Verification).
14. Single commit: `feat(bodhi-pi): land M3.1 — filesystem interface + 6 built-in FS tools`.

## Verification

```bash
# Lint + typecheck across the monorepo
npm run check

# Build
npm --workspace @bodhiapp/bodhi-pi run build

# Offline (unit + integration via aimock + ACP)
npm --workspace @bodhiapp/bodhi-pi run test

# Online (real LLMs via ACP)
npm --workspace @bodhiapp/bodhi-pi run test:e2e
```

Expected:
- `npm run check` — clean.
- `build` — emits `dist/{filesystem,tools}/...` plus existing surfaces.
- `test` — 8 (existing chat) + 13 (new fs) = 21 integration tests pass.
- `test:e2e` — 4 (existing chat) + 2 (new fs) = 6 e2e tests pass.

Acceptance gate: an ACP-aware host can drive bodhi-pi through `initialize → newSession → prompt(write) → prompt(read)` against an in-memory `Filesystem`, observe `tool_call` / `tool_call_update` notifications in the right order, and verify the file system mutations.

## Out of scope (and where each lands)

| Concern | Lands in |
|---|---|
| `session/request_permission` round-trip for write/edit | dedicated permissions milestone |
| `Filesystem.readBytes` / image MIME sniff for `read` | when image input lands (v1.1) |
| `withFileMutationQueue` per-file mutex | only if a future milestone surfaces concurrent intra-session writes (won't happen with current pi-agent-core sequential tool execution) |
| Path traversal sandbox / chroot guard | host concern; hosts wrap `Filesystem` to enforce |
| `Tool.toolCallContent` `diff` blocks (showing old → new) | permissions milestone (paired with diff-preview) |
| Disk-backed `Filesystem` impl (Node `fs` adapter) | ships as an example host or in M2.3 (disk-backed `SessionStore`) |
| OPFS / FS-Access / S3 backends | browser-worker host milestone (Phase 13) |
| `bash` tool | M4.1 (`Terminal` interface) |
| Tool-call interception hook for extensions | extensions milestone (Phase 9) |
| Streaming partial reads | when a tool needs them |
| `find` / `grep` performance parity with `fd` / `rg` | not pursued — pure-JS portability beats raw speed for this milestone |

## Critical files referenced

- `packages/coding-agent/src/core/tools/read.ts:19-23` (TypeBox schema), `:42-49` (Operations interface), `:205-358` (execute body).
- `packages/coding-agent/src/core/tools/write.ts:14-17, :25-30, :181-281`.
- `packages/coding-agent/src/core/tools/edit.ts:31-51, :70-77`.
- `packages/coding-agent/src/core/tools/ls.ts:13-16, :31-38, :99-160`.
- `packages/coding-agent/src/core/tools/find.ts:20-26, :41-46, :112-185`.
- `packages/coding-agent/src/core/tools/grep.ts:23-35, :50-55, :122-245`.
- `packages/coding-agent/src/core/tools/truncate.ts:11-13` — limit constants.
- `packages/coding-agent/src/core/tools/index.ts:96-196` — registration factory.
- `packages/coding-agent/src/core/tools/tool-definition-wrapper.ts:5-19` — `wrapToolDefinition` adapter to pi-agent-core.
- `packages/coding-agent/src/core/tools/path-utils.ts:54-60` — `resolveToCwd` (no `..` guard, deliberate).
- `packages/coding-agent/src/core/agent-session.ts:2344-2347` — registration site (`createAllToolDefinitions(cwd, options)`).
- `packages/coding-agent/src/core/agent-session.ts:833` — `agent.state.tools` write-through.
- `packages/agent/src/agent.ts` — `Agent` class; `state.tools` field; `subscribe()` carries tool events.
- `packages/agent/src/types.ts:374` — `AgentEvent` discriminator (verify exact `tool_execution_*` variant names during impl).
- `packages/bodhi-pi/src/acp/agent.ts:144` — current "tool replays land in M3.x" comment we're now resolving.
- `packages/bodhi-pi/src/acp/agent.ts:237-249` — current `text_delta → agent_message_chunk` subscription site we extend.
- `packages/bodhi-pi/src/acp/agent.ts:283-295` — `buildModelConfigOption` shape; pattern reused for tool registration.
- `/tmp/acp-sdk-inspect/package/dist/schema/types.gen.d.ts:4885-4930` — `ToolCall` shape.
- `/tmp/acp-sdk-inspect/package/dist/schema/types.gen.d.ts:4994-5037` — `ToolCallUpdate` shape.
- `/tmp/acp-sdk-inspect/package/dist/schema/types.gen.d.ts:4939-4945` — `ToolCallContent` discriminated union.
- `/tmp/acp-sdk-inspect/package/dist/schema/types.gen.d.ts:4958-4977` — `ToolCallLocation` shape.
- `/tmp/acp-sdk-inspect/package/dist/schema/types.gen.d.ts:5046` — `ToolKind` union.
- `/Users/amir36/Documents/workspace/src/github.com/agentclientprotocol/agent-client-protocol/docs/protocol/tool-calls.mdx:23-106, 229-287, 293-310` — tool execution semantics.
- `/Users/amir36/Documents/workspace/src/github.com/agentclientprotocol/agent-client-protocol/docs/protocol/file-system.mdx:8-26` — `fs/*` is the *other* mechanism we're explicitly NOT implementing.

## After approval

After M3.1 lands, save these durable preferences to memory (project-feedback type):
- bodhi-pi's `Filesystem` is host-injected and **directly accessed** by the agent. We do **not** implement ACP `fs/read_text_file` / `fs/write_text_file` — those are a different mechanism for clients to expose their filesystem to agents (e.g., browser IDE files), orthogonal to our model where the host hands the agent its own filesystem at construction time.
- coding-agent's per-tool `*Operations` split (`ReadOperations`, `WriteOperations`, etc.) is a Node-fallback pattern. bodhi-pi has no fallbacks, so we collapse to a single `Filesystem` interface.
- `find` / `grep` are pure-JS in bodhi-pi (no `fd` / `rg` shell-out) — portability beats speed.
- Tool execution surfaces over ACP as `tool_call` (start) + `tool_call_update` (completion) `session/update` notifications. `session/load` replays completed tool calls inline with the message chunks.
- Path policy mirrors coding-agent: paths normalised via `path.resolve(cwd, userPath)`, no `..` traversal guard. Hosts wrap `Filesystem` for sandboxing if they need it.
