# Phase H — Tooling hardening (excluding `bash`)

**Read first:** `ai-docs/prompts/process.md` (working rules + retrospective)
AND `ai-docs/prompts/group-0-upstream-alignment.md` (Phase 0 should land
first — affects whether `_accumulate.ts` adopts `harness/utils/truncate.ts`).
**Reference impl:** `packages/coding-agent/src/core/tools/` (edit, grep,
file-mutation-queue, streaming tool-call updates).
**Current state:** `packages/bodhi-pi/PARITY.md`.
**Source intent:** `ai-docs/parity-post-extension.md` §3.2.

> **Upstream context (2026-05-11):** The 0.74 sync introduced
> `harness/utils/truncate.ts` (and `shell-output.ts` / `executeShellWithCapture`
> for the future bash phase). Phase 0's audit decides whether bodhi-pi's
> `tools/_accumulate.ts` adopts the harness helper or stays parallel.
> No other change to this phase's surface.

> **Explicitly out of scope:** the `bash` tool + Terminal interface. That's
> its own phase (large surface: streaming, abort, exit-code, optional
> pluggable SSH ops). Everything else in §3.2 is in.

---

## Functional outcomes

After this phase a user of any bodhi-pi reference host should observe:

1. **Tool output streams during execution** instead of arriving as one
   post-hoc block. Long-running tools (e.g. a slow `grep` over a big tree,
   or future `run_script` streaming) surface progressive `tool_call_update`
   notifications. UIs that consume `data-tool-status` see `running →
   completed` cleanly; the tool-card preview updates while the tool runs.
2. **`edit` preserves line endings.** A file with CRLF stays CRLF after
   edit; LF stays LF. No silent corruption when a Windows-authored file
   round-trips through the agent.
3. **`edit` preserves UTF-8 BOM** when present.
4. **`edit` rejects ambiguous `old_string`.** If `old_string` matches more
   than once and `replace_all` is not requested, the call fails with a
   clear error telling the model to disambiguate. Today the behaviour is
   permissive; coding-agent enforces this.
5. **Concurrent file mutations within a session do not race.** If the
   model issues two `edit` tool calls against the same path in parallel,
   they serialize. No interleaved writes.
6. **`grep` truncates pathologically long lines.** Lines longer than ~500
   chars get a clear truncation marker so the model sees a usable
   snippet, not a screen-eating wall.

Each is observable through the public ACP/UI surface (tool-call cards,
tool-result content, optional system messages).

---

## Rough directional pointers

- **Streaming tool output:** ACP's `tool_call_update.content` already
  supports chunks (per the parity report). Today
  `packages/bodhi-pi/src/tools/_accumulate.ts` (`accumulateBounded`) does
  post-hoc bounded accumulation. Look at how `tool_execution_update`
  events flow in `packages/bodhi-pi/src/acp/agent.ts:subscribeToAgent` —
  there's a missing wire-through. Coding-agent's tool-execution emits
  partial results; bodhi-pi receives them but doesn't relay.
- **Edit improvements:** all four (line-ending, BOM, uniqueness, atomicity)
  live in `packages/bodhi-pi/src/tools/edit.ts`. Read coding-agent's
  `packages/coding-agent/src/core/tools/edit.ts` for the reference
  behaviour. Cross-check the existing test in
  `packages/bodhi-pi/test/` (search for edit-tool tests).
- **File-mutation queue:** coding-agent's
  `packages/coding-agent/src/core/tools/file-mutation-queue.ts` is the
  exact pattern. It's session-scoped (one queue per session). Decide
  whether the queue lives in `SessionState` or wraps the tool registry.
- **`grep` truncation:** `packages/bodhi-pi/src/tools/grep.ts` —
  coding-agent's `grep` truncates at 500 chars/line. Audit current
  behaviour first.

---

## Test signals to design for

Functional, blackbox:

- **Streaming:** faux harness that returns a tool-execution with partial
  results. Test asserts the host receives ≥2 `tool_call_update`
  notifications with `content` (i.e. `update.content` chunks) before
  `status: "completed"`. Browser-host e2e: tool-call card's preview text
  visibly updates mid-stream (via `data-tool-call-preview` attribute
  changes — Playwright `toContainText` retries).
- **Edit line endings:** seed a file with `"line1\r\nline2\r\n"`; agent
  edits "line1" to "line1-new"; reload file and assert
  `"line1-new\r\nline2\r\n"`. Repeat for LF.
- **Edit BOM:** seed a file with `﻿` prefix; edit; assert BOM still
  present.
- **Edit uniqueness:** seed `"x\nx\nx\n"`; edit `old_string: "x"` without
  `replace_all`; assert the tool returned an error referencing
  "multiple matches" or similar. The model should see the error and
  re-issue with `replace_all` or a more specific match.
- **File-mutation queue:** faux harness that fires two `edit` calls on
  the same path in parallel (via a single assistant message with two
  tool-use blocks). Read the file after both complete; assert both edits
  applied, not interleaved. Lower-level: each edit observes the previous
  edit's output as its baseline.
- **`grep` truncation:** seed a file with a 2000-char line containing a
  match; run grep; assert the result has a truncation marker (e.g.
  `[...N chars truncated]`) and the visible match is preserved.

If a test would require whitebox access (e.g., inspecting an internal
queue state), surface that state via a new `_bodhi-pi/<area>/<verb>`
extension method or, for tool behaviour, prefer end-to-end functional
verification (read-back the file after the operation).

---

## Open questions to confirm before coding

- **Streaming chunk size + frequency.** coding-agent emits partial
  results on a natural cadence; pick a heuristic (e.g., every N bytes /
  every K ms) and confirm with the user.
- **`replace_all` semantics on partial collisions.** Should
  `replace_all: false` + 1 unique match succeed (vs current behaviour)?
- **File-mutation queue scope.** Per session, per workspace, or per
  filesystem? Coding-agent uses per-session; confirm that matches
  bodhi-pi's session-isolated model.
- **`grep` truncation marker shape.** Reuse `accumulateBounded`'s footer
  format or a distinct per-line marker.

---

## Boundaries

In scope:

- Streaming tool output via `tool_call_update.content`
- Edit: line-ending preservation (CRLF/LF)
- Edit: UTF-8 BOM preservation
- Edit: `old_string` uniqueness validation
- File-mutation queue (concurrent writes/edits serialize within a session)
- `grep` long-line truncation

Explicitly out of scope (defer):

- `bash` tool + Terminal interface (separate phase — much larger surface)
- Bash output full-output spool to temp file (only meaningful with bash)
- Pluggable ops for remote/SSH file & tool execution (§3.2 P3, niche)
- Image-bearing tool results (in Group 7 phase)
- README auto-link in `read` (§3.2 P3, "noisy for agents — skip")
