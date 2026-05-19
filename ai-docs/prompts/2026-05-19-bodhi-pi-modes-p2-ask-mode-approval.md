# Kickoff: bodhi-pi modes phase 2 — ask-mode + native ACP `requestPermission` (milestone 040)

**Output**: implement the feature AFTER you've grilled the user on remaining open questions below. Read code first, batch decision points via `AskUserQuestion` (each option marked with your recommended answer), get plan approval before any code edits. Same shape as the modes p1 kickoff (`2026-05-19-bodhi-pi-modes-p1-plan-mode-plumbing.md`).

## Status going in

Phase 0 (010 + 020) shipped in `c93fc25a`: mode is settable/persisted/advertised/observable, every preset inert.
Phase 1 (030) shipped in commits `6fa4b7d1`…`fd13b276` + follow-up `665198d3`: **plan mode now actually enforces**. `PermissionService.evaluateToolCall(sessionId, { name, arguments })` returns `{ kind: "allow" | "deny", reason? }`; the `createPiAgent` `beforeToolCall` gate calls it, emits `tool_blocked` lifecycle events, and appends a `custom_message` entry on deny. MCP annotations plumbing landed in C1; preset + evaluator + redirect template in C2; gate + events + suffix in C3; 4-Host `tool_blocked` rendering in C4; shared e2e + Playwright spec + spec docs in C5.

After phase 1:

- **Plan mode** is the only mode that rejects calls today. Ask/edit/allow-all keep `EMPTY_POLICY` (effectively allow). The 040 milestone makes **ask mode** actually enforce — this is the next-logical-dependency on the path to manually testing the full permission UX.
- The `tool_call` event dispatcher already supports async `{ block?, reason? }` returns; `beforeToolCall` already awaits the gate.
- `PermissionService` already has the `sessions` map + `events` dispatcher + `appendEntry` callback wired through `BodhiPiAcpAgent`'s `bootstrapDeps()`.
- The test-harness Client stub already has a `requestPermission: async () => ({ outcome: { outcome: "cancelled" } })` — phase 2 replaces the test-side handler with a programmable queue (Vitest) + a composer-slash route (Playwright).

The user explicitly locked **iterative-evolutionary phasing**: split the slab into Phase A (ACP-direct only, integration + shared e2e) and Phase B (composer-slash for Playwright + e2e-ui). Each phase is its own commit cluster, each individually green on `npm run check` + `npm test`.

**Read first** (in this order):

1. `ai-docs/research/modes/milestones/000-overview.md` — the map. Note the renumbering: ask-mode-and-approval-flow is now `040`, edit-mode-preset is `050`, plan-mode-submit-plan-tool is `060`, etc. The body of `040-ask-mode-and-approval-flow.md` still says "Milestone 030" in its H1 — that's a stale heading from the rename; fix as part of this phase.
2. `ai-docs/research/modes/milestones/005-acp-architecture-decision.md` — locks the design at `session/request_permission` (native ACP), no new wire methods, scope encoded in `optionId`. **Still binding.**
3. `ai-docs/research/modes/milestones/040-ask-mode-and-approval-flow.md` — the milestone-level brief. **Authoritative for scope, but read with the locked-decision delta below in mind — phase-2 trims the milestone scope from the original draft.**
4. `ai-docs/specs/bodhi-pi/modes.md` — current state of the spec; the implementation-status row for 040 flips ☑ at end of phase.
5. `ai-docs/specs/bodhi-pi/acp.md` § "LIFECYCLE_EVENT_METHOD notifications" — `tool_blocked` row landed in 030; add `tool_approval_request` + `tool_approval_response` rows in this phase.
6. `packages/bodhi-pi/test-apps/CLAUDE.md` § "These are TEST-APPS, not production apps" — **THE binding constraint**. No UI modal for approvals. Vitest uses an in-memory response queue; Playwright drives via composer-typed slash (`/approve once` etc.).
7. Phase 1 retro: commit messages `6fa4b7d1`…`fd13b276` + `665198d3`. The dispatch-ownership refactor + gate hook + custom_message rendering + per-Host event-forwarder maps all already shipped — phase 2 extends rather than reworks them.

**Source pointers** (read selectively):

- `packages/bodhi-pi/src/permissions/permission-service.ts` — `evaluateToolCall` impl + redirect template. Phase 2 extends the decision union to `{ kind: "ask" }` (decoded internally; never surfaced) and the impl awaits `conn.requestPermission` → ApprovalDecision.
- `packages/bodhi-pi/src/permissions/presets.ts` — `MODE_PRESETS.ask.policy` is `EMPTY_POLICY`. Phase 2 fills it: `{ read: "allow", search: "allow", edit: "ask", execute: "ask", mcp: "ask", subagent: "allow" /* subagent auto-allow per locked decision */, other: "ask" }`.
- `packages/bodhi-pi/src/permissions/types.ts` — `ApprovalDecision` is `{ kind: "allow" } | { kind: "deny", reason }`. **Don't widen** the public surface — keep the await-and-resolve loop internal to `PermissionService`. The gate consumes only `allow` / `deny`.
- `packages/bodhi-pi/src/sessions/session-bootstrap.ts:171-204` — the gate. Phase 2 doesn't change the gate itself; the new behaviour rides through `evaluateToolCall`. The gate's existing `tool_blocked` emit + `custom_message` append continues to fire on the resolved `deny` outcome.
- `packages/bodhi-pi/src/acp/agent.ts` constructor — has `this.conn: AgentSideConnection`. Phase 2 passes `conn` into `PermissionService` deps so the service can `await this.conn.requestPermission(...)` when the active policy says `ask`.
- `packages/bodhi-pi/src/sessions/session-state.ts` — `SessionRuntime` already has `mode`, `cancelled`, `leafId`. Phase 2 adds `pendingApprovals: Map<correlationId, { resolve, reject }>` + `permissionGrants: Set<string>` (in-memory only; persistent rules land in milestone 100).
- `packages/bodhi-pi/src/acp/agent.ts` `cancelSession(...)` — phase 2 walks `pendingApprovals` and resolves each with `{ outcome: { outcome: "cancelled" } }`.
- `packages/bodhi-pi/src/events/types.ts` — `ToolApprovalRequestEvent` + `ToolApprovalResponseEvent` types already exist (added in 010); phase 2 wires emitters + the lifecycle forwarder.
- `packages/bodhi-pi/src/acp/event-wiring.ts:53-69` — pattern for adding the two new lifecycle forwarders. Mirror the `tool_blocked` line landed in 030.
- `packages/bodhi-pi/test/helpers/harness.ts:90-99` — Client stub. Phase 2 adds `approvalResponses?: ApprovalResponse[]` queue + `autoApproveAll?: boolean` (default `true` so existing tests stay green; tests about the approval flow opt-in to `false`).
- `packages/bodhi-pi/test-apps/{cli,browser,http,chrome-ext}/src/client/...` — phase B's slash router. The CLI `repl.ts` already wires `requestPermission: async () => ({ outcome: { outcome: "approved" } })`; the browser `AppShell` doesn't have a `requestPermission` handler yet (it relies on the SDK default of cancel). Phase B replaces both with a composer-typed slash route.

**ACP SDK reference**:

- `node_modules/@agentclientprotocol/sdk` — `RequestPermissionRequest`, `RequestPermissionResponse`, `PermissionOption`, `RequestPermissionOutcome`. The `outcome: "selected"` shape carries `optionId`; `outcome: "cancelled"` carries nothing. **No new wire methods are added in phase 2.**

## Goal

Quoting `040-ask-mode-and-approval-flow.md` § "Goal", with the phase-2 locked-decision delta applied:

> Wire the policy engine and the approval round-trip end-to-end so that `ask` mode actually enforces decisions. `MODE_PRESETS.ask` becomes real: `read`+`search` auto-allow; `edit`/`execute`/`mcp`/`other` resolve to `ask` and trigger `conn.requestPermission(...)` with 4 options (`allow_once`, `allow_always`, `reject_once`, `reject_always`). `subagent` AUTO-ALLOWS in ask mode (per locked decision below). Allow-once/allow-always lets the tool run; reject blocks it. Allow-always adds the toolName to an in-memory session grant set (persistent rules ship in milestone 100). 30s configurable timeout; `session/cancel` resolves pending approvals as cancelled.

End-state after phase 2:

- `MODE_PRESETS.ask.policy.categories` is filled per the table below.
- `PermissionService.evaluateToolCall(...)` internally resolves `ask`-category calls by calling `await this.conn.requestPermission(...)` with 4 options, races against `session/cancel` + 30s timeout, decodes the response into `allow` / `deny` for the gate.
- `pendingApprovals` + `permissionGrants` live on `SessionState.runtime`.
- `tool_approval_request` + `tool_approval_response` lifecycle events fire on both rails (in-process EventDispatcher + ACP wire).
- Tool-call notification carries `status: "pending"` while awaiting approval; flips to `completed` / `failed` on resolve.
- Test harness defaults `autoApproveAll: true`; tests-about-approval set it to `false` and use the `approvalResponses` queue.
- **Phase A end-state**: All of the above works in vitest integration + the shared e2e (gpt-4o-mini). No Playwright spec yet.
- **Phase B end-state**: test-app Client (browser AppShell + chrome-ext via subpath import + http frontend via the shared AppShell + cli REPL) wires a composer-typed slash router that decodes `/approve [once|always]` and `/reject [once|always]` into a `RequestPermissionResponse` and resolves the pending request. Playwright `e2e-ui/shared/ask-mode.spec.ts` lands, asserting the composer-slash flow end-to-end.

## Locked scope decisions

| Decision | Locked answer | Where it lands |
|---|---|---|
| Phase scope | Phase A (ACP-direct) → Phase B (slash composer + Playwright). Each phase is its own commit cluster. | Two top-level commit clusters |
| Approval option set | 4 options: `allow_once`, `allow_always`, `reject_once`, `reject_always`. Codex 6-option scope-encoding is deferred to ms 100 alongside persistent rules. | `PermissionService.buildApprovalOptions()` |
| Approval timeout | `permission.approvalTimeoutMs` setting; default 30000; race in `evaluateToolCall` against `setTimeout`. | new setting + `evaluateToolCall` |
| Existing test triage | Harness `autoApproveAll: true` default. Tests-about-approval explicitly set `autoApproveAll: false` + populate `approvalResponses` queue. | `test/helpers/harness.ts` |
| Pending tool surface | `tool_call_update { status: "pending" }` emitted on enter; flips to `completed`/`failed` on resolve. Parallel `tool_approval_request` lifecycle event. | gate / `subscribeToAgent` |
| Subagent in ask mode | **Auto-allow.** Subagent category resolves to `allow` in ask preset; child sessions inherit parent mode (already wired). The child's own tool calls still gate through ask-mode if the child runs in ask-mode — but the **`subagent` tool call from parent → child does NOT prompt**. (User-locked tradeoff: cleaner UX over strict cascade; revisit in ms 100.) | `MODE_PRESETS.ask.policy.categories.subagent = "allow"` |
| Slash shape (Phase B) | `/approve [once\|always]` and `/reject [once\|always]`; default scope is `once`. | test-app slash router |
| Composer placeholder while pending | `"awaiting approval; type /approve or /reject"` (or runtime-equivalent in CLI) | per-Host Client |
| Edit-mode enforcement | **Deferred to milestone 050.** `edit` preset stays `EMPTY_POLICY` in phase 2 — effectively allow-all. The gate ms 040 builds is reused there. | `MODE_PRESETS.edit` unchanged |
| Wire methods added | **None.** Native `session/request_permission` covers the round-trip; existing `_bodhi-pi/session/settings/*` covers persistent rules in ms 100. | n/a |
| Persistent rules | In-memory `permissionGrants` set this phase; KV-persistence in ms 100. | `SessionRuntime.permissionGrants` |
| Allow-all mode | Unchanged — `ALLOW_ALL_POLICY` already auto-allows every category; no approval prompt fires. | existing |
| Plan-mode behaviour | Unchanged — `MODE_PRESETS.plan` keeps category deny-list from 030. No approval prompt fires (deny short-circuits). | existing |
| `tool_blocked` event on reject | Reuse the 030 lifecycle event. `tool_approval_response { kind: "reject_once" }` and `tool_blocked { reason: "user rejected" }` BOTH fire — `tool_approval_response` is "what the user picked"; `tool_blocked` is "the gate denied the call". | both emit |
| `mode_change` clears grants | When the user switches modes mid-session, `permissionGrants` is cleared (otherwise an `allow_always` from ask mode would leak into edit mode unexpectedly). | `PermissionService.setMode` |
| Subagent inheritance + grants | Child does NOT inherit parent's `permissionGrants`. (Each session resolves its own approvals.) | `build-child-state.ts` (no change needed since runtime.permissionGrants is per-session) |
| Compaction bypass | Compaction-internal tool calls SKIP the gate (compaction has its own model + no user UI). Add `bypassPermissions: boolean` flag respected by the gate. | `CompactionOrchestrator` + gate |
| File rename | Rename `ai-docs/research/modes/milestones/040-ask-mode-and-approval-flow.md` H1 from "Milestone 030 — `ask` mode + ACP `requestPermission` flow" to "Milestone 040 — `ask` mode + ACP `requestPermission` flow" (renumbering housekeeping). | doc edit |

## Open exploration questions to resolve before designing

Resolve these by reading source first, then `AskUserQuestion` (with your recommended answer per question) before writing the plan.

### Q1 — `tool_call_update {status: "pending"}` emission ordering

`createPiAgent.beforeToolCall` is called BEFORE pi-agent-core emits the `tool_call` notification on its own. Today the agent emits the `tool_call` notification (with `status: "in_progress"`) via `subscribeToAgent` after the hook returns. If we want `status: "pending"` to appear, we need to either (a) emit it from inside `beforeToolCall` before awaiting `requestPermission`, or (b) ride on the existing `tool_call` notification but change its status. Verify what pi-agent-core does with `status: "pending"` in the SDK type.

- **(A) Emit pending from `beforeToolCall`.** Send a `tool_call_update {status: "pending"}` notification before awaiting. Resolve to allow → pi-agent-core's normal `tool_call` `in_progress` notification overrides. Resolve to deny → emit `tool_call_update {status: "failed"}` ourselves.
- **(B) Skip pending; only emit lifecycle event.** Tool_call notification appears as `in_progress` when the tool actually runs (after approval). For rejected calls, no `tool_call` notification at all. Cleaner but loses the in-flight signal for Clients that only read tool_call notifications.

**Recommend (A)** per locked decision; verify SDK type allows `pending`.

### Q2 — Where the await happens

Two possible homes for the suspend:

- **(A) Inside `PermissionService.evaluateToolCall`.** The service awaits `conn.requestPermission`, races against timeout + cancel, returns `allow`/`deny`. Gate stays simple. PermissionService becomes the only async boundary.
- **(B) In the gate (createPiAgent.beforeToolCall).** Service returns `{ kind: "ask", options }` (new discriminant); the gate awaits `conn.requestPermission`, decodes, emits events, returns `block`. PermissionService stays pure; orchestration in the gate.

**Recommend (B)** — the gate already owns event emission (`tool_blocked`, `custom_message` append). Centralising approval orchestration there keeps PermissionService cleanly decision-only. The internal `ApprovalDecision` union widens to include `{ kind: "ask", options, sessionId, toolCall }`, but the public `evaluateToolCall` return shape stays `allow | deny | ask`.

### Q3 — Phase-B slash interception layer

`/approve [once|always]` and `/reject [once|always]` need to route a typed-text input into the **Client-side** `requestPermission` handler resolver. Two paths:

- **(A) Intercept in the slash router** before the slash hits the Agent. The Client peeks at the line; if it's an approval slash and there's a pending request in the Client's local pending-map, resolve it and return without sending anything to the Agent. The Agent never sees the slash.
- **(B) Send the slash to the Agent as a new `_bodhi-pi/permission/respond` ext method.** Wire method handles routing. **DROPPED — violates "no new wire methods" lock.**
- **(C) Send the slash to the Agent as a prompt; agent extension hook decodes it.** Awkward — needs an extension hook.

**Recommend (A)** — Client-side interception. The pending-approval registry lives in the Client (it's where `requestPermission` was awaited from). Slash router checks the pending map; if a request is pending, resolves the slash's verdict. If no pending, falls through to normal slash handling (e.g. "no approval pending" system message).

### Q4 — `tool_call_update {status: "pending"}` retried/replaced if same toolCallId resolves twice

If the test harness sends multiple `approvalResponses` quickly or a network blip retriggers, can a single toolCallId receive two status updates? Verify pi-agent-core's idempotency on `tool_call_update` notifications.

**Recommend NO concern** — each tool call has a unique `correlationId` generated server-side; only one resolution path per call. Document.

### Q5 — Test layout

Drives commit cadence. Recommended (mirrors 030 cadence):

- `test/ask-mode-policy.test.ts` (Phase A) — `ask` preset categories produce expected `allow`/`ask` decisions from `evaluateToolCall` (unit-level, with the harness's `approvalResponses` queue feeding deterministic answers).
- `test/ask-mode-approval-flow.test.ts` (Phase A) — full round-trip via harness: allow_once / allow_always (+ session grant) / reject_once / reject_always (+ session deny grant) / cancel / timeout / mode_change-clears-grants / compaction-bypass / subagent-auto-allow.
- `e2e/shared/ask-mode.e2e.ts` (Phase A) — gpt-4o-mini prompts the model to call `write`; programmatic queue resolves allow_once; assert file written + tool_approval_response event present.
- `e2e-ui/shared/ask-mode.spec.ts` (Phase B) — Playwright: `/mode ask` (already default) → prompt that triggers a write → composer placeholder reads "awaiting approval" → type `/approve once` → assert tool completes + `tool_approval_response` event in the EventsPanel.

### Q6 — `session/request_permission` timing relative to `tool_call` notification

The ACP spec says Client SHOULD receive `tool_call` (notification) before `session/request_permission` (request) for the same `toolCallId` — so Client UIs can render the tool card before the prompt. Verify our emission order satisfies this.

**Recommend** emit `tool_call_update {status: "pending"}` FIRST in the gate, then `await conn.requestPermission`. The notification is fire-and-forget; the request awaits. Order is preserved by sequential `await` ordering of `conn.sessionUpdate(...)` → `conn.requestPermission(...)`.

### Q7 — Slash router placement for Phase B

`/approve` + `/reject` are agent-mode slashes (decode + resolve in Client) vs. agent-side slashes (forward to extMethod). Per Q3 they're Client-side. They live in:

- CLI: `packages/bodhi-pi/test-apps/cli/src/client/lib/commands.ts` — existing slash router.
- Browser/chrome-ext/http: `packages/bodhi-pi/test-apps/browser/src/client/lib/slash-router.ts` (shared via AppShell).

Each router gets a small "pending approval registry" (a `Map<sessionId, { resolve, options }>`) populated when `requestPermission` is called and consumed when `/approve` or `/reject` is typed. Cleared on session change / `cancel`.

**Recommend** confirm.

### Q8 — `tool_approval_request` lifecycle event payload shape

The type already exists (`src/events/types.ts:310-319`): `{ sessionId, correlationId, toolCallId, toolName, category, pattern, timeoutMs }`. The `pattern` field is for milestone 100's persistent rules — we don't have patterns this phase. Recommend:

- **(A)** Leave `pattern` field; populate it as the toolName so the wire shape is forward-compat (in ms 100 it'll become a glob/regex pattern).
- **(B)** Make `pattern` optional (add `?`) for phase 040; populate only in ms 100.

**Recommend (A)** — keep wire shape stable; `pattern === toolName` is a degenerate but valid pattern.

## Process — iterative TDD per phase

Per `packages/bodhi-pi/CLAUDE.md` 6-step workflow + `feedback_phasing_depth_first` + `feedback_e2e_coverage_keeps_feature`:

### Phase A — ACP-direct only

1. **Failing integration test first.** `test/ask-mode-approval-flow.test.ts` — drives PermissionService + gate orchestration design. Make pass in `src/`.
2. **MODE_PRESETS.ask** filled.
3. **Gate orchestration in `createPiAgent.beforeToolCall`** — when `evaluateToolCall` returns `{ kind: "ask", options, ... }`, the gate emits `tool_approval_request`, races `await conn.requestPermission` against timeout + cancel, decodes response, emits `tool_approval_response`, optionally updates `permissionGrants`, returns `allow | deny` outcome to pi-agent-core.
4. **Pending tool_call_update** emission (per Q1).
5. **session/cancel resolves pending approvals** as cancelled.
6. **Test harness** `approvalResponses` queue + `autoApproveAll` toggle (default true).
7. **`e2e/shared/ask-mode.e2e.ts`** — real LLM ask-mode round-trip across in-memory / cli / http / ws.
8. **Spec updates same-commit**: modes.md (status table + approval flow section), acp.md (LIFECYCLE_EVENT_METHOD adds tool_approval_request/response rows), lifecycle.md (no entry-type changes — pending notifications are wire-only).

End-state of Phase A: ask mode works programmatically. No Playwright yet.

### Phase B — composer slash + Playwright

1. **Test-app Client slash routers** (browser `slash-router.ts`, cli `commands.ts`) gain a pending-approval registry + `/approve` + `/reject` handlers.
2. **Per-Host `requestPermission` handlers** wired to the pending-approval registry. CLI: replaces the `approved` stub with a registry-backed promise. Browser/chrome-ext/http: AppShell adds `requestPermission` to its Client construction; pushes pending into the registry and dims composer placeholder.
3. **`e2e-ui/shared/ask-mode.spec.ts`** — Playwright end-to-end across browser/chrome-ext/http+SSE/ws.
4. **Spec updates same-commit**: hosts.md (per-Host slash router note), test-apps/CLAUDE.md (already updated; sanity-check the doctrine still reads correctly).

End-state of Phase B: ask mode driveable from Playwright via typed composer slashes — no UI modals.

## Gate-check + commit cadence

Suggested cluster shape:

### Phase A commits

- **A1**: `bodhi-pi modes 040a: ask preset + ApprovalDecision widening + PermissionService internal API` — fill `MODE_PRESETS.ask`, widen the internal `ApprovalDecision` union to include `{ kind: "ask", options, ... }`, add `SessionRuntime.pendingApprovals` + `permissionGrants`. No gate wiring yet.
- **A2**: `bodhi-pi modes 040b: gate orchestrates conn.requestPermission + timeout + cancel + grants` — gate awaits, decodes, emits `tool_approval_request`/`response`, mutates `permissionGrants` on `allow_always` / `reject_always`. New events forwarded via `LIFECYCLE_EVENT_METHOD`. `session/cancel` resolves pending. `mode_change` clears grants.
- **A3**: `bodhi-pi modes 040c: test harness queue + integration test slabs + shared e2e` — `approvalResponses` + `autoApproveAll`. Integration tests + e2e + spec docs.

### Phase B commits

- **B1**: `bodhi-pi modes 040d: per-Host requestPermission Client + pending-approval registry` — CLI commands.ts + browser slash-router.ts + AppShell + http/chrome-ext inheritance via subpath imports.
- **B2**: `bodhi-pi modes 040e: Playwright ask-mode spec + hosts.md doctrine update` — `e2e-ui/shared/ask-mode.spec.ts` + spec docs flip 040 ☑.

Atomic-commit pattern per `feedback_atomic_commit_with_reset`.

## Plan structure (mandatory sections)

Same as p1:

1. **Goal restatement** — quote 040's "Goal" + the phase-2 delta from this kickoff.
2. **Locked-scope summary** — table above.
3. **Open-question resolutions** — table: question → recommended answer → user-answer.
4. **File-level inventory** — new files, touched files, spec docs amended. Per file: one-line purpose.
5. **Per-commit slice** — A1/A2/A3/B1/B2 + validation gate per commit.
6. **Verification matrix** — per runtime: which `npm` / `vitest` / `playwright` command to run after each commit lands.
7. **Risk register** — pi-agent-core suspending hook for 30s; HTTP per-turn-rebuild losing pendingApprovals (already noted: rebuild also loses in-flight prompt → naturally void); subagent auto-allow tradeoff; slash collision (a user prompt that starts with `/approve` outside an approval context should be a regular slash, not consumed).
8. **Out of scope** — explicitly: edit-mode enforcement (050); submit_plan + plan→edit auto-transition (060); allow-all guardrails (070); subagent profile mode field + Qwen rule (080); active-tools-swap (090); persistent rules + 6-option scope (100); UI modals for approval (never — test-apps doctrine).

## Anti-patterns to avoid

- **Don't add new wire methods.** Native `session/request_permission` covers the round-trip. No `_bodhi-pi/permission/*`.
- **Don't build a UI modal in any test-app.** Test-apps/CLAUDE.md doctrine: composer-typed slash for Playwright; programmatic queue for Vitest.
- **Don't auto-approve subagent calls in plan mode.** Plan-mode subagent stays "allow" per 030's locked decision; this phase doesn't touch that.
- **Don't widen the public `evaluateToolCall` return** to include `ask`. The internal union widens; the public surface stays `allow | deny`. The gate consumes the internal version; nothing else does.
- **Don't persist `permissionGrants` to KV.** That's ms 100. In-memory `Set<string>` on `SessionRuntime` is enough.
- **Don't gate compaction-internal tool calls.** Add a `bypassPermissions` flag respected by the gate; CompactionOrchestrator sets it.
- **Don't change the test-harness Client signature surface for callers that don't care about approvals.** `autoApproveAll: true` default keeps every existing test green; opt-in for the strict tests.
- **Don't include UI-rendering code paths beyond what the doctrine permits.** The composer placeholder change ("awaiting approval; type /approve or /reject") is text-only — no new components.
- **Don't enforce edit mode here.** That's ms 050.
- **Don't add `node:*` imports to `src/permissions/` or to any runtime-neutral test-app surface.**
- **Don't write to the deprecated `packages/bodhi-pi-*` sibling packages.**

## References

- Modes p1 retrospective: commits `6fa4b7d1`…`fd13b276` + `665198d3`. The gate, lifecycle event forwarder, custom_message renderers, and harness mcpConnectionProvider option all already shipped.
- Modes research wave (Q1 2026):
  - `ai-docs/research/modes/report.md` — synthesis (especially `notes/07-codex.md` for the `Forbidden` + `amendment` pattern we kept from 030 and the optionId-scope-encoding pattern we deferred to 100).
  - `notes/02-cc-claude-code.md` / `notes/03-opencode.md` / `notes/06-cline-roo.md` — comparison surfaces for the approval round-trip.
- Sibling milestone files:
  - `milestones/000-overview.md` (READ first)
  - `milestones/005-acp-architecture-decision.md` (binding)
  - `milestones/040-ask-mode-and-approval-flow.md` (this phase)
  - `milestones/050-edit-mode-preset.md` (next phase preview)
- ACP spec:
  - `node_modules/@agentclientprotocol/sdk` `RequestPermissionRequest` / `RequestPermissionResponse` / `PermissionOption` types.
- Bodhi-pi pattern references:
  - `src/permissions/permission-service.ts` (extend with `conn` dep + ask-flow internals).
  - `src/sessions/session-bootstrap.ts:171-204` (the gate; extend).
  - `src/events/types.ts:310-336` (existing `ToolApprovalRequestEvent` / `ToolApprovalResponseEvent` types).
  - `src/acp/event-wiring.ts:53-69` (mirror `tool_blocked` forwarder pattern).
  - `packages/bodhi-pi/test-apps/CLAUDE.md` § "These are TEST-APPS, not production apps" (the binding constraint).

## When done

Print: the plan path, the count of open questions resolved during grilling, and the proposed commit subjects in order. Do not start executing — the plan IS the deliverable. Implementation runs in a separate session.

**After phase A lands, the user can drive ask mode programmatically:**
1. Open a vitest integration test
2. Spawn the harness with `autoApproveAll: false, approvalResponses: [{ outcome: { outcome: "selected", optionId: "allow_once" } }]`
3. Prompt the agent to call `write`
4. Verify the file was written + `tool_approval_response { kind: "allow_once" }` event fired

**After phase B lands, the user can manually drive ask mode in Playwright + the cli REPL:**
1. `npm --workspace @bodhiapp/bodhi-pi-test-app-cli run dev`
2. Default mode is `ask`
3. "Create a file foo.txt with hello world" → composer placeholder reads `awaiting approval`
4. Type `/approve once` → file written, transcript shows the tool ran
5. Repeat: `/approve always` → next call auto-runs without prompting
6. Same flow in browser/chrome-ext/http via Playwright

That's the deliverable.
