# Milestone 020 — Mode state + ACP `setSessionConfigOption` (with `configId: "mode"`)

> **Read [005-acp-architecture-decision.md](005-acp-architecture-decision.md) BEFORE this milestone.** It revises the wire-surface choices originally drafted here.
> Also read [000-overview.md](000-overview.md) and [010-ground-preparation.md](010-ground-preparation.md). Milestone 010 must be merged before this milestone starts.

## Updated approach (per 005)

The original draft of this milestone proposed implementing the deprecated `session/setSessionMode`. **Don't.** Instead, extend the existing `setSessionConfigOption` dispatch table in `src/models/registry.ts:217-236` with a new `MODE_CONFIG_ID = "mode"` entry that calls `PermissionService.setMode`. Mode change notifications go via the existing `ConfigOptionUpdate` `SessionUpdate` variant (not the deprecated `CurrentModeUpdate`). Below is the original brief; treat sections that say "implement setSessionMode" / "emit CurrentModeUpdate" as superseded by the dispatch-table-extension and `ConfigOptionUpdate` approach.

### Concrete changes vs original 020 draft

| Original | Replace with |
|---|---|
| Add `setSessionMode(params)` method to `BodhiPiAcpAgent` | **No method addition** — `BodhiPiAcpAgent.setSessionConfigOption` (existing at `src/acp/agent.ts:583-584`) already routes to `ModelRegistry.setSessionConfigOption`, which we extend. |
| Add `MODE_CONFIG_ID` constant | **Add** (was correct) — `src/wire/constants.ts` alongside `MODEL_CONFIG_ID` / `THINKING_CONFIG_ID` |
| Build `availableModes` and put on `NewSessionResponse._meta["bodhi-pi"].modes` | **Replace** — return as a `SessionConfigOption` with `category: "mode"` from the existing `buildAllConfigOptions(sessionId)` in `src/models/registry.ts:208`. Mode is the FIRST entry (highest priority per spec). The legacy `modes: SessionModeState` field on `NewSessionResponse` is NOT populated. |
| Emit `CurrentModeUpdate` `SessionUpdate` on mode change | **Replace** — emit `ConfigOptionUpdate` with the FULL `configOptions` list (per ACP spec: agent MUST return complete state on any option change). The existing `setSessionConfigOption` flow already does this for model/thinking; mode rides the same code path. |
| Add new wire constants `EXT_MODE_SET/GET/LIST` | **Skip entirely** — ACP-native methods cover all three. |
| Implement mode change via `LIFECYCLE_EVENT_METHOD` (as fallback) | **Skip entirely** — `ConfigOptionUpdate` is in the SDK; no fallback needed. The in-process `mode_change` event still fires (extensions can subscribe), but the wire view is `ConfigOptionUpdate`. |
| Emit `ConfigOptionUpdate` after response | **Reverse** — emit BEFORE returning from `setSessionConfigOption` (Goose pattern, see [notes/16-goose-acp.md](../notes/16-goose-acp.md)) to avoid the race where the response unblocks the client before the notification arrives. |

### `PermissionService` API surface (refined)

```ts
class PermissionService {
  buildModeConfigOption(session: SessionState): SessionConfigOption {
    return {
      id: MODE_CONFIG_ID,
      name: "Session Mode",
      description: "Controls how the agent requests permission",
      category: "mode",
      type: "select",
      currentValue: session.runtime.mode,
      options: ALL_AGENT_MODES.map(mode => ({
        value: mode,
        name: MODE_PRESETS[mode].displayName,
        description: MODE_PRESETS[mode].description,
      })).filter(opt => opt.value !== "allow-all" || capabilities.allowsAllowAllMode),
    };
  }

  async setMode(sessionId: string, modeId: string, reason?: string): Promise<void> {
    if (!ALL_AGENT_MODES.includes(modeId as AgentMode)) throw new RequestError(-32602, ...);
    if (modeId === "allow-all" && !this.capabilities.allowsAllowAllMode) throw new RequestError(-32603, ...);
    const session = this.sessions.get(sessionId);
    const from = session.runtime.mode;
    session.runtime.mode = modeId as AgentMode;
    await this.appendEntry(sessionId, session, { type: "mode_change", mode: modeId, reason: reason ?? "user", ... });
    await this.events.emit({ type: "mode_change", sessionId, fromMode: from, toMode: modeId, reason });
  }

  getCurrentMode(sessionId: string): AgentMode { ... }

  // Below — milestone 030 fills these in
  async evaluateToolCall(sessionId, toolCall): Promise<ApprovalDecision> { return { kind: "allow" }; }
}
```

### Registry dispatch-table extension

In `src/models/registry.ts:217-236` (the existing dispatch table), add one entry:

```ts
[MODE_CONFIG_ID]: (sid, _s, v) => this.permissionService.setMode(sid, v, "user"),
```

And in `buildAllConfigOptions(sessionId)` (line 208), prepend mode:

```ts
const options: SessionConfigOption[] = [
  this.permissionService.buildModeConfigOption(this.sessions.get(sessionId)!),
  await this.buildModelConfigOption(...),
  ...(thinking ? [thinking] : []),
];
```

`ModelRegistry` gains a reference to `PermissionService` in its constructor (or `PermissionService` is registered on `ModelRegistry` via setter after both are constructed — handle the circular-dep via setter to avoid constructor ordering issues).

### `BodhiPiAcpAgent` constructor wiring

Adds `PermissionService` alongside other domain services:

```ts
this.permissionService = new PermissionService({
  sessions: this.sessions,
  events: this.events,
  conn: this.conn,
  appendEntry: this.appendEntry.bind(this),
  capabilities: { allowsAllowAllMode: !!config.allowsAllowAllMode, allowsAllowAllModeAsDefault: !!config.allowsAllowAllModeAsDefault },
});
this.modelRegistry.setPermissionService(this.permissionService);  // setter-injection to break circular dep
```

`extHandlers` does NOT gain new entries — `setSessionConfigOption` already routes via the existing handler at `src/acp/agent.ts:583`.

---

## Goal

Wire the mode plumbing end-to-end **without yet enforcing any policy**. After this milestone:

- Every session has a `mode: AgentMode` on `SessionState.runtime`
- Default mode is `ask` (or whatever `defaultMode` is set via `BodhiPiConfig` / settings)
- Clients can call ACP-native `session/setSessionMode { sessionId, modeId }` to change it
- Clients get `CurrentModeUpdate` `SessionUpdate` notifications on change
- `availableModes` are advertised in `NewSessionResponse._meta["bodhi-pi"].modes` (or wherever ACP supports `SessionModeState` — see §"ACP availableModes advertisement")
- A `mode_change` `SessionEntry` is appended so resume/load restore the last mode
- A `mode_change` lifecycle event fires on both rails (in-process + wire `LIFECYCLE_EVENT_METHOD`)
- A `PermissionService` core service exists, registered alongside the other domain services in `BodhiPiAcpAgent`, but its policy decision is hardcoded to `{ kind: "allow" }` until milestone 030 lands the preset engine
- 4-runtime parity: each Host's Client exposes a `/mode <id>` slash command + a `/modes` lister; tests prove this across CLI / HTTP / browser / chrome-ext
- `allow-all` mode capability gating is enforced even though the preset itself doesn't exist yet — `setSessionMode("allow-all")` returns `-32603` if `allowsAllowAllMode === false`
- Bootstrap rejects `defaultMode: "allow-all"` from settings unless `allowsAllowAllModeAsDefault === true`

**No tool gating happens yet.** A user can change modes, see the badge update, see the lifecycle event, see the SessionEntry persisted — but every tool still runs unconditionally. This separation is intentional: milestone 020 proves the mode-state plumbing; milestone 030 wires actual policy.

## Prerequisites

- Milestone 010 merged

## Architecture decisions for this milestone

### `PermissionService` lives at `src/permissions/permission-service.ts`

Domain-folder rule (per `feedback_bodhi_pi_src_layout`): both types and service in the same folder. Service file structure:

```
src/permissions/
├── types.ts                  (milestone 010)
├── presets.ts                (placeholder map { ask, plan, edit, allow-all } → ALLOW_ALL_PRESET — milestone 030 replaces)
├── permission-service.ts     (NEW)
└── (later) approval-flow.ts  (milestone 030)
```

The service registers as a domain service alongside `KvService`, `McpService`, `SettingsService`, `SessionInfoService`, etc. in `BodhiPiAcpAgent`'s constructor (`src/acp/agent.ts:185-315`). It owns:

- A reference to `sessions: Map<string, SessionState>` (shared with other services)
- A reference to the `events: EventDispatcher`
- A reference to `appendEntry` for persisting `mode_change` entries
- A reference to `capabilities: ModeRuntimeCapabilities` derived from `BodhiPiConfig`
- A `register()` method that returns `[]` in this milestone (no extension methods yet — `setSessionMode` is native ACP, not extension)
- Public methods:
  - `getCurrentMode(sessionId): AgentMode`
  - `setMode(sessionId, modeId, reason): Promise<void>` — used by both the native ACP handler and (in milestone 050) the `submit_plan` auto-transition
  - `getAvailableModes(): SessionMode[]` — returns the four-entry `SessionMode[]` for advertisement
  - (placeholder for milestone 030) `evaluateToolCall(sessionId, toolCall): ApprovalDecision`

### `setSessionMode` is a native ACP method, NOT a `_bodhi-pi/*` extension

The `BodhiPiAcpAgent` class implements `AcpAgent` from the ACP SDK. It needs to add a `setSessionMode(params)` method. Today the class declares the interface but doesn't implement that method — TS allows this because `setSessionMode?` is the optional shape in `acp.d.ts:950`. Adding the method now does NOT break wire compatibility because the SDK already declares the type.

### `availableModes` advertisement

ACP supports advertising session modes via the `SessionModeState` type. The current ACP spec exposes this through:
- `NewSessionResponse._meta` (clean place — included in the initial response)
- Possibly a dedicated session-update variant (verify against the SDK's `SessionUpdate` union)

Implementation: in `BodhiPiAcpAgent.newSession()` / `loadSession()` / `resumeSession()` responses, populate `_meta["bodhi-pi"].modes = { availableModes: [...], currentModeId: "ask" }`. On mode change, the agent emits a `CurrentModeUpdate` `SessionUpdate` notification (one of the variants of ACP's `SessionUpdate` discriminated union — verify the exact variant tag in the SDK before writing). If ACP doesn't yet expose mode state in the session-update union, fall back to a bodhi-pi-specific `LIFECYCLE_EVENT_METHOD` notification carrying the `mode_change` event payload — that's already proven plumbing.

**Action item for the implementer**: grep the SDK for `CurrentModeUpdate` and `SessionUpdate` to confirm whether the session-update variant exists. If yes, emit via `sessionUpdate`; if no, emit via `LIFECYCLE_EVENT_METHOD`. Document the decision in `modes.md`.

### `mode_change` SessionEntry

Adopt the pattern from `model_change` / `thinking_change`:

```ts
export interface ModeChangeEntry extends BaseEntry {
  type: "mode_change";
  mode: AgentMode;
  reason: "user" | "session_load" | "submit_plan_approved" | "settings_change" | "subagent_spawn";
}
```

Append on every `setMode` call. On `rehydrateSession`, the latest `mode_change` on the active branch is the session's current mode. If no `mode_change` exists, fall back to the bootstrap default. Add an `ALL_NON_MESSAGE_ENTRY_TYPES_FILTER` row so `buildSessionContext` filters this entry out of LLM messages (it's metadata, not user-facing).

### Default-mode resolution at bootstrap

`buildSessionState` (`src/sessions/session-bootstrap.ts:227`) resolves the initial mode in this order:

1. If `mergedFileSettings.defaultMode` is set and valid → use it
2. Else if `config.defaultMode` is set → use it
3. Else → `"ask"` (the safe default)

Validation:
- Unknown string in `mergedFileSettings.defaultMode` → log warning via `config.logger`, fall through to step 2
- `"allow-all"` in `mergedFileSettings.defaultMode` AND `capabilities.allowsAllowAllModeAsDefault === false` → log error, fall through to step 2 (with the error surfaced in the next `_bodhi-pi/session/config` response under a new `modeBootstrapError?: string` field)

`rehydrateSession` (`src/sessions/session-bootstrap.ts:336`) reads the latest `mode_change` entry from `walkPath(entries, leafId)` and uses it; otherwise falls back to the bootstrap chain above.

## Scope

### IN

| Change | File |
|---|---|
| New `src/permissions/presets.ts` — placeholder `ALLOW_ALL_PRESET` (replaced in 030) | New file |
| New `src/permissions/permission-service.ts` — class with `setMode`, `getCurrentMode`, `getAvailableModes`, placeholder `evaluateToolCall` | New file |
| Add `mode: AgentMode` to `SessionState.runtime` + `pendingModeChange?` flag | `src/sessions/session-state.ts` |
| Update `buildSessionState` to initialise `mode` via bootstrap chain | `src/sessions/session-bootstrap.ts` |
| Update `rehydrateSession` to restore mode from last `mode_change` entry | `src/sessions/session-bootstrap.ts` |
| New `ModeChangeEntry` SessionEntry variant | `src/sessions/entries.ts` |
| Filter `mode_change` in `buildSessionContext` (don't reach LLM) | `src/sessions/build-context.ts` |
| Implement `setSessionMode` on `BodhiPiAcpAgent` (delegates to `PermissionService.setMode`) | `src/acp/agent.ts` |
| Wire `PermissionService` into `BodhiPiAcpAgent` constructor (added to service list) | `src/acp/agent.ts` |
| Emit `CurrentModeUpdate` `SessionUpdate` notification on mode change (or fallback to LIFECYCLE_EVENT_METHOD per architecture decision above) | `src/acp/event-wiring.ts` |
| Forward `mode_change` to wire via `notifyLifecycle` in `src/acp/event-wiring.ts` | `src/acp/event-wiring.ts` |
| Add `modes: SessionModeState` to `_meta["bodhi-pi"]` of `NewSessionResponse`, `LoadSessionResponse`, `ResumeSessionResponse` | `src/acp/agent.ts` |
| Add `mode` field to `_bodhi-pi/session/config` response | `src/sessions/session-info-service.ts` |
| Validate `defaultMode` value at bootstrap; reject `allow-all` if capabilities forbid | `src/sessions/session-bootstrap.ts` |
| `agentCapabilities._meta["bodhi-pi"].available.modes = true` advertisement | `src/acp/agent.ts` `computeAvailability()` |
| Update `ai-docs/specs/bodhi-pi/modes.md` with implementation status row 020 = ☑ + sequence diagram for setSessionMode | Edit |
| Update `ai-docs/specs/bodhi-pi/acp.md` — add `session/setSessionMode` section + `CurrentModeUpdate` notification entry | Edit |
| Update `ai-docs/specs/bodhi-pi/lifecycle.md` — add `mode_change` SessionEntry row | Edit |
| Update `ai-docs/specs/bodhi-pi/architecture.md` — add `PermissionService` to the services table | Edit |
| Per-Host `/mode <id>` + `/modes` slash command dispatchers | `test-apps/{cli,http,browser,chrome-ext}/src/client/...` |

### OUT

- Any preset other than placeholder ALLOW_ALL (milestones 030+)
- `requestPermission` invocation (milestone 030)
- Any tool gating (milestone 030)
- `submit_plan` tool (milestone 050)
- `setActiveTools` API (milestone 080)
- Persistent rules (milestone 090)

## Implementation order

Follow the 7-step TDD workflow from CLAUDE.md:

### 1. `packages/bodhi-pi/test/modes-state.test.ts` (new)

Failing integration test that drives the design:

```ts
import { describe, expect, it } from "vitest";
import { createTestHarness } from "./helpers/harness.js";
import { fauxModels } from "./helpers/...";

describe("session mode state", () => {
  it("defaults new sessions to ask mode", async () => {
    const { clientConn } = createTestHarness({ models: fauxModels, defaultModelId: "faux" });
    await clientConn.initialize({ protocolVersion: 1, clientCapabilities: {} });
    const session = await clientConn.newSession({ cwd: "/tmp" });
    const config = await clientConn.extMethod("_bodhi-pi/session/config", { sessionId: session.sessionId });
    expect(config.mode).toBe("ask");
  });

  it("setSessionMode mutates mode and emits CurrentModeUpdate or LIFECYCLE_EVENT_METHOD", async () => {
    const { clientConn, updates, extNotifications } = createTestHarness({ ... });
    await clientConn.initialize(...);
    const session = await clientConn.newSession({ cwd: "/tmp" });
    await clientConn.setSessionMode({ sessionId: session.sessionId, modeId: "edit" });
    const config = await clientConn.extMethod("_bodhi-pi/session/config", { sessionId: session.sessionId });
    expect(config.mode).toBe("edit");
    // Either a sessionUpdate notification with CurrentModeUpdate, or a LIFECYCLE_EVENT_METHOD notif:
    const modeNotif = updates.find(u => /* CurrentModeUpdate variant */) ??
                      extNotifications.find(n => n.method === "_bodhi-pi/lifecycle/event" &&
                                                  (n.params as any).type === "mode_change");
    expect(modeNotif).toBeDefined();
  });

  it("setSessionMode persists a mode_change SessionEntry that restores on session load", async () => {
    const { clientConn, sessionStore } = createTestHarness({ ... });
    await clientConn.initialize(...);
    const session = await clientConn.newSession({ cwd: "/tmp" });
    await clientConn.setSessionMode({ sessionId: session.sessionId, modeId: "edit" });
    await clientConn.closeSession({ sessionId: session.sessionId });
    const reloaded = await clientConn.loadSession({ sessionId: session.sessionId, cwd: "/tmp" });
    const config = await clientConn.extMethod("_bodhi-pi/session/config", { sessionId: session.sessionId });
    expect(config.mode).toBe("edit");
  });

  it("rejects setSessionMode allow-all when allowsAllowAllMode is false", async () => {
    const { clientConn } = createTestHarness({ models: fauxModels, defaultModelId: "faux" /* allowsAllowAllMode not set, defaults false */ });
    await clientConn.initialize(...);
    const session = await clientConn.newSession({ cwd: "/tmp" });
    await expect(clientConn.setSessionMode({ sessionId: session.sessionId, modeId: "allow-all" }))
      .rejects.toThrowError(/-32603/);
  });

  it("accepts setSessionMode allow-all when allowsAllowAllMode is true", async () => {
    const { clientConn } = createTestHarness({ /* allowsAllowAllMode: true */ });
    // ...
    await clientConn.setSessionMode({ sessionId: session.sessionId, modeId: "allow-all" });
    // verify mode is "allow-all"
  });

  it("rejects defaultMode allow-all in settings.json when allowsAllowAllModeAsDefault is false", async () => {
    const fs = createInMemoryFilesystem();
    await fs.writeTextFile("/cwd/.bodhi-pi/settings.json", JSON.stringify({ defaultMode: "allow-all" }));
    const { clientConn, recordedLogs } = createTestHarness({
      filesystem: fs,
      /* allowsAllowAllMode: true (host capable), allowsAllowAllModeAsDefault: false (no project default) */
    });
    await clientConn.initialize(...);
    const session = await clientConn.newSession({ cwd: "/cwd" });
    const config = await clientConn.extMethod("_bodhi-pi/session/config", { sessionId: session.sessionId });
    expect(config.mode).toBe("ask"); // fallback
    expect(config.modeBootstrapError).toMatch(/allow-all.*requires.*allowsAllowAllModeAsDefault/);
  });

  it("accepts defaultMode value 'edit' from settings.json", async () => {
    const fs = createInMemoryFilesystem();
    await fs.writeTextFile("/cwd/.bodhi-pi/settings.json", JSON.stringify({ defaultMode: "edit" }));
    const { clientConn } = createTestHarness({ filesystem: fs });
    await clientConn.initialize(...);
    const session = await clientConn.newSession({ cwd: "/cwd" });
    const config = await clientConn.extMethod("_bodhi-pi/session/config", { sessionId: session.sessionId });
    expect(config.mode).toBe("edit");
  });

  it("warns and falls back when defaultMode is an unknown value", async () => {
    const fs = createInMemoryFilesystem();
    await fs.writeTextFile("/cwd/.bodhi-pi/settings.json", JSON.stringify({ defaultMode: "nonsense" }));
    const logCalls: unknown[][] = [];
    const { clientConn } = createTestHarness({ filesystem: fs, logger: { error: (...args) => logCalls.push(["error", ...args]), warn: (...args) => logCalls.push(["warn", ...args]) } });
    await clientConn.initialize(...);
    const session = await clientConn.newSession({ cwd: "/cwd" });
    const config = await clientConn.extMethod("_bodhi-pi/session/config", { sessionId: session.sessionId });
    expect(config.mode).toBe("ask");
    expect(logCalls.some(c => c[1].includes("defaultMode"))).toBe(true);
  });

  it("advertises availableModes on newSession", async () => {
    const { clientConn } = createTestHarness({ ... });
    await clientConn.initialize(...);
    const session = await clientConn.newSession({ cwd: "/tmp" });
    const modes = (session._meta as any)?.["bodhi-pi"]?.modes;
    expect(modes?.availableModes?.map((m: any) => m.id).sort()).toEqual(["allow-all", "ask", "edit", "plan"]);
    expect(modes?.currentModeId).toBe("ask");
  });
});
```

Also a sub-agent-aware test: child sessions inherit parent mode (placeholder until milestone 070 implements the Qwen rule):

```ts
it("child sub-agent session inherits parent's mode in 020 (qwen rule lands in 070)", async () => {
  // Stub: assert child's session_config.mode === parent's at spawn time
});
```

### 2. e2e: skip in 020

No real-LLM behaviour change. Mode-change events fire but tools all still run. Add an `e2e/mode-state.e2e.ts` that just calls `setSessionMode("edit")` and asserts the change persists across `loadSession`. Use `gpt-4o-mini` for a single round-trip to prove ACP method works end-to-end with a real connection.

### 3. node-adapters

No adapter change needed. SessionStore already handles arbitrary `SessionEntry` discriminated-union variants — adding `mode_change` requires no SQLite schema migration (entries are stored as JSON in a single column).

### 4. browser/chrome-ext host

Same — no adapter change. Dexie stores entries as JSON.

### 5. CLI e2e: `test-apps/cli/e2e/mode-state.e2e.ts`

```ts
it("user types /mode edit and the CLI badge updates", async () => {
  // Start cli via spawnCli helper
  // Send /modes — assert list of 4 modes printed
  // Send /mode edit — assert "mode set to edit" + badge update
  // Send /config (calls _bodhi-pi/session/config) — assert mode: edit
  // Kill cli
});
```

CLI Host changes (`test-apps/cli/src/client/commands.ts` likely):
- Add `/modes` command — call `_bodhi-pi/session/config` then print all four mode names + current
- Add `/mode <id>` command — call native `clientConn.setSessionMode({ sessionId, modeId })`; print confirmation; badge will update via the CurrentModeUpdate or LIFECYCLE_EVENT_METHOD subscription

Footer/status surface (`test-apps/cli/src/client/modes/interactive/components/footer.ts` for the interactive REPL): add a mode indicator next to the model. Bodhi-pi already does this for thinking level — mirror.

### 6. Playwright (`test-apps/browser/e2e/mode-state.spec.ts` + `chrome-ext/e2e/mode-state.spec.ts`)

```ts
test("dropdown shows 4 modes; selecting one updates the badge", async ({ page }) => {
  // navigate to browser app, init session
  // click mode dropdown — assert 4 options
  // click "edit" — assert badge text becomes "edit"
  // reload page — assert badge still "edit" (persisted via mode_change SessionEntry)
});
```

Browser Host changes (`test-apps/browser/src/client/...`):
- Add a mode-dropdown to the chat UI (small component). Reads `availableModes` from session config; calls `setSessionMode` on selection.
- Subscribe to `CurrentModeUpdate` (or LIFECYCLE_EVENT_METHOD with `type === "mode_change"`) and refresh local mode state.
- Mode badge in the header/footer.

Chrome-ext mirrors the browser implementation since it consumes browser/host code.

### 7. HTTP integration (`test-apps/http/test/integration/mode-state.test.ts`)

Per-turn-rebuild test: ensure that after `setSessionMode("edit")` then a closure + rebuild, the next request reads the mode back from SQLite via the `mode_change` SessionEntry. Critical for HTTP because the Agent is rebuilt per request.

### Frontend (`test-apps/http/src/client/...`)

Same mode dropdown as browser; HTTP transport carries the `setSessionMode` request and the `CurrentModeUpdate` SSE notification (or LIFECYCLE_EVENT_METHOD).

## Per-runtime impact

| Host | Surfaces |
|---|---|
| cli | `/modes`, `/mode <id>`, badge in footer (interactive REPL), `--default-mode <id>` startup flag wiring (optional; can defer to 050) |
| http | Mode dropdown in frontend, SSE-forwarded `mode_change`, server-side per-turn-rebuild restores mode |
| browser | Mode dropdown in chat UI, MessagePort-forwarded `mode_change`, persistence via Dexie SessionStore |
| chrome-ext | Same as browser |

## Tests summary

| Test type | Count | New files |
|---|---|---|
| Integration (`test/`) | 8 cases | `modes-state.test.ts` |
| e2e (`e2e/`) | 1 case | `mode-state.e2e.ts` |
| CLI e2e | 1 case | `test-apps/cli/e2e/mode-state.e2e.ts` |
| Browser playwright | 1 case | `test-apps/browser/e2e/mode-state.spec.ts` |
| Chrome-ext playwright | 1 case | `test-apps/chrome-ext/e2e/mode-state.spec.ts` |
| HTTP integration | 1 case | `test-apps/http/test/integration/mode-state.test.ts` |

## Gate checks

- `npm run check` — passes
- `npm test` — new tests pass
- `just test-e2e` — passes (new e2e file added)
- `just test-e2e-ui` — passes (new playwright specs added)

## Commit message

```
bodhi-pi modes 020: PermissionService skeleton + ACP setSessionMode + mode state across runtimes

Add SessionState.runtime.mode (default "ask"), implement ACP-native
session/setSessionMode in BodhiPiAcpAgent, register PermissionService as a
domain service (policy stub returns allow until 030), advertise availableModes
via _meta["bodhi-pi"].modes, persist a mode_change SessionEntry, emit
CurrentModeUpdate session notifications and a mode_change lifecycle event on
both rails. Reject setSessionMode "allow-all" when allowsAllowAllMode is
false. Reject defaultMode "allow-all" from settings when
allowsAllowAllModeAsDefault is false.

CLI gets /mode /modes slashes and a footer badge. HTTP/browser/chrome-ext
expose a mode dropdown. Mode persists across session load/resume/close-reopen
and survives the http per-turn rebuild via the SessionEntry.

No tool gating yet — milestone 030 wires the ask preset and native
requestPermission flow.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

## Interactions with other features

- **Sessions/lifecycle**: `mode_change` is a new SessionEntry variant. `walkPath` traversal already works for arbitrary entry types; `buildSessionContext` filters it out of LLM messages.
- **Sub-agents**: child sessions inherit parent mode trivially in 020 (they inherit `SessionState` shape; in 070 the Qwen-rule resolver lands). Sub-agent's first SessionEntry (`subagent_link`) is followed by an immediate `mode_change` written by `SubagentService.spawn` if the child's resolved mode differs from the system default.
- **MCP**: MCP tool calls go through the same `beforeToolCall` hook; in 020 they always allow. In 030 the `mcp` category gets ask-by-default in `ask` mode.
- **Extensions**: extensions can subscribe to the new `mode_change` event via `pi.on("mode_change", handler)`. The handler signature follows the existing pattern. Document in `extensions-skills-commands.md`.
- **Settings**: `_bodhi-pi/session/settings/set defaultMode <id>` now meaningful — but only affects new sessions (existing sessions keep their runtime mode until `setSessionMode` is called). Document in settings spec.
- **Compaction**: `mode_change` entries are kept verbatim through compaction (they're not part of the LLM context anyway).

## Risks

- **Risk**: `CurrentModeUpdate` may not be a real ACP `SessionUpdate` variant despite being declared as a type. **Mitigation**: implementer must grep the SDK's `SessionUpdate` union before writing. If absent, fall back to `LIFECYCLE_EVENT_METHOD` for mode notifications. Decision is documented in `modes.md`.
- **Risk**: ACP's `Agent` interface declares `setSessionMode` as optional but `BodhiPiAcpAgent`'s tsgo may flag the missing implementation if interface compatibility is strict. **Mitigation**: implement the method; this milestone requires it anyway.
- **Risk**: HTTP per-turn rebuild loses in-memory `SessionState` and rebuilds from SQLite; mode field is in runtime, not persisted — but the `mode_change` SessionEntry restores it on each rebuild via `rehydrateSession`. **Mitigation**: explicit HTTP integration test enforces this.
- **Risk**: existing tests that create sessions and call tools may suddenly see `mode_change` SessionEntries in the persisted log and break assertion on entry counts. **Mitigation**: only sessions where `setSessionMode` was called add the entry. Sessions that stay on the default `ask` mode get no entry. Document.

## Definition of done

- [ ] All IN rows implemented
- [ ] All tests pass across 4 Hosts
- [ ] `npm run check`, `npm test`, `just test-e2e`, `just test-e2e-ui` all green
- [ ] `ai-docs/specs/bodhi-pi/modes.md` implementation-status row 020 = ☑
- [ ] `acp.md`, `lifecycle.md`, `architecture.md` updated same-commit
- [ ] Single commit (or tight sequence) on `main`
- [ ] No mode-related policy enforcement yet — tools still run unconditionally (verified by an existing test still passing)
