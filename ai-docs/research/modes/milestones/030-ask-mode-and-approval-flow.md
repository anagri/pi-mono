# Milestone 030 — `ask` mode + ACP `requestPermission` flow

> **Read [005-acp-architecture-decision.md](005-acp-architecture-decision.md) BEFORE this milestone.** It revises the option-set design here.
> Also read [000-overview.md](000-overview.md), [010-ground-preparation.md](010-ground-preparation.md), [020-mode-state-and-set-session-mode.md](020-mode-state-and-set-session-mode.md). Milestones 010 and 020 must be merged before this milestone starts. **This is the biggest milestone in the plan — both the policy engine and the 4-runtime approval UI land here.**

## Updated approach (per 005)

Three changes from the original draft:

### 1. Use native ACP `session/request_permission` (not custom wire)

The original draft introduced `_bodhi-pi/permission/request` / `_bodhi-pi/permission/respond` wire methods. **Don't.** Use the native ACP `session/request_permission` (Agent → Client) — the `BodhiPiAcpAgent` already holds a `conn: AgentSideConnection`; call `await this.conn.requestPermission({ sessionId, toolCall, options })` directly from `PermissionService`. The response comes back as `RequestPermissionResponse { outcome: { outcome: "cancelled" | "selected", optionId? } }`.

The test-harness already stubs `requestPermission` (see `test/helpers/harness.ts:82`); extend it with the `approvalResponses` queue.

### 2. Scope encoded in `optionId` for `allow_always` (codex-acp pattern)

Instead of offering one `allow_always` option and prompting for scope after, offer THREE distinct `allow_always` options in `ask` mode — scope is the `optionId`:

```ts
const options: PermissionOption[] = [
  { optionId: "allow_once",              name: "Allow once",                       kind: "allow_once" },
  { optionId: "allow_always_session",    name: "Allow always (this session)",      kind: "allow_always" },
  { optionId: "allow_always_project",    name: "Allow always (this project)",      kind: "allow_always" },
  { optionId: "allow_always_global",     name: "Allow always (every project)",     kind: "allow_always" },
  { optionId: "reject_once",             name: "Reject",                           kind: "reject_once" },
  { optionId: "reject_always",           name: "Reject always (this session)",     kind: "reject_always" },
];
```

When the agent receives `{ optionId: "allow_always_project" }`, it (a) lets the tool run, AND (b) writes the pattern to `permission.alwaysAllow` at PROJECT scope via existing `SettingsService.set` (milestone 090 wires the write itself; 030 just decodes the optionId).

### 3. No new wire methods at all

The original draft listed:
- `_bodhi-pi/permission/respond`
- `_bodhi-pi/permission/list`
- `_bodhi-pi/permission/policy/get`
- `_bodhi-pi/permission/policy/set`

**Drop all four.** They were leftover from the pre-ACP-research design. The native `session/request_permission` covers the round-trip; the existing `_bodhi-pi/session/settings/*` covers persistent rules.

The in-process `tool_approval_request` / `tool_approval_response` events stay on the `EventDispatcher` for extensions to subscribe to — NOT forwarded to wire.

---

## Goal

Wire the policy engine and the approval round-trip end-to-end so that **`ask` mode actually enforces decisions**:

- `PermissionService` replaces its placeholder allow-all with a real policy engine that reads the current mode preset, per-category, per-tool overrides, and session grants
- The `ask` preset becomes real: `{ read: allow, search: allow, edit: ask, execute: ask, mcp: ask, subagent: ask }`
- Tool calls that resolve to `ask` cause the agent to invoke **native ACP `conn.requestPermission(...)`** with 4 options (`allow_once`, `allow_always`, `reject_once`, `reject_always`)
- The agent suspends the tool call (via the async `beforeToolCall` hook) until the user responds OR the 30s timeout fires
- `allow_once` / `allow_always` → tool executes; `reject_once` / `reject_always` → tool blocked with reason
- `allow_always` and `reject_always` add the `<toolName>` pattern to `SessionState.runtime.permissionGrants` (in-memory only in this milestone; persistent rules across sessions ship in milestone 090)
- Each of the four reference Hosts implements the Client side of `requestPermission` with a runtime-appropriate UI: CLI prompt; HTTP modal; browser modal; chrome-ext popup
- `tool_call_update` notification carries `status: "pending"` while approval is in flight, so client UIs render a pending tool card
- `tool_approval_request` and `tool_approval_response` lifecycle events fire on both rails

**Default mode remains `ask`, so this milestone visibly changes user-facing behaviour**: a fresh session attempting to call `edit`/`bash`/MCP tools will pause for approval. Existing tests that called tools without an approval-aware client will need a stub-update (the test harness's existing `requestPermission: async () => ({ outcome: { outcome: "cancelled" } })` will cause those calls to be rejected — switch them to allow-once for backward-compatible assertions, OR set the test session's mode to `edit` if the test isn't about approval).

Other modes (`edit`, `plan`, `allow-all`) are NOT in this milestone — they ship 040/050/060 as small additive presets on the engine 030 builds.

## Prerequisites

- Milestone 010 merged
- Milestone 020 merged

## Architecture decisions for this milestone

### Single hook point: `beforeToolCall` via the existing `tool_call` event

bodhi-pi's `tool_call` extension event (`src/events/types.ts:142-153`) already has the right shape — it returns `{ block?: boolean; reason?: string }` and is plumbed through `beforeToolCall` in `src/sessions/session-bootstrap.ts:169-180`. The `PermissionService` registers itself as a built-in handler for `tool_call`. The handler:

1. Reads `session.runtime.mode` + `session.runtime.permissionGrants` + the active preset
2. Computes `ApprovalDecision` via `evaluateToolCall`
3. If `allow` → returns `undefined` (no block); tool runs
4. If `deny` → returns `{ block: true, reason }`; tool blocked
5. If `ask`:
   - Generates `correlationId = randomUUID()`
   - Updates ACP `tool_call.status` to `"pending"` via the existing `subscribeToAgent` pipeline (small hack: emit a synthetic `tool_call_update` with status pending before the `beforeToolCall` hook returns — verify the timing with `pi-agent-core` ordering)
   - Emits `tool_approval_request` lifecycle event
   - Calls `await conn.requestPermission({ sessionId, toolCall: {...}, options: [...] })` with the four `PermissionOption` entries
   - Races against `setTimeout(timeoutMs)` and `session.runtime.cancelled` (the latter resolves the await when `session/cancel` fires)
   - On response:
     - `{ outcome: { outcome: "selected", optionId: "allow_once" } }` → returns `undefined`
     - `{ outcome: { outcome: "selected", optionId: "allow_always" } }` → adds pattern to grants, returns `undefined`
     - `{ outcome: { outcome: "selected", optionId: "reject_once" } }` → returns `{ block: true, reason: "user rejected" }`
     - `{ outcome: { outcome: "selected", optionId: "reject_always" } }` → adds pattern to deny grants, returns `{ block: true, reason: "user rejected (always)" }`
     - `{ outcome: { outcome: "cancelled" } }` → returns `{ block: true, reason: "user cancelled approval" }`
     - Timeout → returns `{ block: true, reason: "approval timed out (30s)" }`
   - Emits `tool_approval_response` lifecycle event with the decision

### Resolution priority (this is the engine that lands in 030)

The `evaluateToolCall(sessionId, toolName, args): ApprovalDecision` function applies in this order:

```
1. alwaysDeny match → deny  (alwaysDeny patterns are empty in 030; populated in 090)
2. alwaysAllow match → allow (same: empty in 030; populated in 090)
3. session grants — runtime in-memory map populated by allow_always replies → allow
4. per-tool override in PermissionPolicy.tools → returned decision
5. category default (from PermissionPolicy.categories[toolKindFor(toolName)]) → returned decision
6. mode preset's category default → returned decision
7. fallback "ask"
```

### `session/cancel` resolves pending approvals as rejected

When `session/cancel` is called (`src/acp/agent.ts:519-524`), the agent currently sets `session.runtime.cancelled = true` and calls `piAgent.abort()`. Extend cancellation to walk `session.runtime.pendingApprovals` and resolve each promise with `{ outcome: { outcome: "cancelled" } }`. This unblocks the suspended `beforeToolCall` returns and lets the cancellation propagate cleanly.

### Per-runtime approval UI

| Host | Approval surface | Trigger |
|---|---|---|
| **CLI** (`test-apps/cli/src/client/...`) | Inline prompt in the REPL: "Allow `bash:npm test`? [y/n/A/N]" (y=once, A=always, n=once, N=always). Reads via `readline`. While awaiting, status badge changes to "pending approval". | `requestPermission` handler in CLI's ACP-side connection |
| **HTTP** (`test-apps/http/src/client/...`) | React modal that pops up; user clicks one of four buttons. SSE stream pauses on the pending `tool_call_update`; modal opens when client receives the `requestPermission` request. | `requestPermission` handler in client/acp/* |
| **Browser worker** (`test-apps/browser/src/client/...`) | Same React modal as HTTP (likely shared via `app-utils/`); approval bubbles back over MessagePort. | `requestPermission` handler |
| **Chrome-ext** (`test-apps/chrome-ext/src/client/...`) | Reuses browser-app's React modal (subpath import from `@bodhiapp/bodhi-pi-test-app-browser/client/*`); optionally opens an extension popup if the user has the side panel closed. | Same |

Hosts share UI code via `test-apps/app-utils/` and `test-apps/browser/src/client/` (consumed by chrome-ext via subpath imports).

### Approval timeout: 30 seconds, configurable

`permission.approvalTimeoutMs` setting key. Read at session bootstrap into `session.runtime.approvalTimeoutMs`. Default `30000`. Test that overriding via `_bodhi-pi/session/settings/set` changes the timeout for the next pending approval.

### Test harness must change

The existing harness stub `requestPermission: async () => ({ outcome: { outcome: "cancelled" } })` will now cause every `ask` decision to be cancelled. Add a `harnessOpts.approvalResponses?: ApprovalResponse[]` queue + `harnessOpts.autoApproveAll?: boolean` toggle. Default `autoApproveAll: false` keeps existing tests strict.

**Crucially**, existing tests that invoke tools without realising they'll now hit `ask` will break. Triage rules:
- Tests about tool behaviour (e.g. `bash:ls` works): switch session to `edit` mode after `newSession` (skips approval for `edit` tools but still asks on `execute`) — or `allow-all` with capability — or set `autoApproveAll: true` in the harness opts
- Tests about specific approval flow: keep default `ask` mode, use the approval queue helper

Choose the simplest per-test fix. Mass-changing all tests to `allow-all` is wrong — it hides intent.

## Scope

### IN

| Change | File |
|---|---|
| Real `MODE_PRESETS` map with `ASK_PRESET` | `src/permissions/presets.ts` (replace placeholder) |
| Policy evaluator `evaluateToolCall` | `src/permissions/permission-service.ts` |
| Approval suspension flow (pendingApprovals Map, timeout, race with cancel) | `src/permissions/approval-flow.ts` (new file) |
| Per-session `permissionGrants` (in-memory) on `SessionState.runtime` | `src/sessions/session-state.ts` |
| Tool-call `status: "pending"` notification while awaiting approval | `src/acp/prompt-loop.ts` (extend `subscribeToAgent` if needed) |
| Wire `mode_change` reset of `permissionGrants` (when switching modes, clear category-tied grants) | `src/permissions/permission-service.ts` |
| `session/cancel` resolves pending approvals | `src/acp/agent.ts` |
| `permission.approvalTimeoutMs` setting key | `src/settings/...` |
| Test-harness `approvalResponses` queue + `autoApproveAll` toggle | `test/helpers/harness.ts` |
| `requestPermission` implementation in each of the 4 Hosts (CLI inline / browser modal / etc.) | `test-apps/{cli,http,browser,chrome-ext}/src/client/...` |
| `tool_approval_request` / `tool_approval_response` lifecycle events emitted on both rails | `src/permissions/permission-service.ts`, `src/acp/event-wiring.ts` |
| Update `ai-docs/specs/bodhi-pi/modes.md` row 030 = ☑ + full sequence diagram for approval flow | Edit |
| Update `ai-docs/specs/bodhi-pi/acp.md` — document `session/requestPermission` from Agent side, link to ACP spec for the type | Edit |
| Triage existing tests that break due to ask-mode-default + update affected tests | All existing `test/*.test.ts` that invoke tools |

### OUT

- `edit` / `plan` / `allow-all` presets (040 / 050 / 060)
- Persistent `alwaysAllow` / `alwaysDeny` patterns (090)
- `submit_plan` tool (050)
- Sub-agent inheritance rule (070)
- `setActiveTools` API (080)
- Mode-aware system-prompt suffix (small piece lands in 050 for plan mode)

## Implementation order (TDD across 7 steps)

### 1. `packages/bodhi-pi/test/permission-ask-mode.test.ts` (new — failing first)

Drives the design via faux provider + harness. Key cases:

```ts
describe("ask mode (default)", () => {
  it("read tool auto-allows in ask mode (no approval prompt)", async () => {
    const { clientConn, requestPermissionCalls } = createTestHarness({ ..., autoApproveAll: false });
    await clientConn.initialize(...);
    const s = await clientConn.newSession({ cwd: "/cwd" });
    // queue a faux tool round that calls `read`
    fauxProvider.queueResponse([{ toolCall: { name: "read", id: "t1", arguments: { path: "/cwd/foo" } } }]);
    await clientConn.prompt({ sessionId: s.sessionId, prompt: [{ type: "text", text: "read foo" }] });
    expect(requestPermissionCalls).toHaveLength(0); // read auto-allowed
  });

  it("edit tool triggers requestPermission with 4 options", async () => {
    const { clientConn, requestPermissionCalls, approveAllOnce } = createTestHarness({ ... });
    approveAllOnce();
    fauxProvider.queueResponse([{ toolCall: { name: "edit", id: "t1", arguments: { path: "/cwd/foo", oldText: "a", newText: "b" } } }]);
    await clientConn.prompt({ ... });
    expect(requestPermissionCalls).toHaveLength(1);
    expect(requestPermissionCalls[0].options.map(o => o.optionId).sort()).toEqual(["allow_always", "allow_once", "reject_always", "reject_once"]);
    expect(requestPermissionCalls[0].toolCall.toolCallId).toBe("t1");
  });

  it("allow_once executes the tool and does not persist", async () => {
    const { ... } = createTestHarness({ approvalResponses: [{ outcome: { outcome: "selected", optionId: "allow_once" } }] });
    // run two edits; expect 2 requestPermission calls (allow_once does not persist)
  });

  it("allow_always adds session grant; subsequent same-tool calls auto-allow", async () => {
    const { ... } = createTestHarness({ approvalResponses: [{ outcome: { outcome: "selected", optionId: "allow_always" } }] });
    // run two edits; expect 1 requestPermission call (second auto-allowed by grant)
    // verify a tool_approval_response event with kind: "allow_always"
  });

  it("reject_once blocks tool with reason 'user rejected'", async () => {
    // ...
  });

  it("reject_always adds session deny grant; subsequent same-tool calls auto-denied", async () => {
    // ...
  });

  it("requestPermission times out after 30s and the tool is rejected", async () => {
    // use vi.useFakeTimers; queue a slow approval handler that never resolves
  });

  it("session/cancel resolves pending approval as cancelled", async () => {
    // queue a slow approval handler; from another flow, call session/cancel
    // tool blocks with cancelled reason; session ends with stopReason: "cancelled"
  });

  it("tool_call_update fires with status 'pending' while awaiting approval", async () => {
    const { updates } = createTestHarness({ approvalResponses: [...]});
    // run prompt that triggers an edit
    const pending = updates.find(u => /* tool_call_update with status:"pending" */);
    expect(pending).toBeDefined();
  });

  it("mode_change clears category-tied session grants", async () => {
    // set up: allow_always on bash; verify grants populated
    // setSessionMode("plan"); verify grants cleared
  });

  it("permissionGrants are per-session (not shared across sessions)", async () => {
    // two sessions; allow_always in session A; verify session B still asks
  });

  it("permission.approvalTimeoutMs setting overrides default 30s", async () => {
    // set permission.approvalTimeoutMs to 100ms via /settings; verify quick timeout
  });
});
```

### 2. `packages/bodhi-pi/e2e/permission-ask-mode.e2e.ts` (new)

Real `gpt-4o-mini` round-trip. The e2e calls `setSessionMode("ask")` (default), gives the model a prompt that should make it call `write` or `bash`, asserts that `conn.requestPermission` was actually invoked. Use an `eventRecorder`-style helper to capture the approval round-trip.

```ts
it("real LLM asking to edit triggers approval round-trip", async () => {
  // ... seed-auth, real client, /mode ask
  await client.prompt({ ..., prompt: [{ type: "text", text: "create file foo.txt with content hello" }] });
  expect(recordedApprovalRequests.length).toBeGreaterThan(0);
});
```

### 3-4. Node + browser adapters

No adapter shape change needed. The approval flow is entirely in `src/permissions/` + Host client code.

### 5. CLI e2e: `test-apps/cli/e2e/approval-cli.e2e.ts`

```ts
it("CLI prompts user, types y, edit succeeds", async () => {
  // spawn cli with seeded auth + cwd
  // prompt: "create file note.txt with hello"
  // wait for prompt "Allow `write:/.../note.txt`? [y/n/A/N]"
  // send "y\n"
  // verify file written
});

it("CLI prompts user, types n, edit blocked", async () => { ... });
it("CLI types A (allow always for this session)", async () => { ... });
```

CLI client implementation (`test-apps/cli/src/client/acp/...`):

```ts
const clientHandler: ClientHandler = {
  // ... existing handlers ...
  requestPermission: async (params) => {
    const label = formatToolCall(params.toolCall);
    showStatus(`pending approval: ${label}`);
    const answer = await readline.question(`Allow ${label}? [y(once)/A(always)/n(once)/N(always)] `);
    cleanStatus();
    const map: Record<string, string> = { y: "allow_once", A: "allow_always", n: "reject_once", N: "reject_always" };
    const optionId = map[answer.trim()];
    if (!optionId) return { outcome: { outcome: "cancelled" } };
    return { outcome: { outcome: "selected", optionId } };
  },
};
```

### 6. Playwright: `test-apps/browser/e2e/approval-browser.spec.ts` + `test-apps/chrome-ext/e2e/approval-chrome-ext.spec.ts`

```ts
test("modal pops up, user clicks Allow once, tool runs", async ({ page }) => {
  await page.goto(BASE_URL);
  // /mode is ask by default
  await sendPrompt(page, "create foo.txt");
  // wait for modal
  await expect(page.getByTestId("approval-modal")).toBeVisible();
  await page.getByTestId("approval-allow-once").click();
  // verify tool completed in the transcript
  await expect(page.getByText(/foo.txt/)).toBeVisible();
});

test("modal pops up, user clicks Allow always, second call auto-runs without modal", async ({ page }) => { ... });
test("modal pops up, user clicks Reject once", async ({ page }) => { ... });
test("modal pops up, user closes the panel (cancel)", async ({ page }) => { ... });
```

Browser client implementation (`test-apps/browser/src/client/acp/...`): React modal component + handler. UI state machine: idle → pending(request) → idle. Modal data-testids per `feedback_bodhi_pi_e2e_layout`.

Chrome-ext consumes the same modal via subpath import. Chrome-ext-specific: if the side panel is closed, optionally open a notification (defer this nicety to a follow-up; the modal-in-current-panel path is enough).

### 7. HTTP integration: `test-apps/http/test/integration/approval-http.test.ts`

```ts
it("per-turn-rebuild — approval round-trip works across rebuild boundary", async () => {
  // POST /sessions, POST /prompt (returns SSE with pending tool_call_update)
  // Client modal would be in browser; here we directly POST /approve
  // (the HTTP host's bridge between requestPermission and its frontend
  //  goes through a session-scoped SSE channel + a POST /approve endpoint)
});
```

HTTP host's `requestPermission` implementation needs to bridge the agent (server) and the browser (client) via two endpoints:
- SSE stream forwards `requestPermission` to the browser as a synthetic JSON message
- POST `/sessions/:id/approve` accepts the response from the browser, routes back to a pending Promise in the server's `requestPermission` handler

(If this is too heavy for one milestone, the HTTP host can stub out `requestPermission` with auto-allow for integration tests and the real bridge can land in a follow-up commit. Mark as a known limitation in the milestone commit message and the http host's CLAUDE.md.)

## Per-runtime impact

| Host | Surfaces in 030 |
|---|---|
| cli | Inline approval prompt in REPL; status badge change; updated `/mode` slash continues from 020 |
| http | Server SSE-forwarded `requestPermission`; POST `/approve` route; browser frontend React modal; (or stub with auto-allow if real bridge defers) |
| browser | React modal in client UI; subscribes to MessagePort `requestPermission` invocations |
| chrome-ext | Same modal as browser via subpath import |

## Tests summary

| Test type | Count | New file |
|---|---|---|
| Integration | ~12 cases | `permission-ask-mode.test.ts` |
| e2e (real LLM) | 1 case | `permission-ask-mode.e2e.ts` |
| CLI e2e | 3 cases | `test-apps/cli/e2e/approval-cli.e2e.ts` |
| Browser playwright | 4 cases | `test-apps/browser/e2e/approval-browser.spec.ts` |
| Chrome-ext playwright | 3 cases | `test-apps/chrome-ext/e2e/approval-chrome-ext.spec.ts` |
| HTTP integration | 1-2 cases | `test-apps/http/test/integration/approval-http.test.ts` |
| **Existing test triage** | ~variable | Update each test that hits a tool in default `ask` mode. Likely 10-15 files need a one-line `await client.setSessionMode({ sessionId, modeId: "edit" });` after `newSession`. |

## Gate checks

- `npm run check`
- `npm test` (all existing + new pass; existing test triage is the bulk of the cleanup)
- `just test-e2e`
- `just test-e2e-ui`

## Commit message

```
bodhi-pi modes 030: ask mode + native ACP requestPermission across 4 runtimes

Wire the policy engine: PermissionService.evaluateToolCall reads
mode preset + per-category + per-tool + session grants in priority order.
The ask preset auto-allows read+search and asks for edit/execute/mcp/subagent.
Ask decisions invoke conn.requestPermission with 4 options (allow_once,
allow_always, reject_once, reject_always); the await suspends the tool call
via the existing beforeToolCall hook; allow_always populates an in-memory
SessionState.runtime.permissionGrants (persistent rules land in 090).
30s configurable approval timeout; session/cancel resolves pending approvals
as cancelled.

Each of the four reference Hosts implements requestPermission Client-side:
CLI inline prompt, browser+chrome-ext React modal, HTTP SSE→modal bridge
with a POST /approve route. Tool-call cards show status:"pending" while
awaiting approval.

Existing tests that invoke tools in default ask mode were updated to either
switch to edit mode (when the test is about tool behaviour, not approval)
or use the new approvalResponses queue helper in createTestHarness.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

## Interactions with other features

- **Sub-agents**: child sessions in 030 inherit parent's mode (effectively); the formal Qwen rule lands in 070. In 030, a sub-agent in `ask` mode that calls an edit tool will trigger an approval prompt that bubbles to the parent's UI (because the child's `conn` is the same as the parent's). Verify this via test.
- **MCP**: MCP tools (category `mcp`) ask by default in `ask` mode. The `requestPermission` UI shows the namespaced name (`<slug>__<tool>`). Future milestone (out of scope here) adds per-MCP-server overrides.
- **Skills**: Skills with `allowed-tools` in their frontmatter — milestone 030 does NOT yet enforce this. Skills that invoke tools go through the same `tool_call` path; the policy engine treats them like any tool call. `allowed-tools` enforcement is a follow-on.
- **Extensions**: extensions that register tools (`pi.registerTool`) go through the same `beforeToolCall` hook, so their tools are policy-gated too. Extension-tool categories: an extension's tool name doesn't match any builtin → `toolKindFor` returns `"other"`. The default for `"other"` in `ask` preset must be defined — likely `ask`. Document.
- **Compaction**: when compaction runs, the LLM may call tools as part of summarisation — but compaction has its own model + no user UI. Policy should NOT gate compaction-internal tool calls. Add a `bypassPermissions: boolean` flag on `CompactionOrchestrator` that the PermissionService respects (skip policy for that session-scoped invocation). Verify via test.
- **Settings**: `permission.approvalTimeoutMs` joins the settings keys reported by `_bodhi-pi/session/settings/list`.

## Risks

- **Risk**: `pi-agent-core` may not honour the suspended `beforeToolCall` for arbitrary durations (e.g. internal timeout). **Mitigation**: verify with a 60s sleep test; if pi-agent-core has its own timeout, lobby upstream or work around by returning quickly and re-issuing approval-needed signals.
- **Risk**: HTTP per-turn-rebuild loses pendingApprovals map on rebuild. **Mitigation**: per-turn-rebuild also loses the in-flight prompt, so pending approvals are naturally void. The next turn re-issues if needed. Document in `http/CLAUDE.md`.
- **Risk**: Modal-blocking UX in browser conflicts with users wanting to keep working. **Mitigation**: modal is non-blocking (user can dismiss to cancel); approval state visible in tool-call card; allow user to scroll transcript while modal is open.
- **Risk**: `setActiveTools` from 080 is needed to make `ask` mode less noisy (LLM doesn't try to call denied tools at all in plan mode). 030 works without it but with a worse UX. **Mitigation**: accept the cost in 030; 080 fixes it.

## Definition of done

- [ ] All IN rows implemented
- [ ] `ask` preset enforces decisions
- [ ] `requestPermission` round-trip works in all 4 Hosts
- [ ] 30s timeout enforced (test passes)
- [ ] `session/cancel` resolves pending approvals
- [ ] All existing tests pass (with triage applied)
- [ ] All new tests pass
- [ ] `npm run check`, `npm test`, `just test-e2e`, `just test-e2e-ui` all green
- [ ] `modes.md` row 030 = ☑ + sequence diagram added
- [ ] `acp.md` updated with `requestPermission` Agent-side details
- [ ] Single commit (or tight sequence — split per Host if individually green)
