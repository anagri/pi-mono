# Plan: bodhi-pi modes phase 2 — ask-mode + native ACP `requestPermission` (milestone 040)

## Context

Phase 0 (010+020) made mode settable/persisted/advertised; phase 1 (030) made **plan mode** actually enforce via `PermissionService.evaluateToolCall` + a `beforeToolCall` gate that emits `tool_blocked` and appends a `custom_message` on deny. Today plan mode is the only mode that rejects calls — `ask`/`edit` presets are `EMPTY_POLICY` (effectively allow-all).

This phase makes **ask mode** actually enforce. Tool calls that resolve to `ask` trigger a native ACP `conn.requestPermission(...)` round-trip with 4 options (`allow_once`, `allow_always`, `reject_once`, `reject_always`), suspend the tool until the user responds (or a 30s timeout / `session/cancel` fires), and decode the outcome into allow/deny. `allow_always` / `reject_always` remember the decision in an in-memory per-session grant map (persistent rules ship in ms 100). This is the next-logical dependency on the path to manually testing the full permission UX, and it exercises the suspend-and-resume machinery that 050/060/070 reuse.

The work is split (user-locked) into **Phase A** (ACP-direct: integration + shared e2e, programmatic approval queue) and **Phase B** (composer-typed slash for Playwright + e2e-ui). Each phase is its own commit cluster, each individually green on `npm run check` + `npm test`.

## 1. Goal restatement

Quoting `040-ask-mode-and-approval-flow.md` § "Goal" with the phase-2 locked delta applied:

> Wire the policy engine and the approval round-trip end-to-end so that `ask` mode actually enforces decisions. `MODE_PRESETS.ask` becomes real: `read`+`search` auto-allow; `edit`/`execute`/`mcp`/`other` resolve to `ask` and trigger `conn.requestPermission(...)` with 4 options (`allow_once`, `allow_always`, `reject_once`, `reject_always`). `subagent` AUTO-ALLOWS in ask mode. Allow-once/allow-always lets the tool run; reject blocks it. Allow-always remembers the toolName in an in-memory session grant map. 30s configurable timeout; `session/cancel` resolves pending approvals as cancelled.

Phase-2 delta vs. the original milestone draft: **4 options not 6** (Codex scope-encoded `optionId` deferred to ms 100); **no per-Host UI modals** (composer-typed slash for Playwright, programmatic queue for Vitest — per `test-apps/CLAUDE.md` doctrine); **no new wire methods** (native `session/request_permission` only).

## 2. Locked-scope summary

| Decision | Locked answer |
|---|---|
| Phase scope | Phase A (ACP-direct) → Phase B (slash composer + Playwright); each its own commit cluster |
| Option set | 4 options: `allow_once`, `allow_always`, `reject_once`, `reject_always`. 6-option scope-encoding deferred to ms 100 |
| Timeout | `permission.approvalTimeoutMs` setting; default 30000; raced in the await against `setTimeout` |
| Existing test triage | Harness `autoApproveAll: true` default keeps every existing test green; approval tests opt-in `false` + `approvalResponses` queue |
| Pending tool surface | `tool_call` notification carries `status: "pending"` on enter; flips to `failed` on reject (pi-agent-core re-emits `in_progress` on allow) |
| Subagent in ask mode | **Auto-allow** — `subagent` category resolves to `allow`; child sessions inherit parent mode (already wired); the parent→child `subagent` call does NOT prompt |
| Slash shape (Phase B) | `/approve [once\|always]` and `/reject [once\|always]`; default scope `once` |
| Composer placeholder while pending | `"awaiting approval; type /approve or /reject"` (runtime-equivalent in CLI) |
| Edit-mode enforcement | **Deferred to ms 050** — `edit` preset stays `EMPTY_POLICY` |
| Wire methods added | **None** — native `session/request_permission` covers the round-trip |
| Persistent rules | In-memory `permissionGrants` this phase; KV-persistence in ms 100 |
| `mode_change` clears grants | Switching modes mid-session clears `permissionGrants` (an `allow_always` from ask mode must not leak into edit mode) |
| Subagent inheritance + grants | Child does NOT inherit parent's `permissionGrants` (per-session runtime) |
| Compaction bypass | Compaction-internal model calls SKIP the gate via a `bypassPermissions` flag on `SessionRuntime` |
| `tool_blocked` on reject | Reused from 030 — both `tool_approval_response{kind:"reject_*"}` AND `tool_blocked{reason}` fire |

## 3. Open-question resolutions

User delegated the three design questions ("explore thoroughly, recommend, be consistent with architecture"). Resolutions:

| Q | Resolution | Grounding |
|---|---|---|
| Q1 — emit `tool_call{status:"pending"}`? | **Yes, emit pending.** SDK `ToolCallStatus = "pending"\|"in_progress"\|"completed"\|"failed"` (`types.gen.d.ts:4985`) — valid. Emitted from `PermissionService` (which now holds `conn`) before awaiting. | Locked-scope table; SDK type verified |
| **Q2 — where the await lives** | **Inside `PermissionService`.** `evaluateToolCall` gains a `conn` dep, awaits `requestPermission` internally, races timeout+cancel, mutates grants, emits approval events, returns `allow\|deny`. Public return stays `allow\|deny`; the gate is structurally unchanged. | Repo `src/` layout doctrine (domain folders own their `*Service`); kickoff lines 31/33/34 + anti-pattern; clean event split (service owns approval-lifecycle, gate owns block-lifecycle). Kickoff's dissenting Q2 (B) contradicts its own anti-pattern. |
| Q3 — Phase B slash interception | **Client-side registry.** The Client peeks the composer line; if an approval slash + a pending request exists, it resolves locally and sends nothing to the Agent. Option B (new wire method) dropped — violates "no new wire methods". | Locked anti-pattern |
| Q4 — double-resolution of a toolCallId | **No concern.** No dedup in pi-agent-core; the Client `updateToolCall` upserts by `toolCallId`; one resolution path per server-side `correlationId`. | pi-agent-core trace |
| Q5 — test layout | Integration: `test/ask-mode-policy.test.ts` + `test/ask-mode-approval-flow.test.ts`. e2e: `e2e/shared/ask-mode.e2e.ts`. e2e-ui: `e2e-ui/shared/ask-mode.spec.ts`. Folder shape follows `feedback_bodhi_pi_e2e_layout` (helpers/`<runtime>`/). | Memory + kickoff |
| Q6 — `requestPermission` after `tool_call` | **Order preserved** — `PermissionService` does sequential awaits: `conn.sessionUpdate(tool_call,status:pending)` THEN `conn.requestPermission(...)`. | ACP spec; sequential awaits |
| Q7 — slash router placement | CLI `test-apps/cli/src/client/lib/commands.ts`; browser/chrome-ext/http via shared `test-apps/browser/src/client/lib/slash-router.ts`. Each gains a pending-approval registry cleared on session-change/cancel. | Host wiring |
| Q8 — `pattern` field shape | **`pattern = toolName`** (degenerate but valid; becomes a glob in ms 100). Keeps wire shape stable. | Forward-compat |
| **NEW-1 — wire-forward approval events?** | **Yes, both rails.** Add forwarders in `event-wiring.ts` mirroring `tool_blocked`; add 2 rows to `acp.md`. | Repo CLAUDE.md hard pillar "Major components expose lifecycle events on both rails" (4 mandatory steps incl. `extNotifications` regression test) + `test-apps/CLAUDE.md` doctrine + 030 precedent. **Supersedes the 005 "in-process only" TL;DR note** (written pre-implementation) — reconcile 005. |
| **NEW-2 — HTTP approval transport** | **WS-only; document SSE gap.** WS client already implements `requestPermission` (`ws/transport.ts:26-31`); HTTP+SSE `http-acp-conn.ts` throws (server→client request needs a response-bridge SSE can't carry trivially). Phase B approval e2e-ui covers browser/chrome-ext/cli/http-WS; SSE approval is a documented deferred gap. | `feedback_skip_blocked_features`; proportionality |

## 4. File-level inventory

### `src/` (Phase A)

| File | Change |
|---|---|
| `src/permissions/types.ts` | Widen the **internal** `ApprovalDecision`/add an `AskResolution` discriminant used only inside `PermissionService`; public `evaluateToolCall` return stays `{kind:"allow"} \| {kind:"deny";reason}`. Add `PermissionGrant = "allow"\|"deny"`. |
| `src/permissions/presets.ts` | Add `ASK_POLICY` and wire `MODE_PRESETS.ask.policy` = `{ read:"allow", search:"allow", subagent:"allow", edit:"ask", execute:"ask", mcp:"ask", other:"ask" }`. |
| `src/permissions/permission-service.ts` | Add `conn` to `PermissionServiceDeps`; resolve `ask` category by checking `permissionGrants` first, else emit pending `tool_call`, emit `tool_approval_request`, register a `pendingApprovals` entry, `await Promise.race([requestPermission, timeout, cancel])`, decode outcome → kind, emit `tool_approval_response`, mutate `permissionGrants` on `*_always`, emit `tool_call{status:"failed"}` on reject, return `allow\|deny`. Build the 4 `PermissionOption`s. Read `approvalTimeoutMs` from settings. Clear grants in `setMode`. |
| `src/sessions/session-state.ts` | Add to `SessionRuntime`: `pendingApprovals: Map<string,{resolve:(r:RequestPermissionResponse)=>void; toolCallId:string}>`, `permissionGrants: Map<string,PermissionGrant>`, `bypassPermissions: boolean`. Initialise in the bootstrap that constructs runtime. |
| `src/sessions/session-bootstrap.ts` | Gate (`beforeToolCall`, ~182-226): **structurally unchanged** — add a `bypassPermissions` short-circuit (`if (session?.runtime.bypassPermissions) return undefined;`) before `evaluateToolCall`. Existing `tool_blocked`+`custom_message` deny-path keeps working on the resolved deny. |
| `src/acp/agent.ts` | Pass `conn: this.conn` into `PermissionService` construction (~257-268). In `cancel()` (672-677): walk `session.runtime.pendingApprovals`, resolve each with `{outcome:{outcome:"cancelled"}}`, clear the map. |
| `src/acp/event-wiring.ts` | Add two forwarders mirroring the `tool_blocked` line (69): `appendHandlers("tool_approval_request", …)` + `appendHandlers("tool_approval_response", …)`. |
| `src/sessions/compaction-orchestrator.ts` | Set `session.runtime.bypassPermissions = true` around the compaction-internal model call; reset in `finally`. (`runCompaction` summarisation only — NOT the overflow-recovery prompt replay, which is real user work and gates normally.) |
| `src/settings/*` (settings schema) | Add `permission.approvalTimeoutMs` (number, default 30000) to the settings schema + defaults. |

`src/events/types.ts` — **no change**; `ToolApprovalRequestEvent`/`ToolApprovalResponseEvent`/`ToolApprovalKind` already exist (310-336).

### Test harness + tests (Phase A)

| File | Change |
|---|---|
| `test/helpers/harness.ts` | Add `approvalResponses?: RequestPermissionResponse[]` + `autoApproveAll?: boolean` (default `true`) to `TestHarnessOptions`. Client stub `requestPermission` (97): if `autoApproveAll` → return `{outcome:{outcome:"selected",optionId:"allow_once"}}`; else shift from `approvalResponses`; empty → `{outcome:{outcome:"cancelled"}}`. |
| `test/ask-mode-policy.test.ts` | NEW. Asserts `ask` preset categories produce `allow` (read/search/subagent) vs `ask`→prompt (edit/execute/mcp/other) decisions via `evaluateToolCall` with a deterministic queue. |
| `test/ask-mode-approval-flow.test.ts` | NEW. Full round-trip: allow_once / allow_always(+grant skips 2nd prompt) / reject_once / reject_always(+deny grant) / cancel / timeout / mode_change-clears-grants / compaction-bypass / subagent-auto-allow. Asserts `tool_approval_request`+`tool_approval_response` on `harness.extNotifications` (wire forwarder proof). |
| `e2e/shared/ask-mode.e2e.ts` | NEW. gpt-4o-mini prompted to call `write`; programmatic queue resolves `allow_once`; assert file written + `tool_approval_response` extNotification present. Self-contained (bootstraps own adapters). |

### `test-apps/` (Phase B)

| File | Change |
|---|---|
| `test-apps/cli/src/client/lib/commands.ts` | Add pending-approval registry + `/approve [once\|always]` + `/reject [once\|always]` handlers (resolve local pending; "no approval pending" fall-through). |
| `test-apps/cli/src/client/repl.ts` | Replace the invalid `{outcome:{outcome:"approved"}}` (71) with a registry-backed promise; set composer/prompt placeholder to "awaiting approval". |
| `test-apps/browser/src/client/lib/slash-router.ts` | Add `/approve` + `/reject` cases backed by a pending-approval registry. |
| `test-apps/browser/src/client/runtime/adapter.ts` | Replace `requestPermission: async () => ({outcome:{outcome:"cancelled"}})` (115) with a registry-backed promise. |
| `test-apps/browser/.../AppShell.tsx` | Push pending into the registry; dim composer placeholder to "awaiting approval; type /approve or /reject". chrome-ext + http inherit via subpath imports. |
| `test-apps/http` (WS) | `ws/transport.ts` already supports `onPermissionRequest` (26-31) — wire it to the shared registry. SSE: no change (documented gap). |
| `e2e-ui/shared/ask-mode.spec.ts` | NEW Playwright. Default `ask` mode → prompt triggers `write` → placeholder reads "awaiting approval" → type `/approve once` → assert tool completes + `tool_approval_response` in EventsPanel. Runs across browser/chrome-ext/http-WS. |

### Specs (same-commit with code)

| File | Change |
|---|---|
| `ai-docs/specs/bodhi-pi/modes.md` | Flip 040 row ☐→☑ (~151); add an "ask-mode approval flow" section. |
| `ai-docs/specs/bodhi-pi/acp.md` | Add `tool_approval_request` + `tool_approval_response` bullets to LIFECYCLE_EVENT_METHOD list (after `tool_blocked`, ~132); note pending `tool_call{status}` behaviour. |
| `ai-docs/specs/bodhi-pi/hosts.md` | Per-Host `/approve`+`/reject` slash router note; HTTP+SSE approval gap (WS-only). |
| `ai-docs/research/modes/milestones/040-ask-mode-and-approval-flow.md` | Fix H1 `Milestone 030`→`Milestone 040`; add a phase-2 scope-delta note (4 options, no modals). |
| `ai-docs/research/modes/milestones/005-acp-architecture-decision.md` | Reconcile the "approval events in-process only" note → wire-forwarded per the both-rails pillar. |
| `ai-docs/specs/bodhi-pi/configuration.md` | Document `permission.approvalTimeoutMs`. |

`lifecycle.md` — no change (no new SessionEntry type; `custom_message` reused).

## 5. Per-commit slices

Atomic commits per `feedback_atomic_commit_with_reset` (single chained `git reset . && git add <paths> && git commit ...`).

### Phase A

- **A1** `bodhi-pi modes 040a: ask preset + PermissionService internal API + runtime state` — `ASK_POLICY`/`MODE_PRESETS.ask`; internal ask-resolution types; `SessionRuntime.pendingApprovals`+`permissionGrants`+`bypassPermissions`; `conn` into `PermissionServiceDeps`; `approvalTimeoutMs` setting. No await wiring yet. Gate: `bypassPermissions` short-circuit. *Gate: `npm run check` + `npm test` (existing green via `autoApproveAll` default not yet needed since ask still falls through — keep inert until A2).*
- **A2** `bodhi-pi modes 040b: PermissionService orchestrates requestPermission + timeout + cancel + grants + events` — full await/race/decode in `evaluateToolCall`; pending `tool_call` + `tool_approval_request`/`response` emission; grant mutation; `setMode` clears grants; `agent.cancel()` resolves pending; `event-wiring.ts` forwarders; compaction `bypassPermissions`. *Gate: `npm run check` + `npm test`.*
- **A3** `bodhi-pi modes 040c: harness approval queue + integration tests + shared e2e + specs` — `approvalResponses`/`autoApproveAll`; `ask-mode-policy.test.ts` + `ask-mode-approval-flow.test.ts`; `e2e/shared/ask-mode.e2e.ts`; modes.md/acp.md/005/040/configuration.md. *Gate: `npm run check` + `npm test` + `npm run test:e2e` (ask-mode e2e).*

### Phase B

- **B1** `bodhi-pi modes 040d: per-Host requestPermission Client + pending-approval registry` — cli `commands.ts`+`repl.ts`; browser `slash-router.ts`+`adapter.ts`+`AppShell`; http-WS wiring; chrome-ext via subpath. *Gate: `npm run check` + `npm test` + per-Host unit/build.*
- **B2** `bodhi-pi modes 040e: Playwright ask-mode spec + hosts.md` — `e2e-ui/shared/ask-mode.spec.ts`; hosts.md slash-router + SSE-gap note; modes.md sanity. *Gate: `just test-e2e-ui` (or scoped Playwright) green across browser/chrome-ext/http-WS.*

## 6. Verification matrix

| After | Command(s) | Asserts |
|---|---|---|
| A1 | `npm run check && npm test` (in `packages/bodhi-pi`) | Types compile; existing suite green; ask still inert |
| A2 | `npm run check && npm test` | Round-trip resolves; extNotifications carry approval events; cancel/timeout/grants behave |
| A3 | `npm test` + `OPENAI_API_KEY=… npm run test:e2e -- ask-mode` | Real-LLM `write` approved via queue; file written; approval event present |
| B1 | `npm run check && npm test` + `npm --workspace …cli run build` + browser/chrome-ext unit | Slash router decodes `/approve`/`/reject`; registry resolves; no UI modal added |
| B2 | `just test-e2e-ui` (scoped to `ask-mode.spec.ts`) | Composer-slash flow drives approval across browser/chrome-ext/http-WS; tool completes; event in EventsPanel |

All suites self-contained (bootstrap own adapters/fixtures); **no `.skip`** — fix on failure, never drop coverage.

## 7. Risk register

- **pi-agent-core suspending the `beforeToolCall` hook for up to 30s** — verify the agent loop tolerates a long-awaited hook without aborting; the timeout race guarantees a bounded resolve. Mitigation: `approvalTimeoutMs` default 30000 + cancel path.
- **HTTP per-turn agent rebuild loses `pendingApprovals`** — acceptable: a rebuild also voids the in-flight prompt, so the pending request is naturally void. Document; the WS path (persistent connection) is the approval-capable HTTP transport.
- **HTTP+SSE can't carry `requestPermission`** — documented gap; WS covers the HTTP runtime for approval e2e-ui (NEW-2).
- **Subagent auto-allow tradeoff** — parent→child `subagent` call doesn't prompt (cleaner UX over strict cascade); child's own tools still gate if child runs ask mode. Revisit in ms 100.
- **Slash collision** — a user prompt literally starting with `/approve` outside an approval context must fall through to normal slash handling ("no approval pending"), not be consumed. Covered by registry-empty fall-through.
- **`reject_always` needs a deny memory** — `permissionGrants` is `Map<string,"allow"|"deny">` (not a bare Set) so reject_always short-circuits future calls to deny without prompting.
- **005 supersession** — wire-forwarding approval events contradicts the 005 TL;DR; reconciled in 005 same-commit so the spec set stays internally consistent.

## 8. Out of scope

Edit-mode enforcement (050); `submit_plan` + plan→edit auto-transition (060); allow-all guardrails/safety-immune deny (070); subagent profile mode field + Qwen rule (080); active-tools swap (090); persistent KV rules + 6-option scope-encoding (100); UI modals for approval (never — test-apps doctrine); HTTP+SSE approval transport (deferred, WS covers HTTP).

## 9. Post-implementation deliverables (per user follow-up)

After B2 lands and the matrix is green:

1. **Specs updated** — all of §4's spec rows landed same-commit with their code (modes.md/acp.md/hosts.md/005/040/configuration.md).
2. **Tests cover + pass + self-contained, no skips** — integration (`ask-mode-policy`, `ask-mode-approval-flow`), e2e (`ask-mode.e2e`), e2e-ui (`ask-mode.spec`) all run bootstrapping their own deps; run them, fix failures, never drop coverage.
3. **Commit** each cluster (A1–A3, B1–B2) atomically.
4. **Next-milestone prompt** — write `ai-docs/prompts/2026-05-19-bodhi-pi-modes-p3-edit-mode-preset.md` (milestone 050) in the same kickoff shape as the p1/p2 prompts, plus capture pending tasks: HTTP+SSE approval bridge, ms 100 6-option scope-encoding + KV-persistent grants. Renumber/move milestone docs if 050 needs splitting, mirroring this phase's housekeeping.

## When done (report)

Print: plan path; count of open questions resolved during grilling; the proposed commit subjects in order.
