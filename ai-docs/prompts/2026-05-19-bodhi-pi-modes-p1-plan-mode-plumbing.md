# Kickoff: bodhi-pi modes phase 1 — plan-mode plumbing (milestone 030)

**Output**: implement the feature AFTER you've grilled the user on the open questions below. Read code first, batch decision points via `AskUserQuestion` (each option marked with your recommended answer), get plan approval before any code edits. Same shape as the modes p0 kickoff workflow (`2026-05-19-bodhi-pi-modes-p0-foundation.md`).

## Status going in

Phase 0 (foundation slab — milestones 010 + 020) shipped in commit `c93fc25a`. After phase 0:

- `mode = "ask" | "plan" | "edit" | "allow-all"` is settable, persisted, advertised, and observable across all four reference Hosts.
- Mode is **inert.** `PermissionService.evaluateToolCall(...)` returns `{ kind: "allow" }` unconditionally. Every tool runs regardless of mode.
- `MODE_PRESETS` exists in `src/permissions/presets.ts` but only `allow-all`'s policy has real content; `ask`, `plan`, `edit` map to an `EMPTY_POLICY` placeholder.
- Each Host advertises `allowsAllowAllMode: true`, `allowsAllowAllModeAsDefault: false` — `/mode allow-all` reachable everywhere; persistent default still requires a second opt-in.

Phase 1 (this milestone) makes **plan mode** the first mode that actually rejects tool calls. Nothing else changes. Ask/edit/allow-all stay inert (their enforcement lands in milestone 040+).

The user requested **iterative-evolutionary phasing**: pick the next-logical-dependency. The eventual target is manually exercising plan-mode behaviour like Claude Code's plan mode. The dependency chain to get there:

1. **This phase (030)** — `evaluateToolCall` becomes real for plan only; tool-call gating wired in `beforeToolCall`; system-prompt suffix per mode; MCP-annotation classification; block-as-tool-result-with-redirect + `custom_message` chat entry. **Manually testable**: `/mode plan` → ask agent to make an edit → see it blocked with redirect text → `/mode edit` → same prompt now succeeds.
2. **Phase 2 (milestone 040)** — `ask` mode enforcement via ACP-native `session/request_permission` round-trip + 4-runtime approval UI.
3. **Phase 3 (milestone 060)** — `submit_plan` built-in tool + 3-option approval UI (accept→edit / accept→allow-all / reject) + plan-mode auto-transition.

User explicitly said: "do iterative evolutionary / plan mode was just a suggestion that eventually I want to do manual testing with / pick what is the next logical piece of work based on dependency". This kickoff implements that next logical piece.

**Read first** (in this order):

1. [`ai-docs/research/modes/milestones/000-overview.md`](../research/modes/milestones/000-overview.md) — the map. **Note the renumbering**: existing 030+ shifted up by 10. Phase 0's commit `c93fc25a` marked 010/020 ☑; this milestone (030) is the new "plan-mode plumbing" slab.
2. [`ai-docs/research/modes/milestones/005-acp-architecture-decision.md`](../research/modes/milestones/005-acp-architecture-decision.md) — still binding for wire-surface choices. This phase doesn't add new wire methods; it adds in-agent enforcement only.
3. [`ai-docs/research/modes/milestones/030-plan-mode-plumbing.md`](../research/modes/milestones/030-plan-mode-plumbing.md) — milestone-level brief for this phase. **The source of truth for scope.**
4. [`ai-docs/research/modes/report.md`](../research/modes/report.md) lines 700–826 — per-harness block-surface synthesis. cc / opencode / codex / cline-roo audit drove the Codex `amendment` pattern + chat-visible `custom_message` decision.
5. [`ai-docs/specs/bodhi-pi/modes.md`](../specs/bodhi-pi/modes.md) — canonical mode spec. The implementation-status table flips 030 ☑ at end-of-phase.
6. Phase 0 retro: read commit `c93fc25a`'s body. The dispatch-ownership refactor + capability gates + custom_message hook all already shipped — phase 1 reuses them.

**Source pointers** (read selectively, not exhaustively):

- `packages/bodhi-pi/src/permissions/presets.ts` — `MODE_PRESETS.plan.policy` is currently `EMPTY_POLICY`. This phase fills it in. `systemPromptSuffix?` is already typed on `ModePreset`; this phase sets `MODE_PRESETS.plan.systemPromptSuffix`.
- `packages/bodhi-pi/src/permissions/permission-service.ts` — `evaluateToolCall(_sessionId, _toolName): Promise<ApprovalDecision>` is the stub returning `{ kind: "allow" }`. This phase implements per-category lookup + MCP-annotation consultation.
- `packages/bodhi-pi/src/permissions/types.ts` — `PermissionPolicy` already has `categories: Partial<Record<ToolCategory, PermissionDecision>>`. Plan-mode preset uses this.
- `packages/bodhi-pi/src/sessions/session-bootstrap.ts:170-194` — `createPiAgent`'s `beforeToolCall` hook is where the gate goes. The existing `events.emitToolCall(...)` call already returns `{ block, reason }`; we extend the handler to also call `evaluateToolCall` and merge results.
- `packages/bodhi-pi/src/sessions/session-bootstrap.ts:114-135` — `composeSystemPrompt` is where the per-mode suffix appends. Suffix appends AFTER existing `appendSystemPrompt`.
- `packages/bodhi-pi/src/mcp/mcp-types.ts` — `McpToolInfo` interface to extend with `annotations?: McpToolAnnotations`.
- `packages/bodhi-pi/src/mcp/mcp-client.ts` / `src/mcp/mcp-connection-lifecycle.ts` — where `client.listTools()` returns the SDK's `Tool[]`. Extract `annotations` and persist on the cached `McpToolInfo`.
- `packages/bodhi-pi/src/mcp/mcp-registry.ts` — per-session tool registry; expose a getter for annotations of a given `<slug>__<tool>` name.
- `packages/bodhi-pi/src/tools/index.ts` — `toolKindFor(name)` already returns 7-wide `ToolCategory`. No changes needed; just consume from `evaluateToolCall`.
- `packages/bodhi-pi/src/events/types.ts` — `BodhiPiEvent` union to extend with `ToolBlockedEvent`.
- `packages/bodhi-pi/src/acp/event-wiring.ts:53-65` — `notifyLifecycle(...)` forwarder pattern; add `tool_blocked` to the forwarded set.
- `packages/bodhi-pi/src/acp/agent.ts:286-307` — `BodhiPiAcpAgent` constructor; PermissionService instantiation already done; this phase adds an MCP-tool-annotation callback into its deps.
- `packages/bodhi-pi/src/sessions/entries.ts:84-92` — `CustomMessageEntry` shape already exists; this phase uses it for the block-visible chat message.

**MCP SDK reference** (verify before C1):

- `node_modules/@modelcontextprotocol/sdk` — check version is `^1.29.0` or newer; spec annotations were added v2025-03-26. The `Tool` type should expose `annotations?: { readOnlyHint?, destructiveHint?, idempotentHint?, openWorldHint?, title? }`.

## Goal

Quoting milestone 030:

> Plan-mode goes from inert to actually rejecting mutating tool calls. Every layer the agent needs to enforce a mode (policy data, evaluation, gating, system-prompt steering) lands here — but only plan mode actually enforces. `ask`, `edit`, and `allow-all` modes remain effectively allow-all until milestone 040 wires the `request_permission` round-trip.

End-state:

- `MODE_PRESETS.plan.policy.categories` maps each `ToolCategory` to allow/deny per the locked table below.
- `MODE_PRESETS.plan.systemPromptSuffix` steers the LLM toward research.
- `PermissionService.evaluateToolCall(sessionId, toolCall)` consults the active session's mode preset, classifies the tool (built-in via `toolKindFor`; MCP via annotations on `McpToolInfo`), returns `{ kind: "allow" }` or `{ kind: "deny", reason }`.
- `createPiAgent`'s `beforeToolCall` hook calls `evaluateToolCall` after the existing `tool_call` extension event; on deny: returns `{ block: true, reason }` to pi-agent-core (which emits `isError: true` tool result with the reason text), appends a `custom_message` entry, emits a `tool_blocked` lifecycle event.
- `composeSystemPrompt` appends `MODE_PRESETS[currentMode].systemPromptSuffix` after the existing `appendSystemPrompt`. Mid-session mode change rebuilds the prompt (or document the limitation — see Open Questions below).
- All four reference Hosts surface the rejection consistently in their chat panels via the existing `custom_message` renderer.

## Locked scope decisions

| Decision | Locked answer | Where it lands |
|---|---|---|
| Phase scope | Plan-mode only enforces. Ask/edit/allow-all stay inert. | `MODE_PRESETS` (only `plan` filled in) |
| Block surface to LLM | `AgentToolResult` with `isError: true` + redirect text following Codex `amendment` pattern | `createPiAgent` `beforeToolCall` hook |
| Block surface to user | `custom_message` entry with `display: true` | `appendEntry` from the same hook |
| Tool list mutation on block | **None.** Tools stay visible; rejection is at call time. Active-tools-swap is milestone 090. | n/a |
| MCP classification | Read MCP SDK `annotations.readOnlyHint` / `destructiveHint`; default-ALLOW on absent (research-permissive per user requirement) | `McpToolInfo.annotations` + `evaluateToolCall` |
| Plan-mode policy | `read`/`search`/`subagent` allow; `edit`/`execute`/`other` deny; `mcp` per-annotation | `MODE_PRESETS.plan.policy.categories` |
| System-prompt suffix | Plan-mode appends the planner suffix from milestone 030's "System-prompt suffix" section | `composeSystemPrompt` |
| Wire methods added | **None.** No new `_bodhi-pi/*` methods, no new ACP methods. | n/a |
| `request_permission` round-trip | **Not in this phase.** Plan-mode rejections are unconditional; user opt-in to override is milestone 040. | n/a |
| `submit_plan` tool | **Not in this phase.** Plan-mode exit is via `/mode edit` slash for now. | n/a |
| 4-runtime UI changes | **None.** Existing `custom_message` renderer in all 4 Hosts is sufficient. | n/a |
| Subagent inheritance | Trivial: child inherits parent's mode (already wired in 020's `build-child-state.ts`). Full Qwen rule lands in milestone 080. | existing |
| `tool_blocked` lifecycle event | New event in `BodhiPiEvent` union; forwarded via `LIFECYCLE_EVENT_METHOD` | `src/events/types.ts` + `src/acp/event-wiring.ts` |
| Skill `allowed-tools` enforcement | Still deferred. Skills go through the same `beforeToolCall` gate but their `allowed-tools` field is not consulted. | (deferred follow-up) |

## Open exploration questions to resolve before designing

Resolve these by reading source first, then `AskUserQuestion` (with your recommended answer per question) before writing the plan. Batched per area:

### Q1 — System-prompt suffix on mid-session `/mode plan`

`composeSystemPrompt` runs at `buildSessionState` time. After `setSessionConfigOption("mode", "plan")` mid-session, the pi-agent-core `Agent`'s `state.systemPrompt` doesn't get recomputed. Three options:

- **(A) Rebuild + apply on mode change.** `PermissionService.setMode` calls back into a "rebuild system prompt" path (re-run `composeSystemPrompt` with the new mode; assign to `session.runtime.piAgent.state.systemPrompt`). Requires pi-agent-core to honour state mutation between turns (verify it does — `prepareNextTurn` pattern might help).
- **(B) Document the limitation.** Mode change takes effect on next session boot; the LLM continues with the old system prompt for the rest of the current session. The block-as-tool-result redirect text already steers the LLM in the right direction; the suffix is helpful but not load-bearing.
- **(C) Hybrid: append a `custom_message` system entry on mode change** like "You are now in plan mode. Use read-only tools and propose a plan." This shows up in the LLM's next context refresh (custom_message is a user-role display entry, so it goes into the prompt-loop history).

**Recommend (C)** — cheaper than (A), more steering than (B). The system prompt itself stays whatever it was; the LLM gets the redirect via an in-band user message at mode-change time + via tool-result amendments at block time.

### Q2 — MCP annotation cache invalidation

MCP servers can re-publish their tool list (notifications/tools/list_changed event). Today the registry doesn't subscribe to this; annotations would go stale if a server changes a tool from read-only to destructive mid-session. Three options:

- **(A) Refresh annotations on every `client.listTools()` call.** Current behaviour: tools are re-listed on every connect. Annotations follow naturally; staleness only happens between connects. Acceptable for v1.
- **(B) Subscribe to `notifications/tools/list_changed`** and refresh on event. More correct but adds plumbing.
- **(C) Refresh annotations on the FIRST tool-call after a `list_changed` notification.** Lazy invalidation.

**Recommend (A)** — staleness window equals a single session lifetime; user can `/mcp reconnect <slug>` to refresh if needed. Document the limitation.

### Q3 — Block redirect text shape: per-tool vs. per-category

Two extremes:

- **(A) Per-category template.** `"plan mode is read-only — \`{toolName}\` blocked (category: {category}). Use read-only tools or \`/mode edit\` to proceed."` Same shape every time. Reliable but generic.
- **(B) Per-tool customised.** `write` says "use `read` to inspect"; `bash` says "consider what command you want to run and describe it in the plan"; etc. More steering for the LLM.

**Recommend (A) with a per-tool override hook** — start with the category template; allow `MODE_PRESETS.plan.policy.tools[<name>]` to carry a redirect override message in the future (out of scope for this phase; flag in modes.md).

### Q4 — Tool-blocked event correlationId

`ToolBlockedEvent` shape: `{ sessionId, toolCallId, toolName, category, mode, reason }`. Should we also include the `correlationId` field used by the milestone 040 `ToolApprovalRequest`/`Response` events?

**Recommend NO** — `toolCallId` is already the natural correlation handle. `correlationId` was added to the *approval* events because there's a wire round-trip. Tool-blocks are one-shot (no response).

### Q5 — `evaluateToolCall` argument shape

Current stub signature: `evaluateToolCall(_sessionId: string, _toolName: string): Promise<ApprovalDecision>`. For MCP annotation lookup we need more than just the tool name — we need access to (a) the session's MCP registry to fetch annotations and (b) potentially the call's arguments for future fine-grained patterns (milestone 050).

Two options:

- **(A) Pass the full `ToolCall` object: `evaluateToolCall(sessionId, toolCall: { name: string; arguments: unknown })`.** Future-proof for fine-grained args; minor API churn now.
- **(B) Inject the MCP-annotation lookup via constructor; keep `evaluateToolCall(sessionId, toolName)` two-arg.** Cleaner per-call surface but harder to extend.

**Recommend (A)** — pi-agent-core's `BeforeToolCallContext` already carries the full toolCall; passing it through is natural. Update the stub signature in this phase to avoid a second refactor in milestone 050.

### Q6 — When does the LLM see the redirect: tool_result text vs. system message vs. both

The Codex `amendment` pattern: tool_result with `isError: true` carries the redirect text. The LLM sees this as part of its next-turn input via the prompt-loop history.

The OpenCode pattern adds a per-call system message via `pi-agent-core`'s structured prompt API (if it has one). We don't have that API today.

**Recommend tool_result text only** — pi-agent-core surfaces tool results back to the LLM via the `messages` array as `tool_result` content. The amendment text is in there. No additional steering channel needed for v1.

### Q7 — Subagent on plan-mode parent: inherit even when child profile declares a different mode?

Today `build-child-state.ts` (line ~85) copies `parent.runtime.mode` into the child unconditionally. This is what we want for v1. Milestone 080 layers the Qwen rule (profile mode is honored except parent="allow-all"/edit which floors child up).

For this phase: **child sessions ALWAYS inherit parent mode**, even when a `SubagentProfile.mode?` field is set (we ignore the field). Test asserts this. Milestone 080 then introduces the field and the Qwen logic.

**Recommend confirm** — no design choice; verify the implementation matches.

### Q8 — Test layout

- `test/plan-mode-policy.test.ts` (integration, faux provider) — per-category gating + custom_message + tool_blocked event
- `test/plan-mode-mcp.test.ts` (integration, mock MCP) — annotation classification
- `test/plan-mode-subagent.test.ts` (integration) — child inherits parent mode + child blocks too
- `e2e/shared/plan-mode.e2e.ts` — single shared e2e exercising plan-mode across all 6 runtimes (gpt-4o-mini)
- e2e-ui Playwright spec — out of scope? Plan-mode is observable via `custom_message` in the chat, which the existing `simple-chat.spec.ts` already covers indirectly. **Recommend skip Playwright in this phase**; add a minimal `plan-mode.spec.ts` in milestone 060 alongside the approval UI.

**Recommend the four test files above** + skip Playwright in this phase.

## Process — iterative TDD across the matrix

Per `packages/bodhi-pi/CLAUDE.md` 6-step workflow + `feedback_e2e_coverage_keeps_feature` + `feedback_phasing_depth_first` (depth-first per runtime). Recommended cadence (mirrors phase 0):

1. **Integration first.** `test/plan-mode-policy.test.ts` — failing tests that drive design. Make pass in `src/`.
2. **MCP annotation integration test.** `test/plan-mode-mcp.test.ts`.
3. **Subagent test.** `test/plan-mode-subagent.test.ts`.
4. **e2e (gpt-4o-mini).** `e2e/shared/plan-mode.e2e.ts`. Verifies the LLM adapts to the redirect ("you're in plan mode; describe a plan instead of editing").
5. **Per-runtime gate.** Each of `in-memory`, `cli`, `http`, `ws`, `browser`, `chrome-ext` projects must pass the shared e2e.
6. **Spec updates same-commit.** `modes.md` (sections + status table), `acp.md`, `lifecycle.md`, `mcp.md`. Each touched spec gets its row updated.

Each commit ends green on `npm run check` + the relevant test slices.

## Gate-check + commit cadence

Suggested commit shape (NOT prescriptive — slice however makes commits bisectable):

- **C1**: `bodhi-pi modes 030a: MCP tool annotations + McpToolInfo extension` — add `McpToolAnnotations` type, parse annotations at connect, persist on registry, expose lookup. Pure plumbing; no enforcement yet.
- **C2**: `bodhi-pi modes 030b: plan-mode preset + evaluateToolCall implementation` — fill in `MODE_PRESETS.plan.policy` + `systemPromptSuffix`. Replace `evaluateToolCall` stub with real per-category lookup + MCP-annotation consultation.
- **C3**: `bodhi-pi modes 030c: tool-call gating in createPiAgent + tool_blocked event + custom_message on block` — wire `evaluateToolCall` into `beforeToolCall`; append `custom_message`; emit `tool_blocked`; event-wiring forwards.
- **C4**: `bodhi-pi modes 030d: planner system-prompt suffix + mode-change steering` — `composeSystemPrompt` appends suffix. On mode change emit a per-mode `custom_message` so mid-session change steers the LLM (per Q1 option C).
- **C5**: `bodhi-pi modes 030e: e2e plan mode across 6 runtimes + spec docs` — `e2e/shared/plan-mode.e2e.ts`. modes.md spec doc update + lifecycle + acp + mcp notes. modes.md implementation table flips 030 ☑.

Atomic-commit pattern per `feedback_atomic_commit_with_reset`: single chained `git reset . && git add <paths> && git commit ...`.

## Plan structure (mandatory sections)

When you write the plan after grilling the user, include:

1. **Goal restatement** — quote 030's "What ships" section.
2. **Locked-scope summary** — table: decision → user-locked answer → file:line where it lands.
3. **Open-question resolutions** — table: question → recommended answer → user-answer (filled during grilling).
4. **File-level inventory** — new files, touched files, spec docs amended. Per file: one-line purpose.
5. **Per-commit slice** — propose commits + the validation gate per commit (`npm run check` + which test files + which e2e specs).
6. **Verification matrix** — per runtime: which `npm` / `vitest` / `playwright` command to run after each commit lands. Include both unit and e2e suites.
7. **Risk register** — MCP SDK version mismatch; pi-agent-core `block` return surfacing; mid-session system-prompt staleness; MCP-annotation cache staleness; custom_message ordering relative to tool result.
8. **Out of scope** — explicitly: `request_permission` (040); `submit_plan` (060); ask/edit/allow-all enforcement (040, 070); fine-grained patterns (050); persistent rules (100); active-tools-swap (090); subagent profile mode field + Qwen rule (080).

## Anti-patterns to avoid

- **Don't strip tools from the LLM's tool list when mode = plan.** Active-tools-swap is milestone 090. The gate fires at call-time; the LLM keeps seeing `write` / `bash` and gets a structured redirect on denial.
- **Don't throw a hard error on block.** Tool result is `isError: true` with redirect text; the turn continues so the LLM can adapt. Hard-throwing breaks the research loop.
- **Don't invent a new wire method for the rejection.** The block is purely in-agent. The LLM sees a normal `tool_result`; the user sees a normal `custom_message`. Wire surface unchanged from milestone 020.
- **Don't enforce `ask` mode in this milestone.** `request_permission` round-trip is milestone 040. Ask-mode `evaluateToolCall` keeps returning `{ kind: "allow" }`.
- **Don't default-deny MCP tools without annotations.** Research-permissive default: unknown MCPs allowed in plan mode. Default-deny here would render plan mode useless against unannotated servers.
- **Don't omit the redirect text.** A `{ kind: "deny", reason: "" }` denial means the LLM gets a generic error. The Codex `amendment` pattern (tell the LLM what to do next) is the load-bearing UX win — keep it explicit and specific.
- **Don't add a `submit_plan` tool.** The LLM-graduation flow is milestone 060. In this phase the only exit from plan mode is the user typing `/mode edit`.
- **Don't wire approval UI changes.** No 4-runtime UI work in this phase. Existing `custom_message` rendering carries the block. Approval UI is milestone 060.
- **Don't add `node:*` imports to `src/permissions/`** — runtime-neutrality rule from `packages/bodhi-pi/CLAUDE.md`.
- **Don't enforce skills `allowed-tools` in this milestone.** Skills go through the same `beforeToolCall` gate but the `allowed-tools` field isn't consulted. Document; defer.
- **Don't write to the deprecated `packages/bodhi-pi-*` sibling packages.** New work lands under `packages/bodhi-pi/test-apps/`.

## References

- Modes p0 retrospective: commit `c93fc25a` body — what shipped, what carried forward, what got punted.
- Modes research wave (Q1 2026):
  - `ai-docs/research/modes/report.md` — synthesis report including per-harness plan-mode block patterns.
  - `notes/02-cc-claude-code.md` — cc's permission pipeline (pure prompt-steering; we improve on it).
  - `notes/03-opencode.md` — opencode's `DeniedError` + ruleset transparency.
  - `notes/06-cline-roo.md` — Cline's defence-in-depth plan-mode gate + Roo's file-restriction error structure.
  - `notes/07-codex.md` — Codex's `Forbidden` + optional `amendment` (the pattern we adopt).
- Sibling milestone files:
  - `milestones/000-overview.md` (READ first)
  - `milestones/005-acp-architecture-decision.md` (READ FIRST — binding)
  - `milestones/030-plan-mode-plumbing.md` — this phase's milestone doc.
  - `milestones/040-ask-mode-and-approval-flow.md` — next phase preview.
- ACP spec sources:
  - `docs/protocol/tool-calls.mdx` — `request_permission` for context (deferred to 040).
- Bodhi-pi pattern references:
  - `src/sessions/session-bootstrap.ts:170-182` — `beforeToolCall` hook to extend.
  - `src/mcp/mcp-types.ts` — `McpToolInfo` interface.
  - `src/events/types.ts` — `BodhiPiEvent` union.
  - `src/acp/event-wiring.ts:53-65` — `notifyLifecycle` pattern.

## When done

Print: the plan path, the count of open questions resolved during grilling, and the proposed commit subjects in order. Do not start executing the plan in this round — the plan IS the deliverable. Implementation runs in a separate session, ideally guided by `superpowers:executing-plans` or an equivalent execution-mode harness.

The implementation session lands C1-C5 commits on `main` per trunk-based dev, each individually green against `npm run check` + `npm test` + the relevant `just test-e2e` slices. After all commits land, append to (or create) `ai-docs/modes/p1-retrospective.md` capturing what surprised, what carried forward, what got punted to phase 2 (milestone 040).

**After this phase lands, the user can manually test plan mode end-to-end:**

1. `npm --workspace @bodhiapp/bodhi-pi-test-app-cli run dev`
2. `/mode plan` → see `[plan]` badge in prompt
3. "Read the file at packages/bodhi-pi/src/index.ts and tell me what's exported" → succeeds (read allowed)
4. "Now add a console.log to that file" → blocked with redirect text in the assistant turn + a `custom_message` block in the transcript
5. `/mode edit` → same prompt now succeeds
6. The same flow works in http/browser/chrome-ext Hosts

That's the deliverable.
