# Kickoff: bodhi-pi modes phase 3 — `edit` mode preset + out-of-workspace narrowing (milestone 050)

**Output**: implement the feature AFTER you've grilled the user on the open questions below. Read code first, batch decision points via `AskUserQuestion` (each option marked with your recommended answer), get plan approval before any code edits. Same shape as the modes p1/p2 kickoffs (`2026-05-19-bodhi-pi-modes-p1-plan-mode-plumbing.md`, `2026-05-19-bodhi-pi-modes-p2-ask-mode-approval.md`).

## Status going in

Phase 0 (010+020), Phase 1 (030, plan mode), and **Phase 2 (040, ask mode)** have shipped.

Phase 2 (040) landed in commits `d5c268b2`…`93cf8c57`:
- **040a** `d5c268b2` — ask preset + `PermissionService` internal API + `SessionRuntime` runtime state (inert).
- **040b** `04ac7673` — test-harness approval verdicts (`autoApproveAll` / `approvalResponses`) + existing-suite triage to allow-all (inert pre-stage).
- **040c** `5b880e71` — the flip: `PermissionService` orchestrates `conn.requestPermission` (race timeout + `session/cancel`), records `*_always` grants, emits `tool_approval_request`/`response` (wire-forwarded), `setMode` clears grants; unit + integration + shared e2e + specs.
- **040d** `36e1abd3` — per-Host `requestPermission` registry + composer `/approve`·`/reject` (browser/chrome-ext/http-WS); cli auto-approve fix.
- **040e** `93cf8c57` — Playwright `ask-mode.spec.ts` + hosts.md doctrine.

After phase 2:

- **The 030 gate + the ask round-trip engine are complete and reusable.** `PermissionService.evaluateToolCall` already returns `allow | deny` and internally resolves `ask`-category calls via `conn.requestPermission`. Milestone 050 is **the smallest milestone**: add ONE preset to `MODE_PRESETS` + one out-of-workspace narrowing helper. The engine already does the right thing for any preset.
- `MODE_PRESETS.edit.policy` is still `EMPTY_POLICY` (effectively allow-all) — 050 fills it.
- `runtime.permissionGrants` / `pendingApprovals` / `approvalTimeoutMs` are wired (040). No new runtime state needed.
- The harness `autoApproveAll`/`approvalResponses` + the per-Host composer-slash drivers already exist — 050 reuses them.

**Read first** (in this order):

1. `ai-docs/research/modes/milestones/000-overview.md` — the map. 050 = edit-mode preset.
2. `ai-docs/research/modes/milestones/050-edit-mode-preset.md` — the milestone brief. **Authoritative for scope.** Note: its H1 still says "Milestone 040" and references "row 040" — stale renumber leftover; fix the H1 → "Milestone 050" and the `modes.md` row reference → 050 as part of this phase (same housekeeping the p2 kickoff did for the 040 doc).
3. `ai-docs/specs/bodhi-pi/modes.md` — current state; the 050 status row flips ☑ at end of phase. Read the Phase 2 deliverables section (040) — 050 mirrors its structure with a much smaller surface.
4. `ai-docs/specs/bodhi-pi/configuration.md` — settings shape (no new setting expected for 050).
5. `packages/bodhi-pi/test-apps/CLAUDE.md` § "These are TEST-APPS, not production apps" — the binding constraint (no UI modals; programmatic queue for Vitest; composer-slash for Playwright). Edit-mode reuses the 040 drivers.

**Source pointers** (read selectively):

- `src/permissions/presets.ts` — `MODE_PRESETS.edit.policy` is `EMPTY_POLICY`. Phase 3 fills it: `{ read: "allow", search: "allow", edit: "allow", execute: "ask", mcp: "ask", subagent: "ask", other: "ask" }`. (Note 050 has `subagent: "ask"` — UNLIKE ask mode's `subagent: "allow"`. Confirm with the user: the 050 doc says ask; the ask preset auto-allows subagent. Decide whether edit mode should prompt for subagent or auto-allow it for consistency.)
- `src/permissions/permission-service.ts` — `evaluateToolCall` + `resolveAsk`. Phase 3 adds the out-of-workspace narrowing: before resolving an `edit`-category `allow`, if the edit target path is outside `session.cwd`, narrow `allow` → `ask`. Adopt `resolvePath`/`isWithinWorkspace` from `src/tools/index.ts`.
- `src/tools/index.ts` — `resolvePath` + `toolKindFor`. The path-extraction for `write`/`edit` args lives near the builtin tool defs; reuse it, don't reinvent.
- `test/ask-mode-policy.test.ts` + `test/ask-mode-approval-flow.test.ts` — the 040 integration test shape to mirror for `test/edit-mode-policy.test.ts`.
- `src/permissions/permission-evaluator.test.ts` — unit tests; add edit-mode category-mapping + out-of-workspace cases here.

## Goal

Quoting `050-edit-mode-preset.md` § "Goal":

> Add the `edit` mode preset to `MODE_PRESETS`: `read`/`search`/`edit` auto-allow; `execute`/`mcp`/`subagent`/`other` ask. Plus one refinement: `evaluateToolCall` narrows an `edit`/`write` target OUTSIDE `session.cwd` from `allow` → `ask` regardless of mode (Continue-style out-of-workspace guard). The 030/040 engine already does the rest.

End-state after phase 3:

- `MODE_PRESETS.edit.policy.categories` filled per the table.
- Out-of-workspace `edit`/`write` narrowing helper in `permission-service.ts`, applied to `edit`/`write` only (not `read`).
- Integration + unit tests for edit-mode category mapping + the narrowing rule.
- Shared e2e (`e2e/shared/edit-mode.e2e.ts`) + Playwright (`e2e-ui/shared/edit-mode.spec.ts`) reusing the 040 drivers.
- Specs: modes.md (050 ☑ + edit-preset section + narrowing rule), 050 milestone H1 fix.

## Locked scope decisions (carry over from 040 unless overridden)

| Decision | Locked answer |
|---|---|
| Engine reuse | No engine changes — 050 fills one preset + adds one narrowing helper. The 030 gate + 040 ask round-trip are reused as-is. |
| Out-of-workspace narrowing | Applies to `edit`/`write` only; `read` is exempt. Reuse `resolvePath`/`isWithinWorkspace` from `src/tools/index.ts`. Narrow `allow` → `ask` (not `deny`). |
| `respectsEditMode` per-tool annotations | **OUT** — defer. Category preset + existing `tools[name]` override suffice. |
| Wire methods / new settings | **None.** |
| Test drivers | Reuse 040's `autoApproveAll`/`approvalResponses` (Vitest) + composer-slash (Playwright). |

## Open exploration questions to resolve before designing

Resolve by reading source first, then `AskUserQuestion` (recommended answer per question).

### Q1 — `subagent` in edit mode: `ask` or `allow`?

The 050 doc says `subagent: "ask"`. But ask mode (040) auto-allows `subagent` (locked tradeoff: cleaner UX). Inconsistent. **Recommend** `subagent: "allow"` in edit mode too, for consistency with ask mode (parent→child spawn doesn't prompt; child gates its own tools). Confirm with user — they locked subagent-auto-allow in 040.

### Q2 — out-of-workspace narrowing scope: edit mode only, or all modes?

The 050 doc says "regardless of mode." But in ask mode, `edit` is already `ask` (so narrowing is a no-op there); in allow-all, narrowing to `ask` would contradict allow-all's "never prompt" contract. **Recommend** apply narrowing in `edit` mode only (where `edit` is `allow`), and explicitly NOT in allow-all (allow-all means allow-all). Plan/ask are unaffected (edit is already deny/ask). Confirm.

### Q3 — path extraction for the narrowing helper

`write`/`edit` tools carry the target path in their args. Verify the exact arg shape (`{ path }`) and reuse `resolvePath` from `src/tools/index.ts`. **Recommend** a small `editTargetPath(toolName, args)` that returns the resolved absolute path or `undefined`; `undefined` → keep `allow` (can't determine → don't over-prompt). Confirm the fail-open default.

### Q4 — test layout

**Recommend**: `test/edit-mode-policy.test.ts` (integration: edit auto-allows in-cwd, asks bash/mcp, asks out-of-cwd edit) + unit cases in `permission-evaluator.test.ts` + `e2e/shared/edit-mode.e2e.ts` + `e2e-ui/shared/edit-mode.spec.ts`. Confirm.

## Process — iterative TDD

Per `packages/bodhi-pi/CLAUDE.md` 6-step workflow. This is a small single-phase milestone (the 050 doc suggests a single commit). Suggested cadence:

- **C1** `bodhi-pi modes 050: edit preset + out-of-workspace narrowing + tests + specs` — fill `MODE_PRESETS.edit`, add the narrowing helper, unit + integration tests, shared e2e, Playwright spec, modes.md (050 ☑ + section), 050 H1 fix. Single commit if it stays green; split test-app/Playwright into a second commit only if needed.

Gate each commit: `npm run check` + `npm test` (+ `just test-e2e` / `just test-e2e-ui` where touched).

## Plan structure (mandatory sections)

Same as p2: Goal restatement; Locked-scope summary; Open-question resolutions (question → recommended → user-answer); File-level inventory; Per-commit slice + validation gate; Verification matrix; Risk register; Out of scope.

## Anti-patterns to avoid

- **Don't touch the 030 gate or the 040 ask round-trip.** 050 is preset + narrowing only.
- **Don't add `respectsEditMode` per-tool annotations.** Deferred.
- **Don't narrow out-of-workspace in allow-all mode.** Allow-all means allow-all.
- **Don't reinvent path resolution** — reuse `src/tools/index.ts::resolvePath`.
- **Don't add `node:*` imports to `src/permissions/`.**
- **Don't build a UI modal in any test-app.** Reuse the 040 composer-slash drivers.

## Carried-forward pending tasks (from 040 — schedule into a future milestone, NOT 050)

These are explicit gaps left by phase 2; capture them in `000-overview.md` / the relevant milestone doc so they aren't lost:

1. **HTTP+SSE approval bridge** — `requestPermission` is unsupported over HTTP+SSE (server→client request can't ride SSE trivially); only the WS transport carries ask-mode approval today. A bridge (SSE-delivered request + a `POST /permission-response` correlation endpoint) is deferred. (`test-apps/http/src/host/acp/http-acp-conn.ts` throws on `requestPermission`.)
2. **ms 100 — 6-option scope-encoded `optionId` set + KV-persistent grants.** Phase 2 shipped 4 options (`allow_once`/`allow_always`/`reject_once`/`reject_always`) with in-memory `runtime.permissionGrants`. The Codex 6-option scope encoding (`allow_always_session`/`_project`/`_global`) and KV persistence across sessions land in milestone 100.
3. **cli interactive `/approve`** — the cli REPL blocks on `await prompt()` mid-turn, so it auto-approves `allow_once` rather than reading a composer `/approve`. A non-blocking REPL refactor (event-driven readline + input queue) would enable interactive approval; deferred.

## When done

Print: the plan path, the count of open questions resolved during grilling, and the proposed commit subjects in order. Do not start executing — the plan IS the deliverable. Implementation runs in a separate session.
