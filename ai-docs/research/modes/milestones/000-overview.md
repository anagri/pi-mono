# Bodhi-Pi modes — milestone overview

**Owner role:** AI coding assistant
**Source-of-truth research:** [`../report.md`](../report.md) + per-harness notes under [`../notes/`](../notes/) (12-acp-spec, 13-zed, 14-claude-agent-acp, 15-codex-acp, 16-goose-acp, 17-pi-acp)
**Companion research:** [`../../sub-agents/`](../../sub-agents/)
**Target spec dir:** [`ai-docs/specs/bodhi-pi/`](../../../specs/bodhi-pi/)

> ⚠ **READ [005-acp-architecture-decision.md](005-acp-architecture-decision.md) BEFORE STARTING ANY MILESTONE.** It supersedes the wire-surface choices in this overview document. Where they conflict, 005 wins. Specifically: bodhi-pi uses native `session/setSessionConfigOption` (not the deprecated `session/setSessionMode`), `session/request_permission`, and `session/update { sessionUpdate: "config_option_update" }` — NO `_bodhi-pi/mode/*` or `_bodhi-pi/permission/*` extension methods are added.

This folder is a **sequential implementation plan** for adding agent operating modes and permission policies to `packages/bodhi-pi`. Each milestone (`010-…`, `020-…`, …) is a self-contained brief sized to land as a single commit (or a tight commit sequence) on `main`, fully green against `npm run check`, `npm test`, `just test-e2e`, and `just test-e2e-ui`. The numbering uses 10-unit gaps so additional milestones can be inserted between (e.g. `035-`) without renaming.

The milestones are **depth-first**: each milestone delivers a slice end-to-end across all four reference Hosts (`test-apps/{cli,http,browser,chrome-ext}`) before the next milestone begins. The first two milestones (010/020) lay the inert plumbing — types, mode state, dispatch refactor — and have shipped. **The current next phase is milestone 030 (plan-mode plumbing)**, which makes plan mode the first mode that actually rejects tool calls. Ask + edit + the approval round-trip + the `submit_plan` exit layer on top in subsequent milestones.

## What we're shipping

A four-mode user-facing enum (`ask`, `plan`, `edit`, `allow-all`) backed by a per-category `PermissionPolicy` with per-tool overrides. Approvals ride the **native ACP `session/request_permission` round-trip**. Mode changes ride the **native ACP `session/setSessionConfigOption` method with `configId: "mode"`** (preferred over the deprecated `session/setSessionMode`) and surface to clients via `ConfigOptionUpdate` session notifications. Default mode for new sessions is `ask`. `allow-all` is gated by a per-Host `allowsAllowAllMode` capability (`false` for browser + chrome-ext by default). Sub-agent profiles can declare their own mode and the parent's mode floors the child's (Qwen Code rule).

## Key architectural decisions (locked)

### 1. Ride on ACP-native methods, not custom `_bodhi-pi/*` wire

The ACP spec gives us (verified against the live spec + SDK schema — see [notes/12-acp-spec.md](../notes/12-acp-spec.md)):

- `session/setSessionConfigOption { configId: "mode", value: <modeId> }` — **live, preferred** path for client-initiated mode change. The bodhi-pi codebase already implements this wire method for `model` + `thinking`; adding `mode` is one entry in the existing dispatch table at `src/models/registry.ts:217-236`.
- `session/setSessionMode { modeId }` — **deprecated** — will be removed in a future protocol version. Bodhi-pi will NOT implement this.
- `session/request_permission` (Agent → Client) — live, with `PermissionOptionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always"`. `optionId` is agent-defined arbitrary string (encodes semantics like scope or target mode).
- `session/update { sessionUpdate: "config_option_update", configOptions: [...] }` — live, preferred for agent-initiated mode change. `current_mode_update` is the deprecated counterpart.
- `NewSessionResponse.configOptions[]` with `category: "mode"` — live, preferred for advertising available modes at session bootstrap.
- `ToolCallStatus = "pending" | "in_progress" | "completed" | "failed"` — `pending` covers both streaming-input AND awaiting-approval.

We use these natively. Custom `_bodhi-pi/mode/*` and `_bodhi-pi/permission/*` extension methods are NOT introduced. Persistent `alwaysAllow`/`alwaysDeny` rules ride existing `_bodhi-pi/session/settings/*` with `permission.alwaysAllow` / `permission.alwaysDeny` keys (no new wire surface).

The "stable ACP over `unstable_*`" pillar of bodhi-pi favours ACP-native any time it exists, AND the live methods over the deprecated ones.

### 2. Agent owns policy; Host renders UI; Client triggers responses

Per the agent–host–client split documented in [`ai-docs/specs/bodhi-pi/architecture.md`](../../../specs/bodhi-pi/architecture.md), AND bodhi-pi's "agent owns filesystem" decision (different from Zed/Goose; same as cc/Codex/pi-acp — see [notes/12-acp-spec.md](../notes/12-acp-spec.md)):

| Concern | Who |
|---|---|
| Mode enum + presets + policy evaluation | **Agent** — new `src/permissions/PermissionService` core service |
| Mode state (`SessionState.runtime.mode`) | **Agent** — lives in-memory; persisted as a `mode_change` SessionEntry for replay |
| `session/setSessionConfigOption` (with `configId: "mode"`) handler | **Agent** — uses the EXISTING `setSessionConfigOption` dispatch in `src/models/registry.ts:217-236`. New entry calls `PermissionService.setMode`. No new ACP method on `BodhiPiAcpAgent`. |
| `session/request_permission` invocation | **Agent** — `PermissionService` calls `conn.requestPermission(...)` and awaits |
| Approval UI rendering (`requestPermission` consumer) | **Host's Client side** — CLI prompt / browser inline card / chrome-ext popup / HTTP modal via SSE bridge |
| Default-mode bootstrap from `BodhiPiConfig.defaultMode` + `defaultMode` settings key | **Agent** — read at `buildSessionState` time |
| `allowsAllowAllMode` capability gate | **Host** — declared via `BodhiPiConfig`; **Agent** enforces |
| Persistent `alwaysAllow`/`alwaysDeny` rules | **Agent** — uses existing `SettingsService` + `permission.*` keys (no new wire methods) |

The agent hooks into the existing `tool_call` event mechanism (the `beforeToolCall` hook bodhi-pi already wires through `EventDispatcher` in `src/sessions/session-bootstrap.ts:169-180`). The PermissionService registers an internal handler that consults policy and either returns `undefined` (allow), `{ block: true, reason }` (deny), or `await`s on `conn.requestPermission(...)` and resolves to one of the above based on the user's `PermissionOptionKind` reply. Because `beforeToolCall` is async and pi-agent-core awaits it, this naturally suspends tool execution without bespoke pause/resume machinery.

### 3. Tool categories track existing `toolKindFor` axes

`src/tools/index.ts::toolKindFor(name)` already classifies as `"read" | "edit" | "search" | "execute" | "other"`. We expand to add `"mcp"` and `"subagent"` and use this as the canonical `ToolCategory`. Per-category default decision; per-tool override; per-pattern persistent rule.

### 4. Decision resolution priority (fixed)

```
alwaysDeny  >  alwaysAllow  >  sessionGrant  >  toolOverride  >  categoryDefault  >  modePreset
```

(Mirrors mastracode's `resolveApproval` from the research report.)

### 5. ACP-native `PermissionOptionKind` mapping

| ACP `PermissionOptionKind` | Bodhi-pi meaning | OptionId convention |
|---|---|---|
| `allow_once` | Run this call; do not persist | `allow_once` |
| `allow_always` | Add a `<toolName>` pattern to `alwaysAllow` at the chosen scope | **Three entries**: `allow_always_session`, `allow_always_project`, `allow_always_global` (per codex-acp's pattern — see [notes/15-codex-acp.md](../notes/15-codex-acp.md)). User picks scope by clicking the right button. No secondary modal. |
| `reject_once` | Block this call with `reason: "user rejected"` | `reject_once` |
| `reject_always` | Add a `<toolName>` pattern to `alwaysDeny`; defaults to session scope only | `reject_always` (one entry; scope picker for deny is less compelling) |

So the typical `ask` mode flow shows **6 options**: allow_once, allow_always_session, allow_always_project, allow_always_global, reject_once, reject_always.

`plan` mode exit (`submit_plan` tool) uses a different option set with `optionId`s that encode the target mode (per spec example + claude-agent-acp pattern):

| optionId | name | kind | semantic |
|---|---|---|---|
| `edit` | "Approve and switch to edit mode" | `allow_always` | switch session to `edit`, return success |
| `edit_notes` | "Approve with notes" | `allow_once` | stay in plan, replay with notes |
| `revise` | "Revise" | `reject_once` | stay in plan, return error |

### 6. Default mode: `ask` (safer)

New sessions default to `ask` mode. Read and search auto-allow; everything else (edit, execute, mcp, subagent) prompts. A user who wants the current main-branch behaviour (edits auto-run) can either (a) set `defaultMode: "edit"` in `~/.bodhi-pi/settings.json` or `<cwd>/.bodhi-pi/settings.json`, or (b) call `setSessionMode("edit")` once per session, or (c) set `BodhiPiConfig.defaultMode: "edit"` at factory time.

### 7. `submit_plan` is a built-in tool registered only when mode = plan

`createBuiltinTools(...)` adds `submit_plan` to the tool list iff `session.runtime.mode === "plan"`. The tool emits a structured plan-approval event via ACP-native `session/request_permission` (3 options: `accept_to_edit` → switch to `edit`, `accept_to_allow_all` → switch to `allow-all`, `reject` → stay in `plan`), awaits the user reply, and on approval auto-transitions the session mode + lets the LLM continue with execution in the new mode. Ships in milestone 060. Phase 030 lands plan-mode enforcement WITHOUT this tool — exit is via `/mode edit` slash for now.

### 7b. Plan-mode rejections use the Codex `amendment` pattern, not pure prompt steering

Per the modes-research harness audit (cf. `report.md` and the per-harness notes on cc / opencode / codex / cline-roo): when a tool is denied by policy, the LLM gets a normal `AgentToolResult` with `isError: true` and **redirect text** ("plan mode is read-only — `write` blocked. Use `read` to inspect or `/mode edit` to proceed."). This outperforms cc's pure prompt-steering — the model gets a structured reason it can adapt to in the same turn. A parallel `custom_message` entry surfaces the block in the chat transcript so the user understands what happened. The LLM's tool list stays unchanged (active-tools-swap is deferred to milestone 090).

### 8. Approval timeout: 30 seconds, configurable

`PermissionService` awaits each `requestPermission` with a default 30s timeout. On timeout the pending approval auto-rejects with `reason: "timeout"`. Configurable per session via `_bodhi-pi/session/settings/set permission.approvalTimeoutMs <ms>` (or `permission.approvalTimeoutMs` in `settings.json`). `session/cancel` also resolves all pending approvals as rejected.

### 9. `allow-all` requires Host capability AND (for project-default) a second flag

```ts
interface BodhiPiConfig {
  // ... existing fields ...
  /** When false (default), session/setSessionMode { modeId: "allow-all" } rejects with -32603. */
  allowsAllowAllMode?: boolean;
  /** When false (default), settings.json defaultMode: "allow-all" is rejected at boot. */
  allowsAllowAllModeAsDefault?: boolean;
}
```

`test-apps/cli`: sets `allowsAllowAllMode: true`, `allowsAllowAllModeAsDefault: false`.
`test-apps/http`, `test-apps/browser`, `test-apps/chrome-ext`: both default `false`.

### 10. Sub-agent inheritance: Qwen Code rule

```ts
function resolveChildMode(parent, profile, capabilities) {
  if (parent === "allow-all" || parent === "edit") return parent;
  if (profile.mode) {
    if (profile.mode === "allow-all" && !capabilities.allowsAllowAllMode) return parent;
    return profile.mode;
  }
  if (parent === "plan") return "plan";
  return parent;
}
```

Built-in `explore` + `planner` profiles get `mode: "plan"` so they're always read-only regardless of parent.

### 11. What we explicitly do NOT ship in this plan

- **Custom modes (markdown discovery)** — Roo Code-style user-defined modes. Defer to a separate plan; the 4 hardcoded modes are sufficient initial coverage.
- **LLM-self-annotated `security_risk` field** (OpenHands pattern). Speculative; needs model-coverage testing first.
- **MCP per-tool annotation classification** is **shipped in milestone 030** (not deferred): plan-mode reads `tool.annotations.readOnlyHint` / `destructiveHint` from the MCP SDK spec v2025-03-26 and gates accordingly. Research-permissive default — unknown/unannotated MCPs are allowed in plan mode per user requirement that "read mcps stay critical during research".
- **`argFingerprint` patterns** (`bash:npm test`, `edit:*.md`). Useful but adds per-tool fingerprint plumbing; ship coarse `<toolName>` patterns first.
- **LLM-callable `switch_mode` tool** (Roo Code style). Self-elevation risk; mode change stays user-initiated.

## Milestone sequence

| # | Title | Status | Brief |
|---|---|---|---|
| **[005](005-acp-architecture-decision.md)** | **ACP architecture decision (READ FIRST)** | (decision doc) | **Locks the ACP-native wire-surface choices. Supersedes wire-method drafts in 010/020/030+. Not an implementation milestone — a binding decision doc.** |
| [010](010-ground-preparation.md) | Ground preparation | ☑ shipped (`c93fc25a`) | Tool categories expansion, `AgentMode` + `PermissionPolicy` types, `MODE_CONFIG_ID` constant, settings schema additions, in-process event-type declarations. **No behaviour change.** |
| [020](020-mode-state-and-set-config-option.md) | Mode state + extend `setSessionConfigOption` | ☑ shipped (`c93fc25a`) | `SessionState.runtime.mode`, `PermissionService` skeleton, dispatch refactor (lifted `setSessionConfigOption` from `ModelRegistry` to `BodhiPiAcpAgent`), `buildModeConfigOption`, `ConfigOptionUpdate` notifications, default-mode bootstrap, 4-runtime `/mode` + `/modes` + badge. |
| [030](030-plan-mode-plumbing.md) | **Plan-mode plumbing (NEXT)** | ☐ in design | Plan-mode preset becomes real; `evaluateToolCall` consults policy + MCP annotation hints; tool-call gating in `beforeToolCall`; plan system-prompt suffix; block-as-tool-result + `custom_message` entry (Codex amendment pattern, no UI changes). Ask/edit modes remain allow-all (request_permission deferred to 040). **First phase where plan mode actually rejects edits.** |
| [040](040-ask-mode-and-approval-flow.md) | `ask` mode + native ACP `request_permission` flow | ☐ | PermissionService policy engine for ask + `conn.requestPermission(...)` invocation + scope-encoded-in-`optionId` (6-option `ask`-mode prompt) + 4-runtime UI parity (Zed-style inline cards for browser/chrome-ext) + 30s timeout. **Biggest milestone.** |
| [050](050-edit-mode-preset.md) | `edit` mode preset | ☐ | Add `edit` preset, mark write/edit tools with `respectsEditMode: true`, parity tests. |
| [060](060-plan-mode-and-submit-plan-tool.md) | `plan`-mode `submit_plan` tool + 3-option approval UI | ☐ | Built-in `submit_plan` tool (registered only when mode=plan), 3-option `request_permission` exit (accept→edit / accept→allow-all / reject), mode auto-transition on approval, plan persistence as `custom_message`. **Plan mode goes from inert-rejection to interactive-graduation.** |
| [070](070-allow-all-and-safety-gate.md) | `allow-all` + capability + safety-immune deny | ☐ | Add `allow-all` preset, `allowsAllowAllMode` capability gate (already partially live since 020), hardcoded safety-immune deny list (`.git/**` writes, `.bodhi-pi/**` writes, `.env*` reads, `~/.ssh/**` reads). |
| [080](080-subagent-mode-inheritance.md) | Sub-agent mode inheritance | ☐ | `SubagentProfile.mode?` field, Qwen-rule `resolveChildMode`, built-in `explore`/`planner` profiles get `mode: "plan"`, approval requests bubble to parent. |
| [090](090-active-tools-swap.md) | Active-tools swap on mode change | ☐ | `ExtensionAPI.setActiveTools(sessionId, names)` + `getActiveTools(sessionId)`. Mode change auto-rebuilds the tool list so the LLM never sees denied tools. |
| [100](100-persistent-permission-rules.md) | Persistent always-allow / always-deny | ☐ | `alwaysAllow` + `alwaysDeny` patterns at session / project / global scope. `allow_always` reply persists at the user-chosen scope. |

## Cross-cutting conventions

### Spec updates per milestone

Each milestone explicitly enumerates which spec docs (`ai-docs/specs/bodhi-pi/*.md`) it must update, per the CLAUDE.md "Specs are living docs" pillar:

- **`acp.md`** — every milestone that adds/touches an ACP method or extension method updates the table + sequence diagrams.
- **`lifecycle.md`** — every milestone that adds a `SessionEntry` variant updates the SessionEntry union table.
- **`architecture.md`** — milestones that add a core service update the services table.
- **`extensions-skills-commands.md`** — milestone 080 (`setActiveTools`) updates the ExtensionAPI table.
- **`configuration.md`** — milestones touching `BodhiPiConfig` fields or settings keys update the field tables.
- **`index.md`** — milestone 010 adds a new `modes.md` spec and a "Read this if…" pointer; subsequent milestones update `modes.md`.
- **NEW `ai-docs/specs/bodhi-pi/modes.md`** — created in milestone 010 as the canonical mode + permission reference; every later milestone extends it.

### Test layout per milestone

Each milestone follows the **7-step TDD feature workflow** from `packages/bodhi-pi/CLAUDE.md`:

1. `packages/bodhi-pi/test/<feature>.test.ts` — failing integration test using `createTestHarness` + faux provider; make it pass in `src/`.
2. `packages/bodhi-pi/e2e/<feature>.e2e.ts` — gpt-4o-mini round-trip (only when LLM interaction is part of the feature; mode-change-only milestones may skip).
3. `packages/bodhi-pi/test-apps/node-adapters/` — only when a Node-side adapter is needed.
4. `packages/bodhi-pi/test-apps/browser/src/host/` — same for browser-side.
5. `packages/bodhi-pi/test-apps/cli/e2e/<feature>.e2e.ts` — CLI Host e2e.
6. `packages/bodhi-pi/test-apps/browser/e2e/<feature>.spec.ts` + `chrome-ext/e2e/<feature>.spec.ts` — Playwright.
7. `packages/bodhi-pi/test-apps/http/test/integration/<feature>.test.ts` — server-side per-turn-rebuild integration.

Milestones that **don't** touch a runtime adapter shape can skip steps 3-4 but **never** skip 1, 5, 6, 7.

### Gate-check per commit

A commit lands only when ALL of these pass on its own (per CLAUDE.md trunk-based-dev contract):

```
npm run check         # biome + tsgo across all packages + host/client seam + browser smoke
npm test              # vitest in src/ + test-apps/
just test-e2e         # if the commit touches the matrix
just test-e2e-ui      # if the commit touches the matrix
```

If a milestone is split into multiple commits, each intermediate commit must individually pass. Bisecting `main` is the safety net.

### Commit message convention

Per recent main-branch history:

```
bodhi-pi modes <milestone-id>: <one-sentence subject>

<2-3 sentence body describing the change and why>

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

Examples:
- `bodhi-pi modes 010: tool-category expansion + permission types`
- `bodhi-pi modes 030: ask mode + ACP requestPermission round-trip across 4 runtimes`

### Atomic commit per the user's repo preferences

Each commit goes through the chained `git reset . && git add <specific paths> && git commit -m ...` pattern (per [`feedback_atomic_commit_with_reset`](../../../../memory/feedback_atomic_commit_with_reset.md)) to avoid mixing with concurrent work.

### Forbidden patterns (per repo memory)

- **No comments in source code** unless the WHY is non-obvious (`feedback_no_low_value_comments`). The 7-line block of `// step 1:`, `// step 2:` is wrong.
- **No `node:*` imports** in `src/` (per CLAUDE.md "Source code rules"). Use `src/_internal/uuid.ts`, `pathe`, `src/_internal/utf8.ts` as runtime-neutral replacements.
- **No coding-agent comparisons** — bodhi-pi has outgrown it (`feedback_no_more_coding_agent_compare`).
- **No fallbacks** at factory time for required fields.

## How AI assistants should consume this folder

1. Read `000-overview.md` first (this file) to understand the design.
2. Pick the lowest-numbered milestone whose status is "ready" (or open).
3. Read the milestone end-to-end before starting.
4. Open the named spec docs to confirm current state matches the milestone's "Current state" section. If divergent, escalate to user before proceeding.
5. Follow the 7-step TDD sequence in the milestone's "Implementation order" section.
6. After all tests pass and `npm run check` is clean, commit per the message convention.
7. Update this overview's milestone table to mark the milestone done.
8. Move to the next milestone.

A single AI session typically should target one milestone. Multi-milestone work in one session is allowed only when the milestones explicitly say "can land together" (none do in this initial set).
