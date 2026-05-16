# bodhi-pi MCP: global connection state + per-session inclusion

## Context

bodhi-pi's MCP layer conflates three things into one: the persisted *record*, the live *connection*, and the per-session *visibility* of an MCP. `McpRegistry` keys `Map<sessionId, Map<slug, ConnectedMcp>>`, so "connected" is implicitly session-local. The consequence: in `bodhi-pi-http`'s per-request agent rebuild, ephemeral MCPs declared via ACP-native `session/new { mcpServers: [...] }` cannot be reconstructed — there is no kv breadcrumb for an ephemeral, and the in-memory registry dies with the agent. The result is `mcp-public-http.e2e.ts:111-137` being skipped under http.

The fix matches how Claude Code, Cursor, and other agentic clients model MCPs: **connections are owned globally (one per `<user, slug>`), and per-session visibility is a thin inclusion set on top**. Ephemeral session/new MCPs get promoted to kv records (so the http rebuild can rehydrate them) and the http skip dissolves naturally.

Decisions confirmed with the user:
- **Direction A — dedicated subsystem.** No new built-in-extension pattern; smallest delta.
- **Inclusion set is NOT persisted** — re-derived from latest `session/new|load|resume`'s `mcpServers` param each time `hydrate()` runs.
- **No auto-include after `/mcp connect`** — require explicit `/mcp include`. Snapshot semantics.
- **Second MCP for tests is public http-streamable** — deepwiki (`https://mcp.deepwiki.com/mcp`) or exa (`https://mcp.exa.ai/mcp`). NOT uvx stdio. Lets the multi-MCP e2es run across all 6 runtimes instead of just node-stdio runtimes.

---

## The six primitives + session-init bundle

| Op | Record (kv) | Connection (global) | Inclusion (per session) |
|---|---|---|---|
| `_bodhi-pi/mcp/add` | **persist** | — | — |
| `_bodhi-pi/mcp/connect <slug>` | — (must exist) | **establish** (idempotent) | — |
| `_bodhi-pi/mcp/include <slug>` (NEW) | — (must exist; error if not) | — (no auto-connect; tools surface only when also connected — orphan-tolerant) | **add** |
| `_bodhi-pi/mcp/exclude <slug>` (NEW) | — | — | **remove** (no-op if absent) |
| `_bodhi-pi/mcp/disconnect <slug>` | — | **close** | — (inclusion stays; tools just disappear) |
| `_bodhi-pi/mcp/remove <slug>` | **delete** | **close** | — (orphan in inclusion is fine) |
| `_bodhi-pi/mcp/reconnect <slug>` | — | disconnect+connect | — |

ACP-native `mcpServers` on `session/new|load|resume`:
- `undefined` → inclusion = all currently-connected slugs (snapshot at hydrate time)
- `[]` → inclusion = empty
- `[A, B, ...]` → persist each entry to kv if missing; connect each globally if missing; inclusion = exactly `{A, B}`

Idempotency rules: `/mcp include` of already-included slug = no-op. `/mcp exclude` of absent slug = no-op. `/mcp connect` of already-connected = no-op (existing behavior preserved). `/mcp include` of a slug whose global connection is currently down = succeeds; tools materialize on the next successful `/mcp connect`.

---

## Architecture

### New ownership in `src/mcp/`

`McpRegistry` (rewrite):
```
class McpRegistry {
  private bySlug = new Map<slug, ConnectedMcp>();
  private inclusion = new Map<sessionId, Set<slug>>();
  constructor(sessions: Map<sessionId, SessionState>) {}

  // global mutations
  addConnection(slug, client, toolInfos, close) → fan out applyToAllSessions()
  removeConnection(slug) → close + fan out applyToAllSessions()
  hasConnection(slug)
  getConnection(slug)

  // per-session inclusion
  setInclusion(sessionId, slugs: Set<slug>) → applyToSession(sessionId)
  addInclusion(sessionId, slug) → applyToSession(sessionId)
  removeInclusion(sessionId, slug) → applyToSession(sessionId)
  getInclusion(sessionId): Set<slug>
  clearInclusion(sessionId)  // on session close

  // tool fan-out
  applyToSession(sessionId)  // mergeTools(session.tools, includedAndConnectedTools(sessionId))
  applyToAllSessions()       // iterate sessions.keys()
}
```

Tool surface for a session = `mergeTools(session.tools, union over included-AND-connected slugs of ConnectedMcp.tools)`. Orphan slugs in inclusion (included but not currently connected) contribute zero tools — no error, no warning.

### McpService (rewrite)

Remove `sessionId` from connect / disconnect / reconnect / oauth-finish — these are global. Keep `sessionId` on `tools` (reads the session's visible set), `include`, `exclude`. `mcpServers` is no longer threaded through these ops.

New signature:
```
hydrate(sessionId, ephemeral: McpServer[] | undefined):
  1. For each `ephemeral` entry not in kv → persist via fromAcpMcpServer + slug (sanitizeSlugForAcp)
  2. For each kv entry with lastKnownStatus="connected" that is NOT in bySlug → connect globally
  3. For each `ephemeral` entry's slug not in bySlug → connect globally
  4. Compute inclusion based on `ephemeral`:
     - undefined  → registry.setInclusion(sid, all bySlug.keys())
     - []         → registry.setInclusion(sid, ∅)
     - [A,B,...]  → registry.setInclusion(sid, {slugs of those entries})
  5. applyToSession runs implicitly via setInclusion
```

`closeSession(sessionId)`: ONLY `registry.clearInclusion(sessionId)`. **Does NOT close global connections** in long-lived agents (cli, ws-server, browser-worker, in-memory). The agent's own lifecycle owns global connections; per-request hosts (http) GC them naturally.

Global mutations (`connect`, `disconnect`, `remove`, `reconnect`, async transport-close): emit `mcp_status_change` once per session in `sessions.keys()` (preserves the existing event/wire shape — UI sees its session's MCP "changed"). Same for `mcp_tools_change`.

### Async transport close

Wire `client.onclose` (MCP SDK) inside `connectMcp` to call back into `McpService.handleTransportClose(slug)` which: removes from bySlug, emits per-session `mcp_status_change: "disconnected"`, calls `applyToAllSessions()`. Without this, a dropped transport silently leaves stale tools in every including session. (Edge case (c) from the pressure-test.)

### Two new wire constants

In `packages/bodhi-pi/src/wire/constants.ts`:
```
export const EXT_MCP_INCLUDE = "_bodhi-pi/mcp/include";
export const EXT_MCP_EXCLUDE = "_bodhi-pi/mcp/exclude";
```

Plumbed through `mcp-service.ts` register() and into the client class used by the slash dispatchers.

---

## Files to modify

| Path | Change |
|---|---|
| `packages/bodhi-pi/src/mcp/mcp-registry.ts` | Rewrite per the structure above |
| `packages/bodhi-pi/src/mcp/mcp-service.ts` | New `hydrate()` semantics; drop sessionId from connect/disconnect/reconnect/oauth-finish; add `handleInclude`/`handleExclude`; iterate sessions for events |
| `packages/bodhi-pi/src/mcp/mcp-client.ts` | Wire `onclose` callback into McpService handleTransportClose |
| `packages/bodhi-pi/src/wire/constants.ts` | Add `EXT_MCP_INCLUDE`, `EXT_MCP_EXCLUDE` |
| `packages/bodhi-pi/src/acp/agent.ts` | No structural change at L332/414/431 (still calls `mcpService.hydrate(sid, params.mcpServers)`); L462/478 stop touching mcp connections (only `registry.clearInclusion(sid)`) |
| `packages/bodhi-pi/test-apps/http/src/server/acp/handler.ts:168` | `mcpServers: []` → `mcpServers: undefined` |
| `packages/bodhi-pi/test-apps/http/src/server/acp/handler.ts:239` | Same fix on SSE path |
| `packages/bodhi-pi/test-apps/cli/src/repl/headless.ts:187` | `mcpServers: []` → omit (undefined). Add `/session new` + `/session switch <id>` slashes (~25 lines) for multi-session e2e |
| `packages/bodhi-pi-cli/src/repl/commands.ts` | Add `/mcp include <slug>` + `/mcp exclude <slug>` branches; drop sessionId from connect/disconnect/reconnect calls in client wrapper |
| `packages/bodhi-pi/test-apps/browser/src/ui-lib/ui/commands.ts` | Same dispatcher additions |
| `packages/bodhi-pi/test-apps/cli/src/repl/headless.ts` | Add `/mcp include`, `/mcp exclude` to `tryHandleSlash` |
| `packages/bodhi-pi-cli/src/client/*` (or wherever `createBodhiPiClient` lives) | New client methods `mcpInclude({slug, sessionId})`, `mcpExclude({slug, sessionId})`; update `mcpConnect/Disconnect/Reconnect/OAuthFinish` signatures to drop sessionId |

`EventDispatcher`, `event-wiring.ts`, `events/types.ts`, `ExtensionRunner` — **no changes**. `mcp_status_change` and `mcp_tools_change` event shapes stay identical; we just emit them more times (once per session) for global mutations.

---

## Test changes

### Updates to existing tests (must continue to pass)

- `packages/bodhi-pi/test/mcp.test.ts` — handlers no longer require sessionId for connect/disconnect/reconnect; flows that asserted per-session-isolation now assert global+inclusion.
- `packages/bodhi-pi/test/mcp-http-integration.test.ts`, `mcp-stdio-integration.test.ts` — same wire-signature update.
- `packages/bodhi-pi/e2e/shared/mcp-public-http.e2e.ts` lines 18-56 (control plane): add `/mcp include` step between connect and tools-assertion. Lines 58-107 (LLM prompt): same insertion. Lines 111-137 (was skipped): **drop the runIf skip**, flip line 135 to `expect.soft(kvList.entries.find(e => e.key === \`mcp/${slug}\`)).toBeDefined()`, add a second `mcpTools` call to prove rehydrate-from-kv survives the http rebuild.
- `packages/bodhi-pi/e2e/shared/mcp-stdio.e2e.ts` — add include step in the control-plane and LLM tests; rejection test (`supportsMcpStdio: false`) unchanged.
- `packages/bodhi-pi/e2e-ui/shared/mcp-public-http.spec.ts` — Playwright slash flow: add `/mcp include` step between connect and tools assertion.
- `packages/bodhi-pi/e2e/cli-headless/mcp.e2e.ts` + `mcp-stdio.e2e.ts` — add `/mcp include` in the sequence; the existing `expect.soft` flow is otherwise unchanged.
- `packages/bodhi-pi-cli/test/` — REPL unit tests on `/mcp*` get the new include/exclude branches plus client-signature update.

### New test files

`packages/bodhi-pi/e2e/shared/mcp-multi.e2e.ts` (NEW, 4 scenarios, gpt-4o-mini, single flow-consolidated harness):

1. **Two MCPs, partial inclusion.** Add mcp-everything + deepwiki, connect both globally, new session with `mcpServers: [everything]`. Agent sees `get-sum`, not deepwiki tools. `/mcp include deepwiki` → sees both.
2. **Empty-array semantic.** Connect mcp-everything globally, new session with `mcpServers: []`. Session sees zero MCP tools. Confirm via `mcpTools`.
3. **Include of unknown slug errors.** `/mcp include nonexistent` → RequestError -32602.
4. **LLM-prompt across two MCPs.** Connect mcp-everything + deepwiki. Prompt asks for `get-sum(20, 22)` AND a deepwiki-flavored query. Assert both tool_calls occur and 42 streams back. (Picked from the prompt's scenario 7.)

`packages/bodhi-pi/e2e/cli-headless/mcp-multi-session.e2e.ts` (NEW, in-memory + cli only):

5. **Cross-session propagation.** `/session new` to create session B in same cli process. Connect mcp-everything (in session A). Confirm A sees it (since A defaulted to undefined → include-all-connected at hydrate time… wait: A was created BEFORE the connect, so A's snapshot was empty → A doesn't see it. Adjust: connect mcp-everything FIRST, then create sessions A and B with `mcpServers: undefined` → both see it. Then `/mcp disconnect` from B's session → both A and B lose tools immediately, and a second `/mcp tools` from A returns empty). This validates global-disconnect fan-out to all sessions' tool lists.

`packages/bodhi-pi/e2e-ui/shared/mcp-multi.spec.ts` (NEW, Playwright):

6. Mirror scenarios 1 and 2 through the chat composer slash commands. Two `/mcp add` then `/mcp connect` then `/session new` (or omit since UI handles one session per page) and assert tool visibility via `data-mcp-event` locators.

### Test fixture changes

`packages/bodhi-pi/e2e/global-setup.ts`: no new spawn. deepwiki/exa are public hosted endpoints — added as env vars `BODHI_PI_E2E_DEEPWIKI_URL=https://mcp.deepwiki.com/mcp` and gated identically to `BODHI_PI_E2E_MCP_EVERYTHING_HTTP_URL`. Skip multi-MCP tests if the deepwiki endpoint is unreachable (curl HEAD in global-setup; one `runIf` gate).

`packages/bodhi-pi/e2e-ui/global-setup.ts`: same env-var addition.

---

## Out of scope (per user / prompt)

- OAuth-DCR e2e-ui — foundational machinery (`KvOAuthProvider`, `EXT_MCP_OAUTH_START/FINISH`) preserved but tests not extended.
- Process-wide connection cache for http (cross-request `(userId, slug)` sharing) — design must work correctly without it; revisit only if measured.
- New status states (`connecting`, `auth-required`) — keep `connected | disconnected | error`.
- Tool-name collision warnings on include — slug namespacing (`<slug>__<tool>`) already disambiguates.
- `/mcp add` race on simultaneous same-URL adds — preexisting latent bug, document not fix.

---

## Verification

1. Build: `npm run build -w @bodhiapp/bodhi-pi -w @bodhiapp/bodhi-pi-node -w bodhi-pi-cli -w bodhi-pi-http -w bodhi-pi-ws-server` (all four reference hosts must compile).
2. Unit + integration: `cd packages/bodhi-pi && npm test` (covers `test/mcp*.test.ts`, `src/mcp/*.test.ts`).
3. Per-runtime e2e (vitest projects in `packages/bodhi-pi/e2e/`):
   - `npm run test:e2e -- --project=in-memory`
   - `npm run test:e2e -- --project=cli`
   - `npm run test:e2e -- --project=http` — **the previously-skipped mcp-public-http test must pass now**
   - `npm run test:e2e -- --project=ws`
4. Playwright: `npm run test:e2e-ui` (http + ws + browser + chrome-ext UI surfaces; new `mcp-multi.spec.ts` runs across 4 runtimes).
5. LLM-prompt smoke (load-bearing behavioral contract): the new "two MCPs in one prompt" e2e must show `get-sum(20, 22) = 42` and a deepwiki tool_call in the same turn.

End-to-end fidelity gate before commit: `npm run build && npm test && npm run test:e2e` clean across all six runtimes; zero `test.runIf(!isRuntime("http"))` skips remaining in the MCP suite.

## Deliverable shape

Two commits:

1. **Refactor.** New `McpRegistry` + `McpService` + transport-close wiring + two new wire constants + handler.ts:168/239 + headless.ts:187 + slash dispatcher additions (cli REPL, browser UI, headless) + client.ts signature update. Existing tests updated to insert `/mcp include` step. http skip dropped.
2. **New-semantics tests.** `mcp-multi.e2e.ts`, `mcp-multi-session.e2e.ts`, `mcp-multi.spec.ts`, deepwiki env-var plumbing in global-setup.
