# Milestone 030 — Plan-mode plumbing (policy engine v1)

**Status:** Next slab. Builds on 020 (mode state + setSessionConfigOption already shipped).

**Read first:** [`005-acp-architecture-decision.md`](005-acp-architecture-decision.md) — wire-surface decisions are binding. This milestone does NOT add new wire methods; it adds in-agent enforcement only.

## What ships

The smallest dependency-resolving slab that makes `mode = plan` do something. Plan-mode goes from inert to actually rejecting mutating tool calls. Every layer the agent needs to enforce a mode (policy data, evaluation, gating, system-prompt steering) lands here — but only **plan mode actually enforces**. `ask`, `edit`, and `allow-all` modes remain effectively allow-all until milestone 040 wires the `request_permission` round-trip.

**Why this slice:** the user asked for iterative-evolutionary phasing toward eventually being able to manually test plan mode. The next dependency on that path is: PermissionService must consult policy at tool-call time and rejections must be visible to both the LLM and the chat transcript. Once that infrastructure exists, milestone 040 layers ACP-native `requestPermission` for ask/edit, and milestone 060 layers the `submit_plan` exit + 4-runtime approval UI on top.

After this milestone lands you can manually:

- `/mode plan` in any reference Host.
- Prompt the agent to "explore the codebase" — `read` / `ls` / `find` / `grep` and read-MCP tools all work.
- Prompt the agent to "fix the bug in X" — every `write` / `edit` / `bash` / destructive-MCP tool call returns an error tool-result with a redirect message ("plan mode is read-only; describe your plan or `/mode edit` to proceed").
- See a `custom_message` system entry in chat for each blocked call so you understand what happened.
- `/mode edit` and the same prompt now succeeds — proves the gate is mode-driven, not a global change.

Nothing else changes. No new wire methods. No approval UI. No `submit_plan` tool. No client UX additions beyond the existing `custom_message` rendering that all four Hosts already support.

## Scope

### In-scope

1. **`MODE_PRESETS.plan` becomes real.** The placeholder `EMPTY_POLICY` is replaced with the plan-mode policy: `read`, `search`, `subagent` allowed; `edit`, `execute` denied; `mcp` deferred to per-tool annotation (see §MCP classification below). Other presets stay as placeholders — `MODE_PRESETS.ask` returns allow-all, same for `edit`; `allow-all` already allows everything.
2. **`PermissionService.evaluateToolCall(sessionId, toolCall)` becomes real.** Today it returns `{ kind: "allow" }` unconditionally. After this milestone it consults the active mode's preset, the tool's category (via `toolKindFor` + MCP annotation lookup), and returns `{ kind: "allow" }` or `{ kind: "deny", reason }`.
3. **Tool-call gating wired through `createPiAgent`'s `beforeToolCall` hook.** The existing `tool_call` event already runs there (see `src/sessions/session-bootstrap.ts:169-180`); we add a same-loop call to `permissionService.evaluateToolCall(...)` and surface its deny as `{ block: true, reason }`.
4. **MCP annotation parsing.** Today `McpToolInfo` carries `name`, `description`, `inputSchema`. We add optional `annotations: { readOnlyHint?, destructiveHint?, idempotentHint?, openWorldHint? }` from the MCP SDK's `Tool` type (spec v2025-03-26). Parsed at connect time, cached on `McpToolInfo`, consulted by `evaluateToolCall` when the tool is MCP-namespaced.
5. **System-prompt suffix per mode.** A new `MODE_PRESETS.<mode>.systemPromptSuffix` field is appended to the composed system prompt at `buildSessionState` time. Plan-mode's suffix steers the LLM toward research: "You are in plan mode. Use read-only tools to explore. Propose a plan in natural language. Switch to edit mode to implement." Other modes have empty suffixes for now.
6. **Block-as-tool-result + custom_message entry.** When `evaluateToolCall` denies, the tool call short-circuits with an `isError: true` tool-result whose text is the redirect message (Codex-style amendment pattern from research). In parallel, a `custom_message` entry with `display: true` is appended so the user sees the block in chat history (visible across all 4 Hosts via the existing custom_message renderer).
7. **`PermissionGrantResult` lifecycle event.** A new `tool_blocked` lifecycle event fires when a tool is denied. Carries `{ sessionId, toolCallId, toolName, category, mode, reason }`. Forwarded to the wire via existing `LIFECYCLE_EVENT_METHOD` so Host event panels surface the block.
8. **`subagent` category gets a plan-mode allow.** Plan mode permits `subagent` so the LLM can delegate research tasks. The delegated child inherits plan mode (Qwen rule — but the full inheritance plumbing lands in milestone 080; in 030 the child just runs in whatever its parent's mode is, which for a plan-mode parent is plan).
9. **Cross-runtime parity.** All four reference Hosts (`test-apps/{cli,http,browser,chrome-ext}`) must show the plan-mode rejection consistently in chat and survive their respective transport quirks (cli stdio, http per-turn rebuild, browser Worker, chrome-ext sandbox).

### Out-of-scope (deferred)

- **ACP `session/request_permission` round-trip** — milestone 040. Plan-mode rejections in this milestone are unconditional (no user opt-in to override). `ask` / `edit` modes stay allow-all until 040.
- **`submit_plan` built-in tool** — milestone 060. Plan-mode exit in this milestone is via the existing `/mode edit` slash; no LLM-callable graduation.
- **4-runtime approval UI** — milestone 060. This milestone uses only the existing `custom_message` chat-renderer.
- **Fine-grained `bash:<cmd>` / `mcp:<slug>__<tool>` patterns** — milestone 050. This milestone gates at the category granularity (plus MCP annotation lookup for the `mcp` category).
- **Persistent `alwaysAllow` / `alwaysDeny`** — milestone 100.
- **Active-tools swap** (removing denied tools from the LLM's tool list entirely) — milestone 090. This milestone uses gate-at-call-time: the LLM still sees `write` / `edit` / `bash` in its tool list, calls them, and gets a structured rejection.
- **Sub-agent profile mode field + Qwen inheritance** — milestone 080.

## Locked decisions

### Block semantics: tool_result + redirect message + chat entry (Codex + OpenCode hybrid)

Per the modes research wave's harness audit (cf. `report.md` and the `02-cc-claude-code`, `03-opencode`, `07-codex` notes):

- **LLM surface:** denied tool returns a normal `AgentToolResult` with `isError: true` and text following the Codex `amendment` pattern — tell the LLM what went wrong AND what it CAN do. Example: `"plan mode is read-only — \`write\` to /foo blocked. Use \`read\` to inspect files, or \`/mode edit\` to proceed with edits."` This explicit redirect outperforms cc's pure prompt-steering: the model gets a structured reason it can adapt to in the same turn.
- **User surface:** a `custom_message` entry with `display: true` is appended in parallel so the block appears in the chat transcript. Persists in the session DAG; survives reload. Renders identically across all 4 Hosts via the existing renderer.
- **Tool list unchanged:** the LLM keeps seeing every tool. Rejection is at call time, not at tool-list construction. This matches cc/OpenCode/Codex; active-tools-swap (milestone 090) is the alternate model we defer.
- **No hard throw:** we never abort the turn on a block. The LLM's next thought / next tool call proceeds normally.

### Plan-mode policy (per category)

| Category | Decision | Rationale |
|---|---|---|
| `read` | allow | research is the point |
| `search` | allow | `ls` / `find` / `grep` are read-only |
| `subagent` | allow | delegated research is the point |
| `edit` | deny | `write` / `edit` mutate the workspace |
| `execute` | deny | `bash` / `run_script` can mutate anything |
| `mcp` | per-annotation (see below) | spec-driven; research-permissive default |
| `other` | deny (defensive) | unknown ≠ safe in research mode |

### MCP per-tool classification

When `evaluateToolCall` sees a tool with category `"mcp"`, it looks up the MCP tool's `annotations` (parsed from the MCP SDK at connect time and persisted on `McpToolInfo`):

| Annotation state | Plan-mode decision |
|---|---|
| `readOnlyHint: true` | **allow** |
| `destructiveHint: true` | **deny** |
| Both absent / both false | **allow** (research-permissive default per user requirement) |

The user explicitly said: "for mcps we need to allow read mcps, and only block destructive mcps; if no info on operations allow those mcps." MCPs and read-only tools are critical during research. The research-permissive default here intentionally trades safety for utility — a destructive MCP that fails to declare `destructiveHint` will be allowed in plan mode. This is acceptable because (a) MCP servers that mutate state SHOULD be declaring the annotation, (b) the user can always switch out of plan mode if they want stricter gating, (c) the alternative (default-deny) makes plan mode useless for any unknown MCP and contradicts the research-mode philosophy.

Annotation parsing path: `McpConnectionLifecycle.connect(...)` already retrieves the tool list via the SDK's `client.listTools()`. The SDK returns `Tool[]` with optional `annotations` field. We extend `McpToolInfo` (in `src/mcp/mcp-types.ts`) to carry `annotations?: McpToolAnnotations`, persist them on the `McpRegistry`'s in-memory map, and consult them in `PermissionService.evaluateToolCall`. Annotations are NOT persisted in KV — re-fetched on every connect.

### System-prompt suffix

Plan mode appends to the composed system prompt:

```
You are operating in PLAN MODE.

Your job is to research and propose, not to implement. Use read-only tools
(read, ls, find, grep) and read-only MCP tools to explore the codebase. Use
the subagent tool to delegate focused research tasks. Do NOT call write,
edit, bash, or other mutating tools — they will be rejected.

When your analysis is complete, propose your plan to the user as natural
language text. The user will review and either ask you to revise (stay in
plan mode) or approve and switch to edit/allow-all mode for execution.
```

This is the Cline approach (research-mode prompt steering) plus the Codex amendment-on-block pattern. The LLM is told what to do *and* what will happen if it deviates.

Suffix is held in `MODE_PRESETS.plan.systemPromptSuffix` (already typed in `ModePreset` from milestone 010); other modes leave the field unset.

### Where the gate fires

`createPiAgent` in `src/sessions/session-bootstrap.ts:170-182` already wraps every tool call in `beforeToolCall` and emits a `tool_call` event. We extend this hook to:

1. Emit the existing `tool_call` event (unchanged — extensions still get first crack at vetoing via the `block` return).
2. If the extension didn't block, call `permissionService.evaluateToolCall(args.sessionId, ctx.toolCall)`.
3. If the decision is `{ kind: "deny", reason }`, return `{ block: true, reason }` — pi-agent-core honors this and emits an `isError: true` tool result with the reason text.
4. Same handler also appends the `custom_message` entry (via `appendEntry`) so the chat shows the block.
5. Same handler emits the new `tool_blocked` lifecycle event (forwarded over `LIFECYCLE_EVENT_METHOD` by `event-wiring.ts`).

This gives extensions priority (an extension can still allow a block) while keeping the agent's policy as the final word when extensions don't speak up.

### Subagent inheritance: minimal

Plan-mode subagent calls run the child in whatever the parent's mode is. Today that's automatic because subagent creation copies parent runtime mode into the child's `SessionState.runtime.mode` (already wired in milestone 020's `build-child-state.ts`). No additional code needed; we just write a test verifying that a plan-mode parent's subagent runs in plan mode and a `write` inside the child is also blocked.

Full Qwen inheritance (profile-declared mode interacting with parent mode) lands in milestone 080.

## File-level inventory

### New source files

- None. All work extends existing files.

### Touched source files

- `src/permissions/types.ts` — confirm `ModePreset.systemPromptSuffix?` is exposed (it's already typed; verify the export); add `McpToolAnnotations` interface mirroring SDK's `ToolAnnotations`.
- `src/permissions/presets.ts` — fill in `MODE_PRESETS.plan.policy` with the per-category map AND `systemPromptSuffix`. Other presets stay as placeholders.
- `src/permissions/permission-service.ts` — replace the stub `evaluateToolCall` with a real implementation: classify tool via `toolKindFor` (with MCP namespacing detection already in place), consult preset policy, for MCP tools also look up annotations via injected MCP-tool-lookup callback.
- `src/mcp/mcp-types.ts` — add `McpToolAnnotations` field on `McpToolInfo`.
- `src/mcp/mcp-connection-lifecycle.ts` — parse `annotations` from each `Tool` returned by `client.listTools()` and persist on the cached `McpToolInfo`.
- `src/mcp/mcp-registry.ts` — extend the registry to expose `getToolAnnotations(sessionId, toolName)` for the gate to call.
- `src/acp/agent.ts` — wire `PermissionService` deps: inject the MCP-tool-annotation lookup callback so it doesn't take a hard dep on `McpService`. Also pass to `bootstrapDeps()` so `createPiAgent` can access it.
- `src/sessions/session-bootstrap.ts` — in `createPiAgent`'s `beforeToolCall` handler, after the existing `events.emitToolCall(...)` check, call `permissionService.evaluateToolCall(...)`. On deny, append `custom_message` entry, emit `tool_blocked` event, return `{ block: true, reason }`.
- `src/sessions/session-bootstrap.ts` — `composeSystemPrompt`: append `MODE_PRESETS[mode].systemPromptSuffix` (when non-empty) AFTER existing `appendSystemPrompt`. Re-resolved at rehydrate so mode-changed sessions get the right prompt on next prompt.
- `src/events/types.ts` — add `ToolBlockedEvent` to the union, plus its handler entry.
- `src/acp/event-wiring.ts` — forward `tool_blocked` over `LIFECYCLE_EVENT_METHOD`.
- `src/index.ts` — re-export `ToolBlockedEvent`, `McpToolAnnotations`.
- `src/wire/constants.ts` — no changes (no new wire methods).

### New test files

- `packages/bodhi-pi/test/plan-mode-policy.test.ts` — integration tests with faux provider. Cases:
  1. Default mode (ask) — `write` succeeds, `bash` succeeds (allow-all-everything still true for non-plan modes).
  2. `setSessionConfigOption(mode=plan)` — `read` succeeds.
  3. Plan mode — `write` returns `isError: true` with redirect text.
  4. Plan mode — `bash` returns `isError: true`.
  5. Plan mode — `custom_message` entry appended for the block; visible in `_bodhi-pi/session/entries`.
  6. Plan mode — `tool_blocked` lifecycle event fired with category/reason.
  7. `setSessionConfigOption(mode=edit)` — `write` succeeds again (mode-driven, not stuck).
  8. System prompt: plan mode includes the planner suffix; non-plan modes don't.
- `packages/bodhi-pi/test/plan-mode-mcp.test.ts` — MCP annotation gating:
  1. MCP tool with `readOnlyHint: true` — allowed in plan mode.
  2. MCP tool with `destructiveHint: true` — denied in plan mode.
  3. MCP tool with no annotations — allowed in plan mode (research-permissive default).
- `packages/bodhi-pi/test/plan-mode-subagent.test.ts` — subagent inheritance:
  1. Parent in plan mode spawns a subagent. Child runs in plan mode (already wired in build-child-state).
  2. Subagent attempts `write` — blocked with `isError: true`.
- `packages/bodhi-pi/e2e/shared/plan-mode.e2e.ts` — single shared e2e exercising plan-mode behaviour across all 6 runtimes (in-memory + cli + http + ws + browser + chrome-ext): set mode=plan, prompt the LLM to write a file, verify (a) the LLM's tool_result is `isError: true`, (b) the file was NOT created on disk, (c) the chat transcript carries a `custom_message` for the block.

### Touched test files

- `packages/bodhi-pi/test/modes-state.test.ts` — extend with one new test: `plan-mode policy stub previously returned allow; verify it now returns deny for edit category`.
- `packages/bodhi-pi/test/helpers/harness.ts` — possibly add a helper for asserting "tool result was a block" since multiple tests need it.

### Spec docs

- `ai-docs/specs/bodhi-pi/modes.md` — update implementation-status table: milestone 030 ☑. Add a "Plan mode enforcement" section describing the gating semantics (LLM redirect message, custom_message entry, MCP annotation classification, system-prompt suffix). Cross-link to `acp.md`'s tool-call gating discussion.
- `ai-docs/specs/bodhi-pi/acp.md` — add a brief note in the `prompt` / tool-call section that built-in tools may short-circuit with `isError: true` based on the active mode's policy.
- `ai-docs/specs/bodhi-pi/lifecycle.md` — note that `custom_message` entries appear for tool-blocks; not a new entry type, but a new use-case.
- `ai-docs/specs/bodhi-pi/mcp.md` — note that `McpToolInfo.annotations` is parsed from the SDK and consulted by the mode policy gate.

## Commit slice (proposed)

| # | Subject | Contents |
|---|---|---|
| C1 | `bodhi-pi modes 030a: MCP tool annotations + McpToolInfo extension` | Add `McpToolAnnotations` type, parse annotations at connect, persist on registry, expose lookup. Pure plumbing; no enforcement yet. Tests: round-trip on a faux MCP server. |
| C2 | `bodhi-pi modes 030b: plan-mode preset + evaluateToolCall implementation` | Fill in `MODE_PRESETS.plan.policy` + `systemPromptSuffix`. Replace `evaluateToolCall` stub with the real per-category lookup + MCP-annotation consultation. Tests: per-category allow/deny in isolation (without yet wiring the gate). |
| C3 | `bodhi-pi modes 030c: tool-call gating in createPiAgent + tool_blocked event` | Wire `evaluateToolCall` into `beforeToolCall`. Append `custom_message` on block. Emit `tool_blocked` lifecycle event. event-wiring forwards it. Tests: plan-mode-policy.test.ts (integration). |
| C4 | `bodhi-pi modes 030d: planner system-prompt suffix` | `composeSystemPrompt` appends `MODE_PRESETS[mode].systemPromptSuffix`. Tests: plan mode includes the suffix; other modes don't. |
| C5 | `bodhi-pi modes 030e: e2e plan mode across 6 runtimes + spec docs` | `e2e/shared/plan-mode.e2e.ts`. Modes spec doc update, acp/lifecycle/mcp notes. modes.md implementation table flips 030 ☑. |

Each commit lands green on `npm run check` + `npm test` + relevant e2e slices. Atomic-commit pattern (`git reset . && git add <paths> && git commit ...`).

## Verification matrix

| Runtime | Command | What it proves |
|---|---|---|
| bodhi-pi core | `npm test --workspace=packages/bodhi-pi -- plan-mode` | per-category gating, MCP annotation classification, subagent inheritance, custom_message entry, tool_blocked event |
| bodhi-pi core e2e | `just test-e2e plan-mode` | real LLM (gpt-4o-mini) plan-mode round-trip; LLM sees redirect text and adapts |
| Per-Host parity | same e2e under cli + http + ws + browser + chrome-ext projects | block visible in 4 reference Hosts; survives per-turn rebuild, MessagePort transport, etc. |
| Full check | `npm run check` | typecheck + biome + host/client seam + browser smoke |

## Risk register

1. **MCP annotation SDK version.** Annotations were added in MCP spec v2025-03-26. Verify `@modelcontextprotocol/sdk@^1.29.0` (current dep version) carries them. If older, bump SDK before C1. Confirm by reading `node_modules/@modelcontextprotocol/sdk/dist/.../types.d.ts`.
2. **MCP server compliance.** Many servers don't declare `readOnlyHint`/`destructiveHint`. Research-permissive default (allow on absent) is documented but means an unknown destructive server is reachable in plan mode. Acceptable per user requirement; flag in `modes.md`.
3. **pi-agent-core `block` return contract.** The `BeforeToolCallResult` shape `{ block: true, reason?: string }` is what pi-agent-core honors. Verify the reason string actually surfaces in the resulting tool_result text (not silently dropped). If pi-agent-core's behavior differs, write a small adapter in `createPiAgent` that wraps the block as an `isError: true` tool result directly.
4. **`custom_message` entry display ordering.** The entry must appear chronologically near the rejected tool call. Since both events fire from the same `beforeToolCall` hook synchronously, ordering should be deterministic. Verify in e2e (per-Host display).
5. **System-prompt suffix not picked up after mid-session `/mode plan`.** `composeSystemPrompt` runs at `buildSessionState` time. Mid-session mode change does NOT rebuild the system prompt. **Decision:** rebuild the system prompt on mode change too — extend `PermissionService.setMode` to call back into `bootstrapDeps` to re-run `composeSystemPrompt` + reset the pi-agent-core state. OR document the limitation and require a session restart for the suffix to take effect. Pick at C2 design time; second option is simpler if the LLM-block redirect message already steers the LLM enough.
6. **Skill `allowed-tools` interaction.** Skills with `allowed-tools` frontmatter are still not enforced in this milestone (deferred). A skill that lists a write-tool in its allowed-tools won't fail validation but the tool itself will be blocked in plan mode. Document.

## Out of scope (explicit)

- Approval round-trip via `session/request_permission` — milestone 040.
- `ask` / `edit` modes actually gating — milestone 040 (`ask` adds the round-trip; `edit` derives from ask + per-category overrides).
- `submit_plan` built-in tool, plan-mode exit auto-transition, 3-option `request_permission` for plan exit — milestone 060.
- 4-runtime approval UI — milestone 060.
- Active-tools swap (LLM tool list mutation on mode change) — milestone 090.
- Fine-grained `bash:<cmd>` / `mcp:<slug>__<tool>` patterns — milestone 050.
- Persistent `alwaysAllow` / `alwaysDeny` rules — milestone 100.
- Sub-agent `SubagentProfile.mode?` field + Qwen inheritance — milestone 080.

## Anti-patterns to avoid

- **Don't strip tools from the LLM's tool list.** Active-tools-swap is milestone 090 and is intentionally deferred. The gate fires at call time; the LLM sees the full list and gets a structured redirect on denial.
- **Don't throw a hard error on block.** A blocked tool returns `isError: true` with redirect text; the turn continues so the LLM can adapt or graduate to a read tool. Hard-throwing breaks the research loop.
- **Don't invent a new wire method for the rejection.** The block is purely in-agent. The LLM sees a normal `tool_result`; the user sees a normal `custom_message`. The wire surface stays unchanged from milestone 020.
- **Don't enforce `ask` mode in this milestone.** The `request_permission` round-trip is milestone 040. `ask` mode in this milestone returns `{ kind: "allow" }` from `evaluateToolCall` — same as before.
- **Don't default-deny MCP tools without annotations.** User requirement is research-permissive: unknown MCPs allowed in plan mode. Default-deny here would render plan mode useless against the vast majority of real-world MCP servers.
- **Don't omit the redirect text.** A `{ kind: "deny", reason: "" }` denial means the LLM gets a generic error. The Codex `amendment` pattern (tell the LLM what to do next) is the load-bearing UX win — keep it explicit and specific.

## References

- Research synthesis: `ai-docs/research/modes/report.md` lines 700–826 (plan-mode block patterns across harnesses).
- Per-harness notes: `notes/02-cc-claude-code.md`, `notes/03-opencode.md`, `notes/07-codex.md`, `notes/06-cline-roo.md` (block surface comparisons).
- Spec: `ai-docs/specs/bodhi-pi/modes.md` (canonical mode + permission doc — extend here).
- Code seams cited above:
  - `src/sessions/session-bootstrap.ts:170-182` — `beforeToolCall` hook to extend.
  - `src/permissions/presets.ts` — fill in plan policy.
  - `src/permissions/permission-service.ts` — implement `evaluateToolCall`.
  - `src/mcp/mcp-connection-lifecycle.ts` — parse annotations at connect.
  - `src/mcp/mcp-types.ts` — extend `McpToolInfo`.
  - `src/acp/event-wiring.ts` — forward `tool_blocked`.

## When done

- Phase 0 ☑ (010 + 020 — landed in commit `c93fc25a`).
- Phase 1 ☑ (this milestone — 030).
- Manual smoke path: `/mode plan` → ask the agent to fix a bug → see all edits rejected with redirect text → chat history carries `custom_message` blocks → `/mode edit` → same fix succeeds. This is the first phase where the user can manually exercise plan-mode behaviour end-to-end.
- Next phase: milestone 040 — `ask` mode + ACP-native `session/request_permission` round-trip + 4-runtime approval UI.
