# Phase H — Tooling hardening (excluding `bash`)

## Context

bodhi-pi's built-in tools have parity gaps vs. coding-agent that bite in real
use: `edit` silently normalises CRLF→LF and strips BOM; concurrent `edit` calls
on the same path race; long `grep` lines are truncated with an ambiguous `...`
marker; and the agent already raises `tool_execution_update` events internally
but never forwards them to ACP — so UIs only ever see post-hoc tool results,
not progressive streaming. Phase H closes these six items. `bash` is
deliberately deferred to its own phase (separate, much larger surface).

Phase 0 (upstream sync) decided to **keep `_accumulate.ts` parallel** to
`harness/utils/truncate.ts` (semantic spot-check only) and to **adopt
`harness/utils/shell-output.ts` later** with the bash tool. This plan respects
both decisions — no harness adoption here.

User decisions captured before planning:
- **Mutation-queue scope**: mirror coding-agent — module-level
  `Map<realpath, Promise>`, not session-scoped.
- **Streaming shape**: mirror coding-agent — `onUpdate(content)` callback with
  ~100ms snapshot throttle (full content snapshot, not deltas).
- **Grep marker**: `"... [truncated]"` to match coding-agent (replaces current
  `"..."`).

---

## Scope (six functional outcomes)

1. **Streaming tool output** — `tool_execution_update` → ACP
   `tool_call_update.content`.
2. **`edit` preserves CRLF/LF** line endings on round-trip.
3. **`edit` preserves UTF-8 BOM**.
4. **`edit` ambiguous `old_string` rejection** — already implemented ✅;
   audit-only.
5. **File-mutation queue** — serialise concurrent writes/edits per realpath.
6. **`grep` long-line truncation marker** — `"... [truncated]"`.

Out of scope (deferred): `bash` tool + Terminal, full-output spool, pluggable
SSH ops, image tool results, README auto-link.

---

## Audit findings (current state)

| Item | File | Status |
|---|---|---|
| Streaming wire-through | `packages/bodhi-pi/src/acp/agent.ts:1104-1112` | `tool_execution_update` emits locally only; no `conn.sessionUpdate` call. **GAP.** |
| Edit uniqueness | `packages/bodhi-pi/src/tools/edit.ts:50-55` | Throws on second occurrence. **OK** — no change. |
| Edit line endings | `packages/bodhi-pi/src/tools/edit.ts:41,56,59` | `readTextFile` → string slice/concat → `writeTextFile`. CRLF round-trips as-is (string is opaque), **BUT** `newText` is concatenated literally — if author uses `\n` newText in a CRLF file, mixing results. Needs detect + normalise + restore. **GAP.** |
| Edit BOM | `packages/bodhi-pi/src/tools/edit.ts` | No strip/reattach. **GAP.** |
| Mutation queue | (none) | Not implemented. **GAP.** |
| Grep line truncation | `packages/bodhi-pi/src/tools/grep.ts:33-36` | Truncates at 500 chars with `"..."`. Marker change only. |

Reference impls in `packages/coding-agent/src/core/tools/`:
- `edit-diff.ts:11-17` — `detectLineEnding`
- `edit-diff.ts:23-25` — `restoreLineEndings`
- `edit-diff.ts:137-139` — `stripBom`
- `file-mutation-queue.ts:1-40` — `withFileMutationQueue` (module-global `Map`)
- `truncate.ts:257-265` — `truncateLine` returning `{text, wasTruncated}`
- `extensions/types.ts:454-461` — `execute(..., onUpdate, ctx)` signature
- `bash.ts:291-303` + 100ms throttle — streaming snapshot example

---

## Implementation

### H1. Streaming tool output (core + per-host)

**Core change** — `packages/bodhi-pi/src/acp/agent.ts:1104-1112`
extend the `tool_execution_update` case to forward to ACP:

```ts
case "tool_execution_update": {
  await events.emitToolExecutionUpdate({ ...as today });
  await conn.sessionUpdate({
    sessionId,
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: event.toolCallId,
      status: "in_progress",
      content: agentToolContentForAcp(event.partialResult?.content ?? []),
    },
  });
  return;
}
```

The pi-agent-core `Agent` already raises `tool_execution_update` events with
`partialResult: { content }`. Confirm the event shape (read
`@earendil-works/pi-agent-core` types — there should be an existing
`partialResult` field; if not, only `agent.ts` needs the forwarding logic and
no tool actually emits partials yet — that's fine, the wire is the deliverable).

**Tool-side wiring (audit only, no production tool needs to stream this phase)**:
The phase prompt's streaming test uses a **faux harness that returns a
tool-execution with partial results**. So the production tools (`grep`, `edit`,
etc.) need NOT be retrofitted to actually emit chunks — only the wire-through
must be observable from a faux tool that emits partials. Real bash streaming
lands in the bash phase.

**Per-host parity** (4-host rule from `packages/bodhi-pi/CLAUDE.md`):
- **cli**: REPL already prints tool-call cards via ACP; verify
  `tool_call_update` with mid-flight content renders incrementally.
  `packages/bodhi-pi-cli/src/repl/render.ts` (or similar).
- **web** + **chrome-ext** (shared via `bodhi-pi-browser`): tool-call card
  component must update on `tool_call_update` with `content` while status is
  `in_progress`. Use `data-tool-call-preview` attribute for Playwright
  assertion. `packages/bodhi-pi-browser/src/ui/ToolCallCard.tsx` (or
  equivalent).
- **ws-frontend**: same UI rule via its own component (no shared UI with
  browser pkg).
- **http**: frontend tool-call card.

### H2. Edit line-ending + BOM preservation

**New file** — `packages/bodhi-pi/src/tools/_text-encoding.ts`
mirror `edit-diff.ts` helpers (kept parallel to coding-agent per Phase 0
decision; not imported from harness):

```ts
export function detectLineEnding(content: string): "\r\n" | "\n" {
  const crlfIdx = content.indexOf("\r\n");
  const lfIdx = content.indexOf("\n");
  if (lfIdx === -1) return "\n";
  if (crlfIdx === -1) return "\n";
  return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

export function stripBom(content: string): { bom: string; text: string } {
  return content.startsWith("﻿")
    ? { bom: "﻿", text: content.slice(1) }
    : { bom: "", text: content };
}
```

**Modify** — `packages/bodhi-pi/src/tools/edit.ts:36-66`:
- Read raw → `stripBom` → `detectLineEnding` → normalise body to LF.
- Apply each edit (`oldText` is matched against the LF-normalised body; the
  agent supplies LF-shaped strings).
- Restore: `bom + restoreLineEndings(working, originalEnding)`.

Naming note: bodhi-pi's edit uses `oldText`/`newText` (not `old_string`); keep
the existing names.

### H3. Edit uniqueness — audit, no change

Current behaviour at `edit.ts:50-55` matches coding-agent: throws with offset
hints. Add a test case if missing (see H6 tests).

### H4. File-mutation queue

**New file** — `packages/bodhi-pi/src/tools/file-mutation-queue.ts`
verbatim shape of coding-agent's `file-mutation-queue.ts:1-40` but **without
`realpathSync.native`** (that's Node-only — bodhi-pi core must stay browser-safe).
Use the resolved absolute path as the key directly:

```ts
const fileMutationQueues = new Map<string, Promise<void>>();

export async function withFileMutationQueue<T>(
  absolutePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = absolutePath; // already resolved by caller via resolvePath()
  const currentQueue = fileMutationQueues.get(key) ?? Promise.resolve();
  let releaseNext!: () => void;
  const nextQueue = new Promise<void>((r) => { releaseNext = r; });
  fileMutationQueues.set(key, currentQueue.then(() => nextQueue));
  await currentQueue;
  try { return await fn(); }
  finally {
    releaseNext();
    if (fileMutationQueues.get(key) === currentQueue.then(() => nextQueue)) {
      fileMutationQueues.delete(key);
    }
  }
}
```

**Trade-off accepted**: without `realpath`, two paths that resolve to the same
file via symlinks won't share a lock. Browser hosts don't have symlinks
(ZenFS); Node hosts may. Document this as known limitation in code comment —
matches Phase 0 spirit of not pulling `node:fs` into core.

**Wire into**:
- `tools/edit.ts:36-64` — wrap the whole execute body.
- `tools/write.ts` (file currently 32 lines) — wrap the write.

### H5. Grep marker change

**Modify** — `packages/bodhi-pi/src/tools/grep.ts:33-36`:
```ts
function truncateLine(line: string): string {
  if (line.length <= GREP_MAX_LINE_LENGTH) return line;
  return `${line.slice(0, GREP_MAX_LINE_LENGTH)}... [truncated]`;
}
```
One-line change. Update existing test in `test/fs.test.ts:361` to assert the
new marker.

---

## Test plan

Follow `process.md` §2: failing test first, then green, runtime-by-runtime.
Per `CLAUDE.md`'s 7-step feature workflow, every sub-feature gets a core
integration test before host work.

### Core (`packages/bodhi-pi/test/`)

Add to `test/fs.test.ts` (existing tool-test home):
- **Edit LF/CRLF**: seed `"line1\r\nline2\r\n"`; edit `line1`→`line1-new`;
  read back; assert `"line1-new\r\nline2\r\n"`. Repeat for LF.
- **Edit BOM**: seed `"﻿hello\nworld\n"`; edit `hello`→`hi`; assert BOM
  preserved.
- **Edit uniqueness audit**: seed `"x\nx\nx\n"`; edit `x` (no replace_all);
  assert throws referencing "not unique". *(Confirm an equivalent assertion
  already exists at line 122 — augment with error-message substring if not.)*
- **Grep marker**: 2000-char line containing a match; assert result contains
  `... [truncated]` and the prefix preserves the match.

Add new file `test/file-mutation-queue.test.ts`:
- **Sequencing**: fire two `edit` calls in parallel via the harness's
  faux-provider tool-use rounds; both target same path; assert final content
  is both edits applied (not interleaved/lost). Use a small in-memory
  filesystem with a deliberate read-write delay (wrap one of the FS ops in a
  `setTimeout` shim) to force the race.

Add new file `test/streaming-tool-output.test.ts`:
- **Wire-through**: register a faux tool that emits two `tool_execution_update`
  events with growing content before completing. Subscribe via
  `clientConn` (the ACP seam — per blackbox rule); collect `sessionUpdate`
  notifications; assert ≥2 `tool_call_update` notifications with
  `status: "in_progress"` and `content` arrive before the
  `status: "completed"` update.

### Per-host e2e

For each host, add ONE e2e covering the **streaming** path (visible signal:
tool-card preview text updates mid-stream). For deterministic tests, the faux
tool is preferred over real LLM streaming. Real-LLM e2e isn't strictly
required for streaming (the LLM doesn't drive the streaming — the tool does);
faux harness e2e is enough where it exists.

Edit line-ending and BOM are well-tested at core level (they're filesystem
contracts, not user-facing slash commands); per-host e2e is **not** required
for them. Grep marker change is observable in any host that runs grep —
covered by core test.

File-mutation queue is invisible to the user except as "no data loss" —
covered by core test alone.

Hosts to update (per `process.md`):
- `bodhi-pi-cli` — e2e using `createCliTestHarness` with faux tool;
  assert stdout shows progressive tool-card states.
- `bodhi-pi-browser` shared spec (driven from `bodhi-pi-web`) — Playwright
  assertion on `data-tool-call-preview` attribute change.
- `bodhi-pi-chrome-ext` — same spec shape, MV3 host.
- `bodhi-pi-ws-frontend` — Playwright spec.
- `bodhi-pi-http` — integration test using faux provider; assert SSE
  delivers progressive `tool_call_update` events.

### Gate

- Core: `npx tsgo --noEmit -p packages/bodhi-pi/tsconfig.json` +
  `cd packages/bodhi-pi && npm test`.
- Rebuild `bodhi-pi-browser` dist (`npm run build`) before web/chrome-ext e2e.
- Repo root: `just test`.
- Restore `packages/ai/src/models.generated.ts` before commit
  (`git checkout packages/ai/src/models.generated.ts`).

---

## Critical files

| Path | Change |
|---|---|
| `packages/bodhi-pi/src/acp/agent.ts` | Forward `tool_execution_update` → `conn.sessionUpdate` (line ~1104) |
| `packages/bodhi-pi/src/tools/edit.ts` | Wrap in mutation queue; integrate `_text-encoding` helpers |
| `packages/bodhi-pi/src/tools/write.ts` | Wrap in mutation queue |
| `packages/bodhi-pi/src/tools/grep.ts` | `... [truncated]` marker (line 35) |
| `packages/bodhi-pi/src/tools/_text-encoding.ts` | **NEW** — `detectLineEnding`, `restoreLineEndings`, `stripBom` |
| `packages/bodhi-pi/src/tools/file-mutation-queue.ts` | **NEW** — `withFileMutationQueue` |
| `packages/bodhi-pi/test/fs.test.ts` | Add edit/BOM/CRLF/grep-marker cases |
| `packages/bodhi-pi/test/file-mutation-queue.test.ts` | **NEW** |
| `packages/bodhi-pi/test/streaming-tool-output.test.ts` | **NEW** |
| `packages/bodhi-pi-{cli,browser,chrome-ext,ws-frontend,http}/...` | Streaming e2e + tool-card preview render path |
| `packages/bodhi-pi/PARITY.md` | Add Phase H section: 6 rows, all ✅ at completion |

---

## Execution order

1. Audit + tests scaffold (failing): core streaming + edit-encoding + mutation
   queue + grep marker.
2. Implement `_text-encoding.ts`; modify `edit.ts`. Green.
3. Implement `file-mutation-queue.ts`; wrap `edit.ts` + `write.ts`. Green.
4. Modify `grep.ts` marker; update existing assertion. Green.
5. Modify `agent.ts` streaming wire-through; green streaming test.
6. Build `bodhi-pi-browser` dist.
7. Per-host streaming e2e — cli → web → chrome-ext → ws-frontend → http.
8. `just test` repo-wide; restore `models.generated.ts`; update PARITY.md.
9. Single commit: `feat(bodhi-pi): tooling hardening (Phase H)` with the
   `Co-Authored-By` trailer.

---

## Verification

End-to-end signals a reviewer can run:
- `cd packages/bodhi-pi && npm test -- file-mutation-queue streaming-tool-output fs` — all green.
- `just test` from repo root — green (modulo confirmed-flaky specs).
- Manual: seed a CRLF file via examples workspace; ask the agent to edit a
  line; reopen and assert `\r\n` survives.
- Manual (web host): run a slow faux-streaming tool; watch the tool-card
  preview update mid-flight (DOM `data-tool-call-preview` changes visible
  before status flips to `completed`).
- `packages/bodhi-pi/PARITY.md` reflects six new ✅ rows under a Phase H
  heading.
