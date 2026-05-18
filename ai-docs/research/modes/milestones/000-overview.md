# Bodhi-Pi modes — milestone overview

**Owner role:** AI coding assistant
**Source-of-truth research:** [`../report.md`](../report.md)
**Companion research:** [`../../sub-agents/`](../../sub-agents/)
**Target spec dir:** [`ai-docs/specs/bodhi-pi/`](../../../specs/bodhi-pi/)

This folder is a **sequential implementation plan** for adding agent operating modes and permission policies to `packages/bodhi-pi`. Each milestone (`010-…`, `020-…`, …) is a self-contained brief sized to land as a single commit (or a tight commit sequence) on `main`, fully green against `npm run check`, `npm test`, `just test-e2e`, and `just test-e2e-ui`. The numbering uses 10-unit gaps so additional milestones can be inserted between (e.g. `035-`) without renaming.

The milestones are **depth-first**: each milestone delivers a slice end-to-end across all four reference Hosts (`test-apps/{cli,http,browser,chrome-ext}`) before the next milestone begins. The first three milestones (010/020/030) are the heaviest because they introduce the entire enforcement skeleton; milestones 040-090 layer additional mode presets and refinements on the same skeleton.

## What we're shipping

A four-mode user-facing enum (`ask`, `plan`, `edit`, `allow-all`) backed by a per-category `PermissionPolicy` with per-tool overrides. Approvals ride the **native ACP `session/requestPermission` round-trip**. Mode changes ride the **native ACP `session/setSessionMode` method** and surface to clients via `CurrentModeUpdate` session notifications. Default mode for new sessions is `ask`. `allow-all` is gated by a per-Host `allowsAllowAllMode` capability (`false` for browser + chrome-ext by default). Sub-agent profiles can declare their own mode and the parent's mode floors the child's (Qwen Code rule).

## Key architectural decisions (locked)

### 1. Ride on ACP-native methods, not custom `_bodhi-pi/*` wire

The ACP SDK already declares:
- `session/setSessionMode` (`SetSessionModeRequest { sessionId, modeId }`)
- `session/requestPermission` (Agent → Client, with `PermissionOptionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always"`)
- `SessionMode { id, name, description? }` and `SessionModeState { availableModes, currentModeId }`
- `CurrentModeUpdate` session notification variant
- `ToolCallStatus = "pending" | "in_progress" | "completed" | "failed"` — `pending` is the right status for a tool call awaiting approval

We use these natively. Custom `_bodhi-pi/mode/*` and `_bodhi-pi/permission/*` extension methods are NOT introduced. The "stable ACP over `unstable_*`" pillar of bodhi-pi favours ACP-native any time it exists.

### 2. Agent owns policy; Host renders UI; Client triggers responses

Per the agent–host–client split documented in [`ai-docs/specs/bodhi-pi/architecture.md`](../../../specs/bodhi-pi/architecture.md):

| Concern | Who |
|---|---|
| Mode enum + presets + policy evaluation | **Agent** — new `src/permissions/PermissionService` core service |
| Mode state (`SessionState.runtime.mode`) | **Agent** — lives in-memory; persisted as a `mode_change` SessionEntry for replay |
| `session/setSessionMode` handler | **Agent** — validates modeId, mutates state, appends entry, emits `mode_change` + `CurrentModeUpdate` |
| `session/requestPermission` invocation | **Agent** — `PermissionService` calls `conn.requestPermission(...)` and awaits |
| Approval UI rendering (`requestPermission` consumer) | **Host's Client side** — CLI prompt / HTTP modal / browser dialog / chrome-ext popup |
| Default-mode bootstrap from `BodhiPiConfig.defaultMode` + `defaultMode` settings key | **Agent** — read at `buildSessionState` time |
| `allowsAllowAllMode` capability gate | **Host** — declared via `BodhiPiConfig`; **Agent** enforces |

The agent hooks into the existing `tool_call` event mechanism (the `beforeToolCall` hook bodhi-pi already wires through `EventDispatcher` in `src/sessions/session-bootstrap.ts:169-180`). The PermissionService registers an internal handler that consults policy and either returns `undefined` (allow), `{ block: true, reason }` (deny), or `await`s on `conn.requestPermission(...)` and resolves to one of the above based on the user's `PermissionOptionKind` reply. Because `beforeToolCall` is async and pi-agent-core awaits it, this naturally suspends tool execution without bespoke pause/resume machinery.

### 3. Tool categories track existing `toolKindFor` axes

`src/tools/index.ts::toolKindFor(name)` already classifies as `"read" | "edit" | "search" | "execute" | "other"`. We expand to add `"mcp"` and `"subagent"` and use this as the canonical `ToolCategory`. Per-category default decision; per-tool override; per-pattern persistent rule.

### 4. Decision resolution priority (fixed)

```
alwaysDeny  >  alwaysAllow  >  sessionGrant  >  toolOverride  >  categoryDefault  >  modePreset
```

(Mirrors mastracode's `resolveApproval` from the research report.)

### 5. ACP-native `PermissionOptionKind` mapping

| ACP `PermissionOptionKind` | Bodhi-pi meaning |
|---|---|
| `allow_once` | Run this call; do not persist |
| `allow_always` | Add a `<toolName>` pattern to `alwaysAllow`; persist at the scope the host's UI chose (default: session) |
| `reject_once` | Block this call with `reason: "user rejected"` |
| `reject_always` | Add a `<toolName>` pattern to `alwaysDeny`; persist at scope (default: session) |

The agent presents `RequestPermission.options` with the appropriate kinds based on what the mode allows. For most cases all four are offered; a host's UI can choose to elide the `_always` variants when the mode is `ask` (e.g. allow_always would defeat the point) — but the agent does not enforce this elision; it presents and lets the host filter.

### 6. Default mode: `ask` (safer)

New sessions default to `ask` mode. Read and search auto-allow; everything else (edit, execute, mcp, subagent) prompts. A user who wants the current main-branch behaviour (edits auto-run) can either (a) set `defaultMode: "edit"` in `~/.bodhi-pi/settings.json` or `<cwd>/.bodhi-pi/settings.json`, or (b) call `setSessionMode("edit")` once per session, or (c) set `BodhiPiConfig.defaultMode: "edit"` at factory time.

### 7. `submit_plan` is a built-in tool registered only when mode = plan

`createBuiltinTools(...)` adds `submit_plan` to the tool list iff `session.runtime.mode === "plan"`. The tool emits a structured plan-approval event over the wire, awaits a user response (approve / request-changes / deny), and on approve auto-transitions the session to `edit` mode. This keeps the plan-mode-exit affordance native — no extension required.

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
- **MCP per-server permission overrides** — depends on whether MCP spec exposes a read-vs-mutate annotation we can map onto. Tracked as a follow-up; v1 treats all MCP tools as the `mcp` category and ask-by-default.
- **`argFingerprint` patterns** (`bash:npm test`, `edit:*.md`). Useful but adds per-tool fingerprint plumbing; ship coarse `<toolName>` patterns first.
- **LLM-callable `switch_mode` tool** (Roo Code style). Self-elevation risk; mode change stays user-initiated.

## Milestone sequence

| # | Title | Brief |
|---|---|---|
| [010](010-ground-preparation.md) | Ground preparation | Tool categories expansion, `AgentMode` + `PermissionPolicy` types, settings schema additions, lifecycle event declarations. **No behaviour change.** |
| [020](020-mode-state-and-set-session-mode.md) | Mode state + ACP `setSessionMode` | `SessionState.runtime.mode`, `PermissionService` skeleton (allow-all default for this milestone), native `setSessionMode` handler, `CurrentModeUpdate` emission, `availableModes` advertised, default-mode bootstrap. |
| [030](030-ask-mode-and-approval-flow.md) | `ask` mode + native ACP `requestPermission` flow | PermissionService policy engine + `ask` preset + `conn.requestPermission(...)` integration + 4-runtime UI parity + 30s timeout. **Biggest milestone.** |
| [040](040-edit-mode-preset.md) | `edit` mode preset | Add `edit` preset, mark write/edit tools with `respectsEditMode: true`, parity tests. |
| [050](050-plan-mode-and-submit-plan-tool.md) | `plan` mode + `submit_plan` tool | Add `plan` preset, planner system-prompt suffix, built-in `submit_plan` tool (registered only when mode=plan), mode auto-transition on approval. |
| [060](060-allow-all-and-safety-gate.md) | `allow-all` + capability + safety-immune deny | Add `allow-all` preset, `allowsAllowAllMode` capability gate, hardcoded safety-immune deny list (`.git/**` writes, `.bodhi-pi/**` writes, `.env*` reads, `~/.ssh/**` reads). |
| [070](070-subagent-mode-inheritance.md) | Sub-agent mode inheritance | `SubagentProfile.mode?` field, Qwen-rule `resolveChildMode`, built-in `explore`/`planner` profiles get `mode: "plan"`, approval requests bubble to parent. |
| [080](080-active-tools-swap.md) | Active-tools swap on mode change | `ExtensionAPI.setActiveTools(sessionId, names)` + `getActiveTools(sessionId)`. Mode change auto-rebuilds the tool list so the LLM never sees denied tools. |
| [090](090-persistent-permission-rules.md) | Persistent always-allow / always-deny | `alwaysAllow` + `alwaysDeny` patterns at session / project / global scope. `allow_always` reply persists at the user-chosen scope. |

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
