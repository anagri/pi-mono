# Plan — M3.2: Health pass (post-M3.1 cleanup + ACP conformance)

## Context

M3.1 just landed (commit `59741bf8`) — filesystem interface + 6 built-in tools. A subsequent multi-angle health review (`ai-docs/reviews/2026-05-08-bodhi-pi-m3-1-health.md`) surfaced ~25 verified, actionable items across six batches:

- **Batch A** — 6 ACP wire-correctness fixes (stopReason, cancel coordination, userMessageId echo, agentInfo, real updatedAt, omit nextCursor).
- **Batch B** — 7 source-structure cleanups (delete dead wrapper, split `agent.ts`, consolidate subscribes, hide internal types, replace structural casts, drop dead `cursor` param, document throw convention).
- **Batch C** — 3 tool DRY items (truncation helper, marker normalisation, constant rename).
- **Batch D** — 4 test-architecture items (extract helpers, loosen brittle e2e assertion, collapse vitest configs, make NUL byte in binary-skip test visible).
- **Batch E** — ~25 missing unit + integration tests across filesystem, walk, tools, notifications.
- **Batch F** — host-facing gaps: `BodhiPiConfig.systemPrompt`, README usage, JSDoc consistency.

User decisions:
- **Scope:** all six batches.
- **Grouping:** five commits, one per batch (A → B+C → D → E → F).
- **systemPrompt design:** follow coding-agent's pattern, stripped to bodhi-pi's embeddable scope (see Decisions §F.1).

We label the whole pass **M3.2 — Health**. Last commit updates CHANGELOG + context.md.

---

## Decisions (confirmed)

### Per-batch scope

- **Batch A** lands as one commit. Includes integration tests for the new behaviour (cancel → cancelled, stopReason mapping when faux returns `stopReason: "length"`, agentInfo present in initialize response, updatedAt bumps on append).
- **Batches B + C** land as one commit. Pure refactor, zero behaviour change. Existing tests must pass unchanged.
- **Batch D** lands as one commit. Test infra only; no source change.
- **Batch E** lands as one commit. Adds ~25 new unit/integration tests; no source change.
- **Batch F** lands as one commit and closes M3.2. Includes the `systemPrompt` feature, README, JSDoc, plus the consolidated CHANGELOG entry.

### F.1 — systemPrompt design (coding-agent pattern, stripped)

Coding-agent's full builder (`packages/coding-agent/src/core/system-prompt.ts:28-172`) layers a default template, custom override, append section, project context files (AGENTS.md / CLAUDE.md walk), skills, and tool prompt-snippets. It is **not persisted in session entries**; it's rebuilt fresh on load, with extensions allowed to override per-turn via the `before_agent_start` hook.

bodhi-pi has no AGENTS.md walk, no skills system, no extension framework, no `process.cwd()`, no `node:fs` in core. The applicable subset is:

1. **Config-time string passthrough.** New optional field: `BodhiPiConfig.systemPrompt?: string`. Threaded into `Agent`'s `initialState.systemPrompt` in both `newSession` and `rehydrateSession`. If absent, pi-agent-core's default empty string is used.
2. **Not persisted.** Mirrors coding-agent — system prompt is configuration, not session state. `loadSession` and `resumeSession` use the current config's value, same as coding-agent rebuilds fresh on load.
3. **No file-based discovery, no extensions hook, no per-turn override.** Defer until we have an extension system or a real host need. Hosts that want layering compose the string client-side and pass the result.
4. **No tool `promptSnippet`/`promptGuidelines`.** Defer with the rest of the tool-metadata work (when the system-prompt builder lands as a separate feature in a later milestone).

This is the minimum viable for "any host can inject behavioural instructions" without committing to coding-agent's full ResourceLoader / Skills / Extensions surface area.

### Versioning

No package.json version bump in this pass — bodhi-pi is `0.0.1` (pre-publish). CHANGELOG entries collect under the existing `## [Unreleased]` block.

---

## Batch A — ACP wire correctness (Commit 1)

### A.1 — Map `stopReason` from pi-agent-core

**Where:** `acp/agent.ts:343-352`.

**What changes:** track the final `AssistantMessage.stopReason` from pi-agent-core's last turn and map to ACP's enum.

Mapping (per `packages/ai/src/types.ts:212` `StopReason = "stop" | "length" | "toolUse" | "error" | "aborted"`):
- `"aborted"` → ACP `"cancelled"`
- `"length"` → ACP `"max_tokens"`
- `"stop"` / `"toolUse"` → ACP `"end_turn"`
- `"error"` → throw `RequestError` (model error surfaced to client)

Capture the final assistant message inside the `prompt()` flow. The cleanest place is the existing `message_end` subscription (after consolidation in B.3, this becomes one branch of the unified handler): when `event.message.role === "assistant"`, store `lastAssistantStopReason` on a per-call closure, then read it at the return.

### A.2 — `cancel()` coordinates with in-flight `prompt()`

**Where:** `acp/agent.ts:343-356`.

**What changes:** add a per-session `cancelled: boolean` to `SessionState`. Set in `cancel()`. Read at `prompt()`'s return — if set, return `{ stopReason: "cancelled" }` regardless of A.1's mapping. Reset after each `prompt()` settles (so subsequent prompts behave normally).

### A.3 — Echo `userMessageId`

**Where:** `acp/agent.ts:343-346` (return).

**What changes:** `return { stopReason, userMessageId: params.messageId ?? null }`. SDK type at `types.gen.d.ts:3361-3367, 3432`.

### A.4 — `agentInfo` in `InitializeResponse`

**Where:** `acp/agent.ts:84-102`.

**What changes:** read `name` + `version` from `package.json` (use `import { readFile } from "node:fs/promises"` or, simpler, hardcode to `"bodhi-pi"` + a const we maintain alongside CHANGELOG). Field shape: `agentInfo: { name: "bodhi-pi", version: "0.0.1" }` per `types.gen.d.ts:1870`.

Decision: hardcode the version constant in a new `src/version.ts` file (`export const BODHI_PI_VERSION = "0.0.1"`). Bump alongside `package.json` releases. Avoids a sync-fs read at init time.

### A.5 — Real `updatedAt` in `SessionStore`

**Where:** `sessions/session-store.ts:17-22, 30-34`, `sessions/in-memory-session-store.ts:37-41`, `acp/agent.ts:217-221`.

**What changes:**
- Add `updatedAt: number` to `SessionInfo` interface.
- Add an internal `updatedAt: number` field to the in-memory store's `SessionRecord` (also reflect in `SessionRecord` interface so disk-backed impls have to track it).
- On `create({ cwd })`: set `updatedAt = createdAt`.
- On `append(...)`: set `updatedAt = Date.now()`.
- On `list(...)`: surface `updatedAt` per session.
- In `acp/agent.ts:listSessions`, use `s.updatedAt` instead of `s.createdAt`. Also sort by `updatedAt` desc (currently sorted by `createdAt` desc — for an active session this already matches, but it's the correct semantic).

### A.6 — Omit `nextCursor` instead of `null`

**Where:** `acp/agent.ts:222`.

**What changes:**

```ts
return {
    sessions: result.sessions.map(...),
    ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
};
```

### Commit 1 deliverable

- Modified files: `src/acp/agent.ts`, `src/sessions/session-store.ts`, `src/sessions/in-memory-session-store.ts`, `src/version.ts` (new), `test/chat.test.ts` (new tests for cancel/stopReason mapping/agentInfo/updatedAt), `CHANGELOG.md`.
- Tests added inline so the commit is a complete unit:
  - `chat.test.ts`: `agentInfo present in initialize`; `updatedAt updates on each prompt`; `cancel mid-prompt yields stopReason cancelled`; `userMessageId echoed` (via faux + a `messageId` in PromptRequest).
- Gate-check: `npm run check` + bodhi-pi build + `npm test` + `npm run test:e2e`.
- Commit message: `fix(bodhi-pi): tighten ACP wire correctness (stopReason · cancel · userMessageId · agentInfo · updatedAt)`.

---

## Batch B + C — Source structure + Tool DRY (Commit 2)

### B.1 — Delete `src/core/agent-session.ts`

**Where:** the file itself (12 lines), and `acp/agent.ts:30, 112, 395`.

**What changes:** inline `new Agent(opts)` at both call sites; remove the import; delete the file. The directory `src/core/` becomes empty after this — remove it too.

### B.2 — Split `acp/agent.ts`

**Where:** the bottom helpers + types in `acp/agent.ts:404-475`, the constants at lines 35-36.

**Move to `src/acp/notifications.ts`:**
- Interfaces `ToolResultMessageLike`, `ToolCallBlock`, `ToolCallContentBlock` (lines 404-417, 456-459)
- Functions `extractText`, `extractToolCalls`, `toolResultContentForAcp`, `agentToolContentForAcp`, `formatLocationHint` (lines 419-475)

**Move to `src/acp/constants.ts`:**
- `MODEL_CONFIG_ID`, `EXT_DELETE_SESSION` (lines 35-36)

After the split, `agent.ts` imports from both files and contains only the class.

### B.3 — Consolidate three `subscribe()` calls

**Where:** `acp/agent.ts:288, 302, 331`.

**What changes:** one subscription, switch on `event.type`. Single `unsubscribe()` in `finally`. Captures the `lastAssistantStopReason` for A.1 (so A.1 actually depends on B.3 internally; doing them together in commit 1 + commit 2 means A.1 has a slightly messier impl in commit 1 that gets cleaned up in commit 2).

**Compromise to keep commit 1 clean:** do B.3 partially in commit 1 — consolidate just the two new ones (A.1 stopReason capture + A.2 cancel flag) into a fourth subscription. Full consolidation lands in commit 2. Commits stay independently gate-checkable.

### B.4 — Hide session-store internals from public exports

**Where:** `src/index.ts:6-12`.

**What changes:** drop `ListSessionsRequest`, `ListSessionsResult`, `SessionEntry`, `SessionInfo`, `SessionRecord`. Keep only `SessionStore`. Internal callers already import directly from `./sessions/session-store.js`.

### B.5 — Replace structural casts with typed discrimination

**Where:** `acp/notifications.ts` (after B.2 split — was `agent.ts:419-449`), `acp/agent.ts:138`.

**What changes:**
- Import `AssistantMessage`, `UserMessage`, `ToolResultMessage` from `@mariozechner/pi-ai`.
- `extractText`: discriminate on `message.role` first.
- `extractToolCalls`: only accepts `AssistantMessage`; iterates typed content blocks.
- The `as ToolResultMessageLike` at `agent.ts:138` becomes a real type guard `isToolResultMessage(msg)`.
- After this, `ToolResultMessageLike` and `ToolCallBlock` interfaces (in `notifications.ts`) are deleted.

### B.6 — Drop unused `cursor` param

**Where:** `sessions/in-memory-session-store.ts:43-55`.

**What changes:** remove `cursor` from this implementation's destructured args (TS will still accept the wider `ListSessionsRequest` shape via structural typing). Add JSDoc on `SessionStore.list` (`session-store.ts:54`) clarifying that ephemeral impls may ignore cursor; disk impls must honour it.

### B.7 — Document error-throw convention

**Where:** above `class BodhiPiAcpAgent` declaration (`acp/agent.ts:76`).

**What changes:** class-level JSDoc block:

```ts
/**
 * ACP-side agent class. Throw conventions:
 *   - factory validation (in `createBodhiPiAgent`) → plain `Error`
 *   - ACP protocol violations from method handlers → `RequestError(-32602/-32601, ...)`
 *   - tool execution errors → plain `Error` (propagated by pi-agent-core to
 *     `tool_execution_end.isError` → ACP `tool_call_update` with status: "failed")
 */
```

### C.1 — Shared truncation helper

**Where:** new `src/tools/_accumulate.ts`. Refactors `tools/read.ts`, `tools/ls.ts`, `tools/find.ts`, `tools/grep.ts:50-91`.

**What changes:** new helper:

```ts
export interface AccumulateResult {
    lines: string[];
    stopped: "items" | "bytes" | null;
}

export interface AccumulateOptions {
    maxItems: number;
    maxBytes: number;
}

export async function accumulateBounded(
    source: AsyncIterable<string>,
    opts: AccumulateOptions,
): Promise<AccumulateResult> { ... }
```

Each tool reduces to "yield strings → render → emit footer". The exact yielded shape per tool (e.g., `path:line:text` for grep, `<name>\t<type>\t<size>` for ls) is the tool's responsibility; the helper only counts.

### C.2 — Normalise truncation marker

**Where:** falls out of C.1.

**What changes:** one rendering function in `_accumulate.ts`:

```ts
export function truncationFooter(
    shown: number,
    total: number | undefined,
    stopped: "items" | "bytes",
    units: { item: string; byteCap: number },
): string { ... }
```

Output format: `[Truncated: showing N of M ${units.item}; ${stopped === "bytes" ? "${byteCap}KB output limit" : "${maxItems}-${units.item} limit"}]`. Tools pass their own `item` noun ("lines", "matches", "entries") and the byte cap. Total can be omitted (find/grep don't always know it).

### C.3 — Rename `FIND_MAX_RESULTS → FIND_MAX_MATCHES`

**Where:** `tools/limits.ts:9`, `tools/find.ts` (one usage).

**What changes:** rename + update the import. Add JSDoc on `limits.ts:1-6` clarifying that all `_MAX_BYTES` constants are *output* byte caps, not file-size caps.

### Commit 2 deliverable

- New files: `src/acp/notifications.ts`, `src/acp/constants.ts`, `src/tools/_accumulate.ts`.
- Deleted: `src/core/agent-session.ts` (and the empty `src/core/` directory).
- Modified: `src/acp/agent.ts`, `src/index.ts`, `src/sessions/in-memory-session-store.ts`, `src/sessions/session-store.ts` (JSDoc only), `src/tools/{read,ls,find,grep,limits}.ts`.
- All 21 existing integration tests + 6 e2e tests pass unchanged.
- Gate-check: `npm run check` + build + `npm test` + `npm run test:e2e`.
- Commit message: `refactor(bodhi-pi): split agent.ts, consolidate subscribes, DRY tool truncation`.

---

## Batch D — Test architecture (Commit 3)

### D.1 — Extract shared helpers

**Where:** the helpers map from the review §D.1.

**New helpers:**
- `test/helpers/notifications.ts` — `chunkedAgentText(updates)`, `userChunkText(updates)`.
- `test/helpers/acp-constants.ts` — `stdInitParams`.
- `test/helpers/env.ts` — `requireEnv(name)`.
- `test/helpers/acp-narrow.ts` — `asSelectOption(opt)`.
- `test/helpers/tool-call-asserts.ts` — `toolCallStarts`, `toolCallUpdates`, `toolUpdateText`.
- `test/helpers/faux-script.ts` — `scriptToolThenDone(faux, name, args)`.
- `test/helpers/harness.ts` — unified `createTestHarness({ models, sessionStore?, filesystem?, getApiKey?, systemPrompt? })`. Returns `{ clientConn, updates, filesystem, sessionStore, model }`. Replaces `makeClient`, `makeHarness ×2`, `runSingleTurn` across all four test files.

**Refactor:** `test/chat.test.ts`, `test/fs.test.ts`, `e2e/chat.e2e.ts`, `e2e/fs.e2e.ts` import from helpers; delete inline copies.

`runSingleTurn` in `e2e/chat.e2e.ts:45` was returning a custom shape (`stopReason`, `chunks`, `text`); rework call sites to use the new harness uniform shape.

### D.2 — Loosen brittle assertions

- `e2e/fs.e2e.ts:86`: `expect(stored.trim()).toBe("hello world")` → `expect(stored.trim().toLowerCase()).toContain("hello world")` + add `expect(filesystem.exists("/out.txt")).toBe(true)` for the structural part.
- `test/fs.test.ts:165`: `expect(toolUpdateText(ends[0])).toContain("Wrote 2 bytes")` → `expect(...).toMatch(/Wrote \d+ bytes/)`.

### D.3 — Collapse vitest configs

**Where:** `vitest.config.ts`, `vitest.e2e.config.ts`.

**What changes:** `vitest.e2e.config.ts` uses vitest's `mergeConfig` to inherit from `vitest.config.ts`, overrides only `include` and `testTimeout`:

```ts
import { mergeConfig, defineConfig } from "vitest/config";
import baseConfig from "./vitest.config.js";

loadEnv({ path: path.join(here, "e2e", ".env.test"), override: true });

export default mergeConfig(baseConfig, defineConfig({
    test: { include: ["e2e/**/*.e2e.ts"], testTimeout: 60000 },
}));
```

### D.4 — Make NUL byte visible in binary-skip test

**Where:** `test/fs.test.ts:316`.

**What changes:** today the seed contains a literal ` ` byte hidden inside what looks like a regular string (artifact of an earlier Write). The test passes correctly because `isLikelyBinary` finds the NUL — but readers can't see it.

Replace with explicit construction:

```ts
await harness.filesystem.writeTextFile(
    "/bin.dat",
    `binary${String.fromCharCode(0)}content needle`,
);
```

Now the NUL is intentional and visible.

### Commit 3 deliverable

- New files: `test/helpers/{notifications,acp-constants,env,acp-narrow,tool-call-asserts,faux-script,harness}.ts`.
- Modified files: `test/chat.test.ts`, `test/fs.test.ts`, `e2e/chat.e2e.ts`, `e2e/fs.e2e.ts`, `vitest.e2e.config.ts`.
- All existing tests still pass; coverage and asserts unchanged in semantics, only locations/wording.
- Gate-check: same as before.
- Commit message: `refactor(bodhi-pi/tests): extract shared helpers, mergeConfig for e2e, loosen brittle asserts`.

---

## Batch E — Coverage holes (Commit 4)

### E.1 — `src/filesystem/in-memory-filesystem.test.ts`

Co-located unit tests. The vitest config (`include: ["src/**/*.test.ts", ...]`) already picks them up. Cases:

- `readTextFile("/missing")` rejects with `code: "ENOENT"`
- `readTextFile("/")` (a dir) rejects with `code: "EISDIR"`
- `list("/missing")` rejects with `code: "ENOENT"`
- `list("/file.txt")` (a file) rejects with `code: "ENOTDIR"`
- `mkdir("/exists")` (no recursive, dir already exists) rejects with `code: "EEXIST"`
- `mkdir("/a/b/c")` (no recursive, missing parent) rejects with `code: "ENOENT"`
- `mkdir("/a/b/c", { recursive: true })` succeeds; intermediate dirs exist; idempotent.
- `remove("/non-empty-dir")` (no recursive) rejects with `code: "ENOTEMPTY"`
- `remove("/non-empty-dir", { recursive: true })` succeeds; all children gone.
- `remove("/missing")` is no-op (per current impl).
- `exists("/missing")` returns false; `exists("/file.txt")` returns true; `exists()` never throws.
- `stat("/file.txt")` returns `isFile: true, size > 0, mtimeMs > 0`.

### E.2 — `src/tools/walk.test.ts`

- Default skip list (`.git`, `node_modules`) excludes those subtrees.
- `maxEntries` caps yielded entries.
- `signal.aborted = true` before iteration starts → no entries.
- `signal.aborted` mid-walk → walk stops at next iteration.
- Custom `skipDir` predicate is honoured.
- Empty directory yields nothing.
- Single file at root yields one entry with `isFile: true`.

### E.3 — `src/tools/index.test.ts`

- `resolvePath("/cwd", "rel/file.txt")` → `/cwd/rel/file.txt`
- `resolvePath("/cwd", "/abs/file.txt")` → `/abs/file.txt` (absolute ignores cwd)
- `resolvePath("/cwd", "../escape")` → `/escape` (no traversal guard, by design)
- `resolvePath("/", "")` → `/` (root edge case)
- `toolKindFor("read")` → `"read"`, etc., for all six tools and the `"other"` fallback.

### E.4 — `src/acp/notifications.test.ts`

(After Batch B.2 split.)

- `extractText` on `UserMessage` with string content → returns the string.
- `extractText` on `AssistantMessage` with mixed text/toolCall blocks → only text is returned, joined.
- `extractText` on a message with empty/missing content → returns `""`.
- `extractToolCalls` on `AssistantMessage` with two toolCall blocks → returns both with id/name/arguments.
- `extractToolCalls` on a message with no toolCall blocks → returns `[]`.
- `agentToolContentForAcp` on empty input → `[]`.
- `agentToolContentForAcp` on text-only blocks → one wrapped `{ type: "content", content: { type: "text", text } }`.
- `agentToolContentForAcp` on mixed text + image blocks → only text concatenated (image is not yet supported in this milestone).
- `formatLocationHint({ path: "/x.txt" })` → `"/x.txt"`. `formatLocationHint({})` → `""`. `formatLocationHint(null)` → `""`. `formatLocationHint(undefined)` → `""`.

### E.5 — Integration coverage gaps in `test/fs.test.ts`

- `read` with `offset: 5` on a 20-line file returns lines 5-20.
- `read` with `limit: 3` returns 3 lines + a `[N more lines in file. Use offset=...]` continuation marker.
- `read` byte-truncation: write a file of one 60KB line; read it; assert truncation marker mentions byte limit (not line limit).
- `grep` byte-truncation: seed many files containing `"needle"`; assert output contains the byte-cap truncation marker.
- `grep` line-length truncation: seed file with one 1000-char line containing `"needle"`; assert the emitted line ends with `...`.
- `ls` byte-truncation: create 200+ files in a dir; assert output contains the byte-cap truncation marker.
- Multiple tool calls in one prompt: faux returns `[fauxToolCall(write, ...), fauxToolCall(read, ...), fauxAssistantMessage("done")]`; assert two `tool_call` notifications + two `tool_call_update` notifications, in order.
- `cancel()` mid-tool: faux returns a tool call to a slow operation (e.g., walk a synthetically deep tree); call `cancel()` mid-execution; assert tool ends with `status: "failed"` (or no `tool_call_update` if abort fires before tool emits) and `prompt()` returns `stopReason: "cancelled"`.
- Tool failure replay during `session/load`: write+fail in turn 1; close; load in fresh client; assert replay emits `tool_call_update` with `status: "failed"`.
- Negative tests: `prompt({ sessionId: "invalid-uuid", ... })` rejects with `not loaded`. `createBodhiPiAgent({ defaultModelId: "nonexistent", ... })` throws synchronously.

### Commit 4 deliverable

- New files: `src/filesystem/in-memory-filesystem.test.ts`, `src/tools/walk.test.ts`, `src/tools/index.test.ts`, `src/acp/notifications.test.ts`.
- Modified: `test/fs.test.ts` (~10 new integration tests).
- Net test count: ~25 new tests (12 unit + 7 walk/index/notifications + 10 integration).
- Gate-check: `npm test` count rises from 21 to ~46. e2e unchanged.
- Commit message: `test(bodhi-pi): unit + integration coverage for filesystem, walk, tools, notifications`.

---

## Batch F — Host-facing gaps + M3.2 wrap (Commit 5)

### F.1 — `BodhiPiConfig.systemPrompt`

**Where:** `src/acp/agent.ts:38-49` (`BodhiPiConfig`), `src/acp/agent.ts:108-126` (`newSession`), `src/acp/agent.ts:378-401` (`rehydrateSession`).

**What changes:**

```ts
export interface BodhiPiConfig {
    // ...existing fields...
    /** Optional system prompt injected at session creation. Mandatory-injection rule does NOT apply (no fallback needed; pi-agent-core defaults to ""). */
    systemPrompt?: string;
}
```

In `newSession`:

```ts
const piAgent = new Agent({
    initialState: { model: defaultModel, tools, systemPrompt: this.config.systemPrompt },
    getApiKey: this.config.getApiKey,
});
```

In `rehydrateSession`:

```ts
const piAgent = new Agent({
    initialState: { model: restoredModel, messages, tools, systemPrompt: this.config.systemPrompt },
    getApiKey: this.config.getApiKey,
});
```

Per coding-agent's pattern: NOT persisted as a session entry. Always uses the current config's value on `loadSession`/`resumeSession`. Hosts that want layering compose the string client-side.

### F.2 — README usage section

**Where:** `packages/bodhi-pi/README.md`.

**What changes:** add a "Usage" section with a 15-line snippet showing the public-API wiring. Example:

```md
## Usage

Wire `bodhi-pi` to a host via `@agentclientprotocol/sdk`'s `AgentSideConnection`:

```ts
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { createBodhiPiAgent, createInMemoryFilesystem, createInMemorySessionStore } from "@bodhiapp/bodhi-pi";
import { getModel } from "@mariozechner/pi-ai";

const factory = createBodhiPiAgent({
    models: [getModel("anthropic", "claude-haiku-4-5")],
    defaultModelId: "claude-haiku-4-5",
    getApiKey: (provider) => process.env[`${provider.toUpperCase()}_API_KEY`],
    sessionStore: createInMemorySessionStore(),
    filesystem: createInMemoryFilesystem(),
    systemPrompt: "You are a helpful coding assistant.",
});

new AgentSideConnection(factory, ndJsonStream(process.stdin, process.stdout));
```

`createInMemoryFilesystem()` and `createInMemorySessionStore()` are reference helpers; production hosts inject Node-fs / OPFS / disk-backed JSONL implementations of the same interfaces.
```

### F.3 — `BodhiPiConfig` JSDoc consistency

**Where:** `src/acp/agent.ts:38-49`.

**What changes:** add "Mandatory; no default fallback." to the JSDoc on `models`, `defaultModelId`, `getApiKey`. The new `systemPrompt` field gets its own JSDoc explaining the static + non-persisted semantics.

### F.4 — CHANGELOG + context.md

**`packages/bodhi-pi/CHANGELOG.md`** under `## [Unreleased]`:

```md
### Changed
- M3.2 — Health pass. Wire correctness fixes (real `stopReason` mapping; `cancel()` now yields `stopReason: "cancelled"`; `userMessageId` echoed in `PromptResponse`; `agentInfo` advertised in `InitializeResponse`; `SessionInfo.updatedAt` is now actual last-modified time, bumped on every store append; `nextCursor` omitted instead of `null`). Source structure (`src/core/agent-session.ts` removed; `acp/agent.ts` split into `agent.ts` + `notifications.ts` + `constants.ts`; three `subscribe()` calls in `prompt()` consolidated; structural casts replaced with typed discrimination on pi-ai message roles). Tool DRY (shared `accumulateBounded` helper for read/ls/find/grep truncation; unified truncation footer; `FIND_MAX_RESULTS` renamed to `FIND_MAX_MATCHES`). Test architecture (shared helpers under `test/helpers/`; `vitest.e2e.config.ts` now `mergeConfig`s the base; brittle e2e assertion loosened; binary-skip test seed made visible). New tests (~25 unit + integration covering filesystem error codes, walk, tools/index helpers, notification helpers, read/grep/ls truncation paths, multiple tool calls per prompt, cancel mid-tool, tool failure replay, negative paths).

### Added
- `BodhiPiConfig.systemPrompt?: string` — optional config-time system prompt threaded into every session's `initialState.systemPrompt`. Not persisted (mirrors coding-agent — system prompt is configuration, not session state). Hosts that want layered composition do it client-side and pass the result.
- README "Usage" section with end-to-end wiring example.
- `JSDoc` on every `BodhiPiConfig` field clarifies the mandatory-vs-optional contract.
```

**`ai-docs/context.md`:**

- §4 progress table: add `(next) | feat(bodhi-pi): land M3.2 — health pass`.
- §4 description block: add an "M3.2 — Health pass" subsection covering the same scope as CHANGELOG.
- §7 next-up: rotate the recommended next milestones (M2.2 / M2.3 / M4.1 are the obvious candidates after M3.2).

### Commit 5 deliverable

- Modified files: `src/acp/agent.ts`, `README.md`, `CHANGELOG.md`, `ai-docs/context.md`.
- Tests: at least one new test in `test/chat.test.ts` (or wherever fits) verifying `systemPrompt` flows through to pi-agent-core. Inspect via faux: faux's `serializeContext` includes `system:${prompt}`. Easiest assertion: pass a sentinel string in `systemPrompt`, prompt, then read the faux's `mock.getRequests()` (or the `Agent.state.systemPrompt` after construction). Concretely: assert `agent.state.systemPrompt` after `newSession` matches the config value. Need internal access — either inspect via test-only export OR drive a faux that records the system prompt it received.
- Gate-check: same as before, plus `npm run check` validates README markdown and JSDoc.
- Commit message: `feat(bodhi-pi): land M3.2 — systemPrompt + health pass wrap (README · CHANGELOG · context)`.

---

## Risk register

- **B.5 type discrimination** — pi-ai's `Message` discriminator may not narrow cleanly with all blocks. If `extractText`/`extractToolCalls` typing becomes awkward, fall back to a thin `isAssistant`/`isUser`/`isToolResult` type-guard pair in `notifications.ts`.
- **A.5 `updatedAt` interface change** — `SessionInfo` is currently exported from `src/index.ts` (will be hidden in B.4). Existing tests filter `entries.filter((e) => e.type === "message")` to count; they don't read `updatedAt`. No regression risk.
- **D.3 mergeConfig** — vitest `mergeConfig` exists (verified in vitest 3.x typings); if it doesn't behave, fall back to a small shared-config-object that both files import.
- **F.1 systemPrompt** — pi-agent-core's `Agent.state.systemPrompt` is a public mutable accessor. The first turn of a session reads `state.systemPrompt`; if a host changes it post-construction by mutating `agent.state.systemPrompt` (won't normally — they'd go through ACP), behaviour is whatever pi-agent-core does on next turn. Acceptable.
- **E coverage commit size** — ~25 new tests is a large diff. If gate-check shows surprising failures (e.g., `walk` ordering varying across runs), keep tests deterministic by seeding `Filesystem` in lexical order and asserting against sorted output.

---

## Files modified across the whole pass

```
src/acp/agent.ts                     [B.1, B.2, B.3, B.5, B.7, A.*, F.1, F.3]
src/acp/notifications.ts             [B.2 NEW]
src/acp/notifications.test.ts        [E.4 NEW]
src/acp/constants.ts                 [B.2 NEW]
src/core/agent-session.ts            [B.1 DELETED]
src/filesystem/in-memory-filesystem.ts  [no change in source]
src/filesystem/in-memory-filesystem.test.ts  [E.1 NEW]
src/index.ts                         [B.4]
src/sessions/in-memory-session-store.ts  [A.5, B.6]
src/sessions/session-store.ts        [A.5, B.6 JSDoc]
src/tools/_accumulate.ts             [C.1 NEW]
src/tools/{read,ls,find,grep}.ts     [C.1, C.2]
src/tools/find.ts                    [C.3]
src/tools/index.test.ts              [E.3 NEW]
src/tools/limits.ts                  [C.3]
src/tools/walk.test.ts               [E.2 NEW]
src/version.ts                       [A.4 NEW]
test/chat.test.ts                    [A tests, D.1 helper extraction]
test/fs.test.ts                      [D.1, D.2, D.4, E.5]
test/helpers/{notifications,acp-constants,env,acp-narrow,tool-call-asserts,faux-script,harness}.ts  [D.1 NEW]
e2e/chat.e2e.ts                      [D.1 helper extraction]
e2e/fs.e2e.ts                        [D.1, D.2]
vitest.e2e.config.ts                 [D.3]
README.md                            [F.2]
CHANGELOG.md                         [F.4]
ai-docs/context.md                   [F.4]
```

Roughly 25 files touched, 5-7 new files added, 1 file (and 1 directory) deleted.

---

## Verification per commit

Each commit must pass before moving on:

```bash
npm run check
npm --workspace @bodhiapp/bodhi-pi run build
npm --workspace @bodhiapp/bodhi-pi run test
npm --workspace @bodhiapp/bodhi-pi run test:e2e
```

**Acceptance gate after Commit 5:**
- All checks green.
- `npm test` count: ~21 → ~46 (Batch E adds tests).
- `npm run test:e2e` count: 6 (unchanged; Batch D.2 only loosens existing assertions).
- README has a runnable usage snippet.
- `ai-docs/context.md` updated with M3.2 progress entry.
- `CHANGELOG.md` "Unreleased" block has the M3.2 entry.

---

## After approval — durable preferences to save

After all five commits land, persist these as project-feedback memories:

- **systemPrompt is config-time only, not session state.** Mirrors coding-agent: rebuilt fresh on every session load. Never persisted to `SessionEntry`. Hosts compose layered prompts client-side.
- **bodhi-pi has no AGENTS.md/SYSTEM.md walk in core.** Discovery and layering are the host's responsibility (via the `systemPrompt` config field). This prevents `node:fs` from leaking into core.
- **stopReason mapping** for ACP: pi-agent-core's `"aborted" → "cancelled"`, `"length" → "max_tokens"`, `"stop"|"toolUse" → "end_turn"`, `"error" → throw RequestError`.
- **`SessionStore.append` MUST bump `updatedAt`.** Disk-backed implementations have to honour this when they ship.
- **All structural `as` casts in ACP-side message handling are forbidden** — use pi-ai's typed `Message` discriminator union and narrow on `role` first.
- **`accumulateBounded` is the canonical truncation helper** for tools that produce string lists. Future tools should reuse it instead of inlining the count+byte loop.
- **Test helpers live in `test/helpers/`** and are shared between integration and e2e. Future test files import from there; never duplicate.
