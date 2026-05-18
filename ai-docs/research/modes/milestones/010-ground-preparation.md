# Milestone 010 — Ground preparation

> **Read [000-overview.md](000-overview.md) first.** This milestone lays types and small expansion changes with **no behaviour change**. It exists so the next milestone (020) can import a stable type surface without bundling unrelated changes.

## Goal

Introduce the type vocabulary and small data-shape additions required by every subsequent milestone:

- Expand `toolKindFor` to add `"mcp"` and `"subagent"` categories
- Introduce `src/permissions/` module with `AgentMode`, `PermissionDecision`, `PermissionPolicy`, `ApprovalDecision`, `ToolCategory` types + mode-preset registry shape (presets themselves come in 030-060)
- Add `defaultMode?: AgentMode` to `BodhiPiProjectSettings` schema (read but not yet acted on)
- Add `allowsAllowAllMode?: boolean` and `allowsAllowAllModeAsDefault?: boolean` and `defaultMode?: AgentMode` to `BodhiPiConfig`
- Add `mode_change` / `tool_approval_request` / `tool_approval_response` lifecycle event type declarations to `src/events/types.ts` (no service emits them yet)
- Create `ai-docs/specs/bodhi-pi/modes.md` (new spec doc) with the locked design from [000-overview.md](000-overview.md)
- Update `ai-docs/specs/bodhi-pi/index.md` "Read this if…" table to point at the new modes doc

**No PermissionService is added in this milestone.** No mode state on `SessionState`. No wire methods implemented. No tool behaviour change. The only runtime-visible change is that `toolKindFor("use_mcp_tool")` would now return `"mcp"` (but no callers depend on this yet).

## Prerequisites

None. This is the first milestone.

## Architecture decisions for this milestone

- **`ToolCategory` lives in `src/permissions/types.ts`**, not `src/tools/index.ts`. The categorization is now a permissions concern. `src/tools/index.ts::toolKindFor` becomes a thin re-export.
- **`src/permissions/` is a domain folder owning both data types AND its service** (per [`feedback_bodhi_pi_src_layout`](../../../../memory/feedback_bodhi_pi_src_layout.md)). The service lands in 020; the types land here.
- **Lifecycle event types are added in 010 but no emitter is wired**. Adding them now keeps 020's diff focused on emission rather than type-and-emit.

## Scope

### IN

| Change | File |
|---|---|
| New `src/permissions/types.ts` | New file |
| Expand `toolKindFor` to `"mcp"` and `"subagent"`; add `EDIT_TOOL_NAMES` const | `src/tools/index.ts` |
| Add `defaultMode?: AgentMode` to `BodhiPiProjectSettings` | `src/settings/settings.ts` |
| Add `allowsAllowAllMode?`, `allowsAllowAllModeAsDefault?`, `defaultMode?` to `BodhiPiConfig` | `src/acp/agent.ts` (interface only) |
| Add `mode_change`, `tool_approval_request`, `tool_approval_response` to `BodhiPiEvent` union | `src/events/types.ts` |
| Re-export new types from `src/index.ts` | `src/index.ts` |
| Create `ai-docs/specs/bodhi-pi/modes.md` | New file |
| Update `ai-docs/specs/bodhi-pi/index.md` Read-this-if table | Edit |
| Update `ai-docs/specs/bodhi-pi/configuration.md` BodhiPiConfig + BodhiPiProjectSettings tables (new fields) | Edit |
| Update `ai-docs/specs/bodhi-pi/extensions-skills-commands.md` to reference the new `modes.md` spec | Edit (small) |
| Tests covering the type-level changes (compile-only) and `toolKindFor` expansion | New test file |

### OUT

- PermissionService class (milestone 020)
- `setSessionMode` handler (milestone 020)
- Mode-state on `SessionState` (milestone 020)
- Any preset (`ask`, `edit`, `plan`, `allow-all`) — types in 010, presets in 030/040/050/060
- Wire emission of new lifecycle events
- Settings validation that rejects unknown `defaultMode` values — light validation only (parse + accept the four known names + warn on unknown via logger); strict-validation lives in the bootstrap layer in milestone 020
- All tool category re-classification beyond adding `mcp` + `subagent` (Plannotator-style edit-tool-name list stays in `src/tools/index.ts` for now)

## Implementation

### Step 1 — `src/permissions/types.ts` (new file)

```ts
// src/permissions/types.ts
// No comments in the actual file — they're here as design intent only.

/** Four user-facing modes. Ordered most-restrictive → most-permissive. */
export type AgentMode = "ask" | "plan" | "edit" | "allow-all";

export const ALL_AGENT_MODES = ["ask", "plan", "edit", "allow-all"] as const;

export const MODES_BY_PERMISSIVENESS = ["plan", "ask", "edit", "allow-all"] as const;

export type PermissionDecision = "allow" | "ask" | "deny";

/** Tracks the bodhi-pi `toolKindFor` axes + mcp + subagent contributions. */
export type ToolCategory = "read" | "edit" | "search" | "execute" | "mcp" | "subagent" | "other";

export const ALL_TOOL_CATEGORIES: readonly ToolCategory[] = [
  "read",
  "edit",
  "search",
  "execute",
  "mcp",
  "subagent",
  "other",
];

/**
 * Policy fingerprint applied to a tool call. Patterns are simple `<toolName>` strings
 * in v1. Future milestones (out of scope here) extend with `<toolName>:<argFingerprint>`.
 */
export type PermissionPattern = string;

export interface PermissionPolicy {
  /** Per-category decision; the mode preset populates this. */
  categories: Partial<Record<ToolCategory, PermissionDecision>>;
  /** Per-tool override; takes priority over the category. Key = tool name. */
  tools: Record<string, PermissionDecision>;
  /** Persistent allow patterns; populated by milestone 090. */
  alwaysAllow: PermissionPattern[];
  /** Persistent deny patterns; populated by milestone 090. */
  alwaysDeny: PermissionPattern[];
}

export interface ModePreset {
  mode: AgentMode;
  description: string;
  policy: PermissionPolicy;
  systemPromptSuffix?: string;
}

/**
 * Outcome the PermissionService returns for each tool call. The pi-agent-core
 * `beforeToolCall` hook converts `block` → tool-call block; `allow` → no-op (proceed).
 */
export type ApprovalDecision =
  | { kind: "allow" }
  | { kind: "deny"; reason: string };

/**
 * The host-injected capability set for the mode subsystem. Populated by
 * `createBodhiPiAgent` from `BodhiPiConfig.allowsAllowAllMode` /
 * `allowsAllowAllModeAsDefault`. Read by:
 *   - PermissionService (rejects setSessionMode("allow-all") if `allowsAllowAllMode === false`)
 *   - Bootstrap (rejects `defaultMode: "allow-all"` from settings if `allowsAllowAllModeAsDefault === false`)
 *   - resolveChildMode (sub-agent inheritance — milestone 070)
 */
export interface ModeRuntimeCapabilities {
  allowsAllowAllMode: boolean;
  allowsAllowAllModeAsDefault: boolean;
}
```

### Step 2 — Expand `src/tools/index.ts`

The existing `toolKindFor` returns `"read" | "edit" | "search" | "execute" | "other"`. Expand to include `"mcp"` and `"subagent"` and re-type to use the new `ToolCategory`:

```ts
// src/tools/index.ts (existing file — replace toolKindFor)
import type { ToolCategory } from "@/permissions/types.js";

export const EDIT_TOOL_NAMES = new Set(["write", "edit"]);

export function toolKindFor(name: string): ToolCategory {
  if (EDIT_TOOL_NAMES.has(name)) return "edit";
  switch (name) {
    case "read":
      return "read";
    case "ls":
    case "find":
    case "grep":
      return "search";
    case "run_script":
    case "bash":
      return "execute";
    case "subagent":
    case "subagent_batch":
      return "subagent";
    default:
      // MCP tools follow the `<slug>__<tool>` namespacing convention.
      // Anything matching that pattern is the `mcp` category.
      if (name.includes("__")) return "mcp";
      return "other";
  }
}
```

> **Compatibility check**: `subscribeToAgent` in `src/acp/prompt-loop.ts:178` calls `toolKindFor(event.toolName)` and assigns the result to the ACP `tool_call.kind` field. ACP's `ToolKind` enum only has `"read" | "edit" | "search" | "execute" | "other"` — but ACP's full enum (per `node_modules/@agentclientprotocol/sdk/dist/schema/types.gen.d.ts`) actually includes more values. **Verify** before this milestone lands that `"mcp"` and `"subagent"` are valid `ToolKind` values; if not, the ACP wire side maps `"mcp"` → `"execute"` and `"subagent"` → `"other"` via a separate `toAcpToolKind(category)` shim in `src/wire/converters.ts`. Update `wire/converters.ts` if needed.

### Step 3 — `src/settings/settings.ts`

Add `defaultMode?: AgentMode` field:

```ts
// src/settings/settings.ts (existing file — add field)
import type { AgentMode } from "@/permissions/types.js";

export interface BodhiPiProjectSettings {
  // ... existing fields ...
  defaultMode?: AgentMode;
}
```

No validator changes here. Bootstrap in milestone 020 will reject unknown values.

### Step 4 — `src/acp/agent.ts` BodhiPiConfig interface

Add three optional fields to `BodhiPiConfig`:

```ts
// src/acp/agent.ts (existing interface — add fields)
export interface BodhiPiConfig {
  // ... existing fields ...

  /** Initial mode for new sessions when no settings.json `defaultMode` is present. */
  defaultMode?: AgentMode;

  /**
   * When `false` (default), `session/setSessionMode { modeId: "allow-all" }` rejects
   * with -32603. CLI hosts opt in via `allowsAllowAllMode: true`. Browser /
   * chrome-ext / multi-tenant HTTP hosts leave this `false`.
   */
  allowsAllowAllMode?: boolean;

  /**
   * When `false` (default), `defaultMode: "allow-all"` from any settings layer
   * (global / project / session-override) is rejected at session boot. Two-step
   * safety — even if a host opts into `allowsAllowAllMode: true`, persisted defaults
   * still require explicit additional opt-in.
   */
  allowsAllowAllModeAsDefault?: boolean;
}
```

Do NOT consume these fields in this milestone. Milestone 020 reads them.

### Step 5 — `src/events/types.ts`

Add three event types and the union extension:

```ts
// src/events/types.ts (existing file — add events at the end of the discriminated union block)

export interface ModeChangeEvent {
  type: "mode_change";
  sessionId: string;
  fromMode: AgentMode | null;
  toMode: AgentMode;
  reason: "user" | "session_load" | "submit_plan_approved" | "settings_change" | "subagent_spawn";
}

export interface ToolApprovalRequestEvent {
  type: "tool_approval_request";
  sessionId: string;
  toolCallId: string;
  toolName: string;
  category: ToolCategory;
  /** Stable string used by the policy engine to find always-allow/deny matches. */
  pattern: PermissionPattern;
  /** 30s default; configurable via permission.approvalTimeoutMs settings key. */
  timeoutMs: number;
}

export interface ToolApprovalResponseEvent {
  type: "tool_approval_response";
  sessionId: string;
  toolCallId: string;
  /** Mirrors ACP's PermissionOptionKind. */
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" | "cancelled" | "timeout";
}

export type BodhiPiEvent =
  | // ... existing variants ...
  | ModeChangeEvent
  | ToolApprovalRequestEvent
  | ToolApprovalResponseEvent;

// Add to BodhiPiEventHandlers interface:
export interface BodhiPiEventHandlers {
  // ... existing fields ...
  mode_change?: ((event: ModeChangeEvent) => Awaitable<void>)[];
  tool_approval_request?: ((event: ToolApprovalRequestEvent) => Awaitable<void>)[];
  tool_approval_response?: ((event: ToolApprovalResponseEvent) => Awaitable<void>)[];
}
```

`EventDispatcher` in `src/events/dispatcher.ts` likely has a generic `emit` that doesn't need editing if it's keyed off the discriminated union (verify). The handlers map is the only place that needs type entries.

### Step 6 — `src/index.ts` re-exports

```ts
// src/index.ts (existing barrel — add)
export {
  ALL_AGENT_MODES,
  ALL_TOOL_CATEGORIES,
  MODES_BY_PERMISSIVENESS,
  type AgentMode,
  type ApprovalDecision,
  type ModePreset,
  type ModeRuntimeCapabilities,
  type PermissionDecision,
  type PermissionPattern,
  type PermissionPolicy,
  type ToolCategory,
} from "@/permissions/types.js";
```

### Step 7 — `ai-docs/specs/bodhi-pi/modes.md` (new spec)

Create a new spec doc that becomes the canonical reference. The initial content is essentially [000-overview.md](000-overview.md) §"Key architectural decisions" + a "Current state" table that will be updated each milestone. Layout:

```
# Modes and permissions

(intro paragraph matching report.md exec summary)

## Mode taxonomy
(table: ask / plan / edit / allow-all → category defaults)

## Architecture
(text mirroring 000-overview.md §"Agent owns policy; Host renders UI")

## ACP-native surfaces
(text on session/setSessionMode, session/requestPermission, CurrentModeUpdate, SessionModeState)

## Implementation status
(table — one row per milestone; checkbox column "shipped")
| Milestone | Shipped? | Notes |
|---|---|---|
| 010 — Ground preparation | ☐ | Types only |
| 020 — Mode state + setSessionMode | ☐ | |
| 030 — ask mode + requestPermission | ☐ | |
| 040 — edit preset | ☐ | |
| 050 — plan preset + submit_plan | ☐ | |
| 060 — allow-all + safety gate | ☐ | |
| 070 — Sub-agent inheritance | ☐ | |
| 080 — setActiveTools | ☐ | |
| 090 — Persistent rules | ☐ | |

## See also
(links to report.md, configuration.md, lifecycle.md)
```

Each subsequent milestone flips its checkbox and extends the relevant sections of this doc.

### Step 8 — `ai-docs/specs/bodhi-pi/index.md`

Add row to the "Read this if…" table:

```md
| What modes does bodhi-pi support, how do permissions work, what's the four-mode enum? | [modes.md](./modes.md) |
```

Update the "Source-of-truth pointers" section to mention modes is now a first-class concept.

### Step 9 — `ai-docs/specs/bodhi-pi/configuration.md`

Add `defaultMode`, `allowsAllowAllMode`, `allowsAllowAllModeAsDefault` to the BodhiPiConfig field table. Add `defaultMode` to the BodhiPiProjectSettings table.

### Step 10 — `ai-docs/specs/bodhi-pi/extensions-skills-commands.md`

Add a small note in the "When to choose which" section that mode-based tool gating is now a thing and link to `modes.md`. Update `allowed-tools` row to drop the "Will land alongside the permissions phase" forward-reference — that phase is now ground (010) + 030.

## Tests

### `packages/bodhi-pi/test/permissions-types.test.ts` (new)

Smoke-test the type surface:

```ts
import { describe, expect, it } from "vitest";
import {
  ALL_AGENT_MODES,
  ALL_TOOL_CATEGORIES,
  MODES_BY_PERMISSIVENESS,
  type AgentMode,
  type ModePreset,
  type PermissionPolicy,
  type ToolCategory,
} from "@/index.js";

describe("permissions types", () => {
  it("exposes the four user-facing modes", () => {
    expect(ALL_AGENT_MODES).toEqual(["ask", "plan", "edit", "allow-all"]);
  });

  it("exposes a permissiveness lattice (plan most restrictive, allow-all most permissive)", () => {
    expect(MODES_BY_PERMISSIVENESS).toEqual(["plan", "ask", "edit", "allow-all"]);
  });

  it("includes mcp and subagent as tool categories", () => {
    expect(ALL_TOOL_CATEGORIES).toEqual(["read", "edit", "search", "execute", "mcp", "subagent", "other"]);
  });

  // Type-only smoke: ensure the union is callable
  it("accepts a fully-populated ModePreset shape", () => {
    const preset: ModePreset = {
      mode: "ask",
      description: "default safe mode",
      policy: { categories: { read: "allow" }, tools: {}, alwaysAllow: [], alwaysDeny: [] },
    };
    expect(preset.mode satisfies AgentMode).toBe("ask");
  });
});
```

### `packages/bodhi-pi/test/tools-categorisation.test.ts` (new)

Verify the expanded `toolKindFor`:

```ts
import { describe, expect, it } from "vitest";
import { toolKindFor } from "@/tools/index.js";

describe("toolKindFor", () => {
  it.each([
    ["read", "read"],
    ["write", "edit"],
    ["edit", "edit"],
    ["ls", "search"],
    ["find", "search"],
    ["grep", "search"],
    ["bash", "execute"],
    ["run_script", "execute"],
    ["subagent", "subagent"],
    ["subagent_batch", "subagent"],
    ["github__create_pr", "mcp"],
    ["unknown_tool", "other"],
  ])("classifies %s as %s", (toolName, expected) => {
    expect(toolKindFor(toolName)).toBe(expected);
  });
});
```

### `packages/bodhi-pi/test/settings.test.ts` (existing — extend)

Add an assertion that loading a `settings.json` with `defaultMode: "ask"` parses without error and exposes the field on the loaded settings (no validation yet — that's milestone 020):

```ts
it("preserves defaultMode field from settings.json", async () => {
  const fs = createInMemoryFilesystem();
  await fs.writeTextFile("/cwd/.bodhi-pi/settings.json", JSON.stringify({ defaultMode: "ask" }));
  const result = await loadProjectSettings(fs, "/cwd");
  expect(result.settings.defaultMode).toBe("ask");
});
```

### Test plan — NOT in this milestone

- 4-runtime parity tests: nothing to test yet at host level (no behaviour). Skip.
- e2e LLM test: no mode-related behaviour. Skip.
- Playwright UI tests: no UI surface yet. Skip.

This milestone passes once `npm run check` + `npm test` are green. `just test-e2e` and `just test-e2e-ui` should still pass because no behaviour changes affect them.

## Per-runtime impact

| Host | Change required |
|---|---|
| cli (`test-apps/cli`) | None — types only |
| http (`test-apps/http`) | None |
| browser (`test-apps/browser`) | None |
| chrome-ext (`test-apps/chrome-ext`) | None |

This milestone is intentionally a no-op for hosts. The first host-side change lands in 020.

## Gate checks

- `npm run check` — passes
- `npm test` — new tests pass; existing tests unchanged
- `just test-e2e` — unchanged (no behaviour change should affect any e2e)
- `just test-e2e-ui` — unchanged

## Commit message

```
bodhi-pi modes 010: tool-category expansion + permission types + modes spec

Introduce src/permissions/types.ts with AgentMode, PermissionDecision,
PermissionPolicy, ApprovalDecision, ToolCategory, ModeRuntimeCapabilities,
ModePreset. Expand toolKindFor with mcp and subagent categories. Add
defaultMode + allowsAllowAllMode + allowsAllowAllModeAsDefault to
BodhiPiConfig; defaultMode to BodhiPiProjectSettings. Declare three new
lifecycle events (mode_change, tool_approval_request, tool_approval_response)
without yet emitting them. Create ai-docs/specs/bodhi-pi/modes.md as the
canonical mode + permission reference; update index.md, configuration.md,
extensions-skills-commands.md to point at it.

No behaviour change — types and spec scaffold only. Milestone 020 reads
defaultMode and adds the PermissionService; milestone 030 wires native
ACP requestPermission for ask mode.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

## Interactions with other features

- **MCP**: now classified as `"mcp"` category. The existing per-server include/exclude story is unchanged; modes 020+ will add category-level policy decisions on top. No behaviour change in 010.
- **Sub-agents**: now classified as `"subagent"` category. `SubagentProfile` is unchanged in 010 (gets `mode?` field in milestone 070).
- **Skills**: `allowed-tools` runtime enforcement is now achievable (the `Permissioner` line in `PARITY.md` becomes "shipped via PermissionService" in milestone 030). Note in the modes.md spec but don't wire enforcement yet.
- **Extensions**: `ExtensionAPI` unchanged in 010 (gets `setActiveTools` in milestone 080).
- **Settings layering**: `defaultMode` is a new key but no read site exists yet.

## Risks

- **Risk**: `ToolKind` ACP enum may not include `"mcp"` / `"subagent"`. **Mitigation**: add `toAcpToolKind(category)` shim in `src/wire/converters.ts` that maps unknown bodhi-pi categories to ACP-supported values (`mcp` → `execute`, `subagent` → `other`). Verify before commit.
- **Risk**: An external consumer of `toolKindFor` depends on the old 5-value union. **Mitigation**: `ToolCategory` is a strict superset of the old union; existing switches that don't handle `mcp`/`subagent` will fall to their default branch. TypeScript exhaustiveness checks will flag any consumer that explicitly `assertNever`s — fix them in the same commit.

## Definition of done

- [ ] All "IN" rows above are implemented
- [ ] `npm run check` clean
- [ ] `npm test` clean
- [ ] `ai-docs/specs/bodhi-pi/modes.md` exists and references this milestone as done
- [ ] `ai-docs/specs/bodhi-pi/index.md` Read-this-if table includes the modes row
- [ ] Single commit on `main` with the message template above
- [ ] Implementation status table in `modes.md` shows milestone 010 as ☑
