# Plan: bodhi-pi modes phase 1 — plan-mode plumbing (milestone 030)

**Kickoff**: `ai-docs/prompts/2026-05-19-bodhi-pi-modes-p1-plan-mode-plumbing.md`
**Milestone**: `ai-docs/research/modes/milestones/030-plan-mode-plumbing.md`
**Author**: planning session 2026-05-19

---

## 1. Context

Phase 0 (`c93fc25a`) made `mode` settable/persisted/advertised/observable across four reference Hosts but inert — every tool runs regardless of mode. `MODE_PRESETS.plan.policy` is `EMPTY_POLICY`, `evaluateToolCall` returns `{ kind: "allow" }` unconditionally, `ModePreset.systemPromptSuffix` is never populated.

This phase makes **plan mode** the first mode that actually rejects tool calls. After this lands, the user can `/mode plan` in any of six runtimes, ask the agent to make an edit, see the call blocked with redirect text, see the LLM adapt within the same turn, and `/mode edit` to unblock. Ask / edit / allow-all stay inert (enforcement lands in 040+).

The dependency chain into 040/060: this phase wires the evaluation pipeline (`evaluateToolCall` real signature + category lookup + MCP-annotation consultation), the gate (`beforeToolCall` extension), the user-visible block surface (`custom_message` entry + minimal renderer in each Host), and the event channel (`tool_blocked` lifecycle event). Milestone 040 layers `session/request_permission` round-trip on top of the same gate; 060 adds the `submit_plan` tool + 3-option approval UI.

## 2. Locked-scope summary

| Decision | Locked answer | Where it lands |
|---|---|---|
| Phase scope | Plan-mode only enforces; ask/edit/allow-all stay inert | `MODE_PRESETS` (only `plan.policy` filled in) |
| Block surface to LLM | `AgentToolResult` with `isError: true` + redirect text (Codex `amendment` pattern) | `pi-agent-core` already does this via `agent-loop.ts:571-587` when `beforeToolCall` returns `block` |
| Block surface to user | `custom_message` entry with `display: true` | `appendEntry` from the `beforeToolCall` hook in `createPiAgent` |
| Tool list mutation on block | None — tools stay visible; rejection is at call time | n/a (active-tools-swap is 090) |
| MCP classification | Read SDK `annotations.readOnlyHint` / `destructiveHint`; default-ALLOW on absent (research-permissive) | `McpToolInfo.annotations` + `evaluateToolCall` MCP branch |
| Plan-mode policy | `read`/`search`/`subagent` allow; `edit`/`execute`/`other` deny; `mcp` per-annotation | `MODE_PRESETS.plan.policy.categories` |
| System-prompt suffix | Plan suffix from milestone 030; appended **after** `appendSystemPrompt` at `composeSystemPrompt` time (effective on session boot only — no mid-session rebuild) | `composeSystemPrompt` in `session-bootstrap.ts:115-136` |
| Mid-session mode-change steering | **None.** No injected message, no prompt rebuild. Rely solely on the `tool_result.isError` amendment to steer the LLM. (Convergent pattern across Codex / OpenCode / Roo / MastraCode.) | n/a |
| Redirect-text shape | Per-category template: `"plan mode is read-only — '{toolName}' blocked (category: {category}). Use read-only tools or '/mode edit' to proceed."` Per-tool override deferred. | template in `permission-service.ts` |
| Wire methods added | None (no new `_bodhi-pi/*` methods, no new ACP methods) | n/a |
| `request_permission` round-trip | Not in this phase (milestone 040) | n/a |
| `submit_plan` tool | Not in this phase (milestone 060) | n/a |
| `custom_message` renderer in 4 Hosts | **NEW SCOPE**: phase 1 adds a minimal generic renderer to each test-app so block messages are visible | per-Host renderer files (see file inventory) |
| Subagent inheritance | Trivial: child inherits `parent.runtime.mode` (already wired in 020); `SubagentProfile.mode?` and Qwen rule deferred to 080 | existing `build-child-state.ts` |
| `tool_blocked` lifecycle event | New event in `BodhiPiEvent` union; forwarded via `LIFECYCLE_EVENT_METHOD`; no `correlationId` field — `toolCallId` is the natural handle | `events/types.ts` + `acp/event-wiring.ts` |
| `evaluateToolCall` signature | `(sessionId, toolCall: { name, arguments }): Promise<ApprovalDecision>` — future-proof for milestone 050 args | `permissions/permission-service.ts` |
| MCP annotation cache | Refresh on `client.listTools()` call (already runs on connect); accept session-lifetime staleness; document in `mcp.md` | n/a (existing behaviour) |
| `ToolBlockedEvent` shape | `{ type: "tool_blocked", sessionId, toolCallId, toolName, category, mode, reason }` (no correlationId) | `events/types.ts` |
| Skill `allowed-tools` enforcement | Deferred. Skills traverse the same gate but their `allowed-tools` field isn't consulted. | (followup) |

## 3. Open-question resolutions

| # | Question | Recommendation | User answer |
|---|---|---|---|
| Q-NEW | `custom_message` not rendered in 4 Hosts today | Add minimal renderer (scope creep) | **Add minimal custom_message renderer to 4 Hosts** |
| Q1 | Mid-session prompt steering | Hybrid (custom_message into history) | **Use the prevalent CC/Codex/OpenCode pattern → call-time rejection only, no injected message, no prompt rebuild.** Convergent finding: Codex / OpenCode / Roo / MastraCode all rely solely on `tool_result` amendment text |
| Q2 | MCP annotation cache invalidation | Refresh on `listTools` | **Refresh on `client.listTools()` call** |
| Q3 | Redirect-text shape | Per-category + per-tool override hook | **Minimal: per-category template only; per-tool override deferred** |
| Q4 | `correlationId` on `tool_blocked` | No | **No correlationId** |
| Q5 | `evaluateToolCall` signature | Full `toolCall` object | **Pass full `toolCall: { name, arguments }`** |
| Q6 | Where LLM sees redirect | `tool_result` only | Subsumed by Q1: **tool_result amendment only** |
| Q7 | Subagent profile mode for phase 1 | Trivial inherit | **Confirm: trivial inheritance, no profile.mode honored in phase 1** |
| Q8 | Test layout | 4 test files + skip Playwright | **5 files: 3 integration + shared e2e + Playwright plan-mode spec** |

## 4. File-level inventory

### Source (touched)

| Path | Purpose |
|---|---|
| `packages/bodhi-pi/src/permissions/types.ts` | Add `McpToolAnnotations` re-export or local type; refine `evaluateToolCall` typing on `PermissionService` |
| `packages/bodhi-pi/src/permissions/presets.ts` | Fill `MODE_PRESETS.plan.policy.categories` per locked table; set `MODE_PRESETS.plan.systemPromptSuffix` |
| `packages/bodhi-pi/src/permissions/permission-service.ts` | Replace `evaluateToolCall` stub with real impl: `(sessionId, toolCall: { name, arguments })`; per-category lookup; MCP-annotation consultation via injected callback; redirect template |
| `packages/bodhi-pi/src/tools/index.ts` | No change (categories already match locked table) |
| `packages/bodhi-pi/src/mcp/mcp-types.ts` | Extend `McpToolInfo` with `annotations?: McpToolAnnotations` |
| `packages/bodhi-pi/src/mcp/mcp-client.ts` | Persist `annotations` from `client.listTools()` result onto `ConnectedClient.tools[]` |
| `packages/bodhi-pi/src/mcp/mcp-registry.ts` | Add `getToolAnnotations(sessionId, fullName: "<slug>__<tool>"): McpToolAnnotations \| undefined` |
| `packages/bodhi-pi/src/sessions/session-bootstrap.ts` | `composeSystemPrompt`: append `MODE_PRESETS[currentMode].systemPromptSuffix` after existing `appendSystemPrompt`. `createPiAgent` `beforeToolCall` hook: after `emitToolCall`, call `evaluateToolCall`; on deny, emit `tool_blocked`, append `custom_message`, return `{ block: true, reason }` |
| `packages/bodhi-pi/src/events/types.ts` | Add `ToolBlockedEvent` to `BodhiPiEvent` union; add `emitToolBlocked(...)` method on dispatcher |
| `packages/bodhi-pi/src/acp/event-wiring.ts` | Forward `tool_blocked` event through `LIFECYCLE_EVENT_METHOD` |
| `packages/bodhi-pi/src/acp/agent.ts` | Constructor: pass `mcpAnnotationLookup` callback into `PermissionService` (after `McpService` instantiation — already injects registry internally; expose getter via constructor closure) |

### Source (4-Host renderers — NEW work)

| Path | Purpose |
|---|---|
| `packages/bodhi-pi/test-apps/bodhi-pi-test-app-cli/src/render.ts` | Extend `onNotification` with `custom_message` case: print boxed text `[plan-mode]` style |
| `packages/bodhi-pi/test-apps/bodhi-pi-test-app-browser/src/ChatPanel.tsx` | Extend `renderMessage()` with `entry.type === "custom_message"` branch; add `data-testid="custom-message"` + `data-test-state` per `skills:playwright` conventions; styled bubble |
| `packages/bodhi-pi/test-apps/bodhi-pi-test-app-http/` | HTTP test-app: SSE already forwards entries; if it embeds the browser renderer (subpath import), inherits. Confirm during C4 |
| `packages/bodhi-pi/test-apps/bodhi-pi-test-app-chrome-ext/` | Inherits browser renderer via `@bodhiapp/bodhi-pi-test-app-browser/host/*` subpath imports; no per-extension code |

### Tests (new)

| Path | Purpose |
|---|---|
| `packages/bodhi-pi/test/plan-mode-policy.test.ts` | Integration (faux provider). Per-category gating: `write` blocks, `read` allows; `custom_message` entry appears in session; `tool_blocked` event fires; `evaluateToolCall` returns correct shape |
| `packages/bodhi-pi/test/plan-mode-mcp.test.ts` | Integration. Mock MCP client with annotated tools: `readOnlyHint: true` → allow in plan; `destructiveHint: true` → deny; missing annotations → allow (default-ALLOW) |
| `packages/bodhi-pi/test/plan-mode-subagent.test.ts` | Integration. Parent in plan-mode spawns subagent; child inherits plan; child blocks `write` same as parent |
| `packages/bodhi-pi/e2e/shared/plan-mode.e2e.ts` | Shared e2e (gpt-4o-mini). `/mode plan` → "describe how you'd add a comment" → LLM uses read → tries to write → blocked → adapts. Runs across 6 runtime projects (in-memory, cli, http, ws, browser, chrome-ext) |
| `packages/bodhi-pi/e2e-ui/shared/plan-mode.spec.ts` | Playwright. Browser test-app: `/mode plan`, send prompt that triggers a write attempt, assert `data-testid="custom-message"` appears with `data-test-state="tool-blocked"` |

### Specs (touched)

| Path | Purpose |
|---|---|
| `ai-docs/specs/bodhi-pi/modes.md` | Flip implementation-status row for 030 to ☑; describe the plan-mode policy table; document the "mid-session prompt steering deferred" decision; document the redirect-text template |
| `ai-docs/specs/bodhi-pi/acp.md` | Note that `tool_blocked` is a new `LIFECYCLE_EVENT_METHOD` payload type (no new wire method) |
| `ai-docs/specs/bodhi-pi/lifecycle.md` | Add `tool_blocked` event to the lifecycle event catalog |
| `ai-docs/specs/bodhi-pi/mcp.md` | Note `McpToolInfo.annotations` field + the "annotations refresh on `listTools()`, accept session-lifetime staleness" cache policy |

## 5. Per-commit slice

Atomic commit pattern per `feedback_atomic_commit_with_reset`: each commit uses `git reset . && git add <paths> && git commit -m "..."`.

### C1 — `bodhi-pi modes 030a: MCP tool annotations + McpToolInfo extension`

**Files**: `mcp-types.ts`, `mcp-client.ts`, `mcp-registry.ts` + 1 integration test extension.
**What lands**: `McpToolAnnotations` type from MCP SDK (verify `^1.29.0` exposes `Tool.annotations`); `McpToolInfo.annotations?` field; parse + persist on `listTools()`; expose `getToolAnnotations(sessionId, fullName)` on registry.
**No enforcement yet.** Pure plumbing — annotations available to read but nothing consumes them.
**Validation gate**: `npm run check` (lint+typecheck+tests) + `npm test -- mcp` slice green.

### C2 — `bodhi-pi modes 030b: plan-mode preset + evaluateToolCall implementation`

**Files**: `presets.ts`, `permission-service.ts`, `permissions/types.ts`, `acp/agent.ts` (constructor wiring of `mcpAnnotationLookup`).
**What lands**:
- `MODE_PRESETS.plan.policy.categories` filled per locked table.
- `MODE_PRESETS.plan.systemPromptSuffix` set to the exact text from milestone 030.
- `evaluateToolCall` real impl with new signature `(sessionId, toolCall: { name; arguments })`.
- Redirect template centralized in service.
- `mcpAnnotationLookup` callback injected via constructor (registry-bound closure in `BodhiPiAcpAgent`).

**No gate wired yet** — `beforeToolCall` still uses the phase-0 path. PermissionService is unit-testable in isolation.

**Validation gate**: `npm run check` + new `test/plan-mode-policy.test.ts` (PermissionService unit subset) green.

### C3 — `bodhi-pi modes 030c: tool-call gating + tool_blocked event + custom_message on block + system-prompt suffix`

**Files**: `session-bootstrap.ts` (`composeSystemPrompt` + `createPiAgent` `beforeToolCall`), `events/types.ts`, `acp/event-wiring.ts`, + 3 integration tests.
**What lands**:
- `composeSystemPrompt` appends `MODE_PRESETS[currentMode].systemPromptSuffix` (effective on session boot only — accepted by Q1 resolution).
- `beforeToolCall` hook: after the existing `emitToolCall`, call `permissionService.evaluateToolCall`. On deny: append `custom_message` entry (`extensionName: "modes"`, `customType: "tool_blocked"`, `content: reason`, `display: true`); emit `tool_blocked` lifecycle event; return `{ block: true, reason }` to pi-agent-core.
- `ToolBlockedEvent` added to `BodhiPiEvent` union.
- `event-wiring.ts` forwards `tool_blocked` via `LIFECYCLE_EVENT_METHOD`.
- `test/plan-mode-policy.test.ts` (full), `test/plan-mode-mcp.test.ts`, `test/plan-mode-subagent.test.ts` all green.

**Validation gate**: `npm run check` + `npm test -- plan-mode` green.

### C4 — `bodhi-pi modes 030d: custom_message renderers in 4 Hosts`

**Files**: `test-app-cli/src/render.ts`, `test-app-browser/src/ChatPanel.tsx` (+ http & chrome-ext if they don't inherit), `test-app-browser` styles file if applicable.
**What lands**: Each Host's chat panel renders `entry.type === "custom_message"` entries with `display: true`. CLI prints a boxed/prefixed line. Browser renders a styled bubble with `data-testid="custom-message"` and `data-test-state="tool-blocked"` (per `skills:playwright`). chrome-ext inherits browser. http confirms forwarding works (no per-runtime client renderer needed if it inherits from browser).
**Validation gate**: `npm run check` across each test-app workspace; existing Playwright spec (`mode-switch.spec.ts`) still green; new Playwright spec deferred to C5.

### C5 — `bodhi-pi modes 030e: e2e plan mode across 6 runtimes + Playwright spec + spec docs`

**Files**: `e2e/shared/plan-mode.e2e.ts`, `e2e-ui/shared/plan-mode.spec.ts`, all 4 spec docs.
**What lands**:
- Shared e2e exercises plan-mode across in-memory / cli / http / ws / browser / chrome-ext using gpt-4o-mini (per `feedback_bodhi_pi_e2e_strategy`).
- Playwright spec asserts the browser-rendered `custom_message` chip appears after `/mode plan` + LLM write attempt.
- modes.md flips 030 ☑; acp.md / lifecycle.md / mcp.md updated per file inventory.

**Validation gate**: `npm run check` + `npm test -- plan-mode` + `npm run test:e2e` (all 6 runtime projects) + `npm run test:e2e-ui` green.

## 6. Verification matrix

After **each commit** lands, run the appropriate slice from `packages/bodhi-pi/`:

| Commit | Command | Expected outcome |
|---|---|---|
| C1 | `npm run check` | typecheck green; existing MCP tests still pass; new annotation persistence test passes |
| C2 | `npm run check && npm test -- permission-service` | PermissionService unit test for plan-mode policy passes; old phase-0 mode tests still green |
| C3 | `npm run check && npm test -- plan-mode` | 3 new integration tests pass; existing mode-state tests unchanged |
| C4 | `npm --workspace @bodhiapp/bodhi-pi-test-app-cli run check`<br>`npm --workspace @bodhiapp/bodhi-pi-test-app-browser run check`<br>`npm --workspace @bodhiapp/bodhi-pi-test-app-chrome-ext run check`<br>`npm --workspace @bodhiapp/bodhi-pi-test-app-http run check`<br>existing `mode-switch.spec.ts` (Playwright) | all 4 test-apps build/typecheck; existing Playwright mode-switch still green |
| C5 | `npm run check`<br>`npm run test:e2e` (driving in-memory/cli/http/ws via vitest projects)<br>browser e2e via runtime-specific Playwright project<br>`npm run test:e2e-ui` | All 6 runtime projects pass `plan-mode.e2e.ts`; new `plan-mode.spec.ts` passes |

**Final manual verification** (the kickoff's "when done" demo):
1. `npm --workspace @bodhiapp/bodhi-pi-test-app-cli run dev`
2. `/mode plan` → `[plan]` badge in prompt
3. "Read packages/bodhi-pi/src/index.ts and tell me what's exported" → succeeds
4. "Add a console.log to that file" → blocked with redirect text in the LLM's assistant turn + a `custom_message` block in the transcript
5. `/mode edit` → same prompt now succeeds
6. Repeat in http / browser / chrome-ext

## 7. Risk register

| # | Risk | Mitigation |
|---|---|---|
| R1 | MCP SDK version doesn't expose `Tool.annotations` (need ≥ v2025-03-26) | Verify in C1 by reading `node_modules/@modelcontextprotocol/sdk/dist/cjs/types.d.ts`. If absent: bump SDK and rerun typecheck before proceeding. Already confirmed `^1.29.0` is current. |
| R2 | pi-agent-core's `agent-loop.ts:571-587` block-handling contract changes | Pin the assumption in C3: the integration test for plan-mode-policy asserts that an LLM-driven `write` invocation produces a `tool_result` chunk with `isError: true` carrying the redirect string. If pi-agent-core changes shape, this test catches it. |
| R3 | Mid-session system-prompt staleness causes the LLM to keep trying blocked tools | Accepted per Q1: the convergent harness pattern (Codex/OpenCode/Roo) shows `tool_result` amendment is sufficient. Document in `modes.md`. Shared e2e (C5) validates the LLM actually adapts on gpt-4o-mini. |
| R4 | MCP annotation cache staleness if server re-publishes tool list mid-session | Accepted per Q2. Document in `mcp.md`. User remediation: `/mcp reconnect <slug>`. |
| R5 | `custom_message` order vs. `tool_result` order in chat transcript could confuse users | Append `custom_message` BEFORE returning `block: true` so transcript ordering is: tool_call → custom_message → tool_result(isError). Assert ordering in `plan-mode-policy.test.ts`. |
| R6 | New `custom_message` renderer in Hosts collides with future entry types | Renderer is generic on `entry.type === "custom_message"` and uses `entry.customType` to discriminate. Only the `"tool_blocked"` customType styles itself for now; unknown customTypes fall back to plain text. |
| R7 | `runtime.mode` access in `composeSystemPrompt` — phase-0 runtime state may not include `mode` at the call site | Verify in C3: `session.runtime.mode` is set before `composeSystemPrompt` runs (it's seeded by `setMode` or initial-state defaults). If not, plumb via explicit arg. |
| R8 | http test-app may not inherit browser renderer cleanly | Confirm during C4. If http needs its own minimal renderer, add ~40 LOC there. |
| R9 | gpt-4o-mini may not reliably adapt to the redirect (flaky e2e) | C5 e2e prompt is engineered to be unambiguous ("describe how you would add a comment, don't actually edit"). If flaky, prompt-engineer until 5 consecutive runs pass, then commit. |
| R10 | Playwright `data-test-state="tool-blocked"` selector convention drift | Use `skills:playwright` conventions exactly. Mirror existing `mode-switch.spec.ts` selectors. |

## 8. Out of scope (deferred)

| Item | Lands in |
|---|---|
| `session/request_permission` ACP round-trip | milestone 040 |
| Ask-mode + edit-mode + allow-all enforcement | milestone 040 / 070 |
| `submit_plan` built-in tool + 3-option approval UI + plan→edit auto-transition | milestone 060 |
| Fine-grained per-tool argument patterns (e.g., `bash` allowlist) | milestone 050 |
| Persistent permission rules (`alwaysAllow` / `alwaysDeny` per session-config) | milestone 100 |
| Active-tools-swap (LLM stops seeing blocked tools in its tool list) | milestone 090 |
| `SubagentProfile.mode?` field + Qwen-rule combinator | milestone 080 |
| Mid-session system-prompt rebuild | not planned (convergent harness pattern: not needed) |
| MCP `notifications/tools/list_changed` subscription for live annotation refresh | followup; user can `/mcp reconnect <slug>` |
| Skill `allowed-tools` enforcement at the `beforeToolCall` gate | followup |
| Per-tool redirect-message override in `MODE_PRESETS.plan.policy.tools[name]` | followup |
| Approval UI changes in any of the 4 Hosts beyond minimal `custom_message` renderer | milestone 060 |

## 9. Anti-patterns to avoid (from kickoff)

- Don't strip tools from the LLM's tool list (active-tools-swap is 090).
- Don't throw a hard error on block — return `{ block: true, reason }` so the turn continues.
- Don't invent a new wire method for the rejection — `tool_blocked` rides on `LIFECYCLE_EVENT_METHOD`.
- Don't enforce ask/edit/allow-all in this milestone.
- Don't default-deny MCP tools without annotations — research-permissive default-ALLOW.
- Don't omit the redirect text — the amendment is the load-bearing UX.
- Don't add `submit_plan` or approval UI here.
- Don't add `node:*` imports to `src/permissions/` (runtime-neutrality).
- Don't enforce skills `allowed-tools` field.
- Don't write to deprecated `packages/bodhi-pi-*` sibling packages.

## 10. Implementation cadence

Per `packages/bodhi-pi/CLAUDE.md` 6-step workflow + `feedback_phasing_depth_first`. C1 → C2 → C3 → C4 → C5 sequentially; each ends green on `npm run check` + the relevant test slice. Commits via single chained `git reset . && git add <paths> && git commit -m "$(cat <<'EOF' ... EOF)"` per `feedback_atomic_commit_with_reset`.

After C5 lands, append `ai-docs/modes/p1-retrospective.md` capturing surprises, carryovers, and items punted to milestone 040 (per kickoff "When done").

---

## Critical files at a glance (modify in this order)

1. `packages/bodhi-pi/src/mcp/mcp-types.ts` (C1)
2. `packages/bodhi-pi/src/mcp/mcp-client.ts` (C1)
3. `packages/bodhi-pi/src/mcp/mcp-registry.ts` (C1)
4. `packages/bodhi-pi/src/permissions/presets.ts` (C2)
5. `packages/bodhi-pi/src/permissions/permission-service.ts` (C2)
6. `packages/bodhi-pi/src/permissions/types.ts` (C2)
7. `packages/bodhi-pi/src/acp/agent.ts` (C2, constructor wiring only)
8. `packages/bodhi-pi/src/sessions/session-bootstrap.ts` (C3: `composeSystemPrompt` + `createPiAgent.beforeToolCall`)
9. `packages/bodhi-pi/src/events/types.ts` (C3)
10. `packages/bodhi-pi/src/acp/event-wiring.ts` (C3)
11. `packages/bodhi-pi/test/plan-mode-policy.test.ts` (C2 unit subset + C3 full)
12. `packages/bodhi-pi/test/plan-mode-mcp.test.ts` (C3)
13. `packages/bodhi-pi/test/plan-mode-subagent.test.ts` (C3)
14. `packages/bodhi-pi/test-apps/bodhi-pi-test-app-cli/src/render.ts` (C4)
15. `packages/bodhi-pi/test-apps/bodhi-pi-test-app-browser/src/ChatPanel.tsx` (C4)
16. `packages/bodhi-pi/test-apps/bodhi-pi-test-app-chrome-ext/` (C4 — only if not inheriting browser)
17. `packages/bodhi-pi/test-apps/bodhi-pi-test-app-http/` (C4 — only if not inheriting browser)
18. `packages/bodhi-pi/e2e/shared/plan-mode.e2e.ts` (C5)
19. `packages/bodhi-pi/e2e-ui/shared/plan-mode.spec.ts` (C5)
20. `ai-docs/specs/bodhi-pi/{modes,acp,lifecycle,mcp}.md` (C5)

## Functions / utilities to reuse (no need to rewrite)

- `packages/bodhi-pi/src/tools/index.ts::toolKindFor(name)` — already returns the 7-wide category. Use directly in `evaluateToolCall`.
- `packages/bodhi-pi/src/permissions/permission-service.ts::setMode` — already appends `mode_change` entry + emits lifecycle event. No changes needed for mode-change side; only `evaluateToolCall` changes.
- `pi-agent-core agent-loop.ts:571-587` — when `beforeToolCall` returns `{ block, reason }`, pi-agent-core already constructs the `isError: true` `AgentToolResult` with the reason as content. We don't need to construct the amendment payload ourselves — we just supply `reason` and pi-agent-core surfaces it as a `tool_result` content item to the LLM.
- `packages/bodhi-pi/src/sessions/entries.ts::CustomMessageEntry` — append via existing `appendEntry` path (whichever method the hook receives via deps).
- `packages/bodhi-pi/src/events/types.ts` event dispatcher — pattern from `ToolCallEvent` (mutating-handler shape) applies to `ToolBlockedEvent` (one-way fire).
- `packages/bodhi-pi/src/acp/event-wiring.ts::notifyLifecycle` — mirror the `mode_change` handler pattern for `tool_blocked`.

---

**Open questions resolved**: 8 (Q1–Q8 from kickoff + 1 new "custom_message rendering gap" = 9 resolved).
**Proposed commit subjects** (in order):
1. `bodhi-pi modes 030a: MCP tool annotations + McpToolInfo extension`
2. `bodhi-pi modes 030b: plan-mode preset + evaluateToolCall implementation`
3. `bodhi-pi modes 030c: tool-call gating + tool_blocked event + custom_message on block + system-prompt suffix`
4. `bodhi-pi modes 030d: custom_message renderers in 4 Hosts`
5. `bodhi-pi modes 030e: e2e plan mode across 6 runtimes + Playwright spec + spec docs`
