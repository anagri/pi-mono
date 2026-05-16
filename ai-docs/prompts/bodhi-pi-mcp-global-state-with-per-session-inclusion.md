# Prompt: refactor MCP into global connection state + per-session inclusion

## Goal

Reshape bodhi-pi's MCP integration so that **MCP connections are owned globally (at the user scope)** and **per-session visibility is a thin inclusion set on top**. This matches how Claude Code, Cursor, and other agentic clients model MCPs: connect once, available everywhere, with the option to scope per-session.

The current implementation conflates the two — `McpRegistry` is keyed by `sessionId`, and "connected" is implicitly a session-local property. The result is that the ACP-native ephemeral `mcpServers` test under `bodhi-pi-http` fails (currently skipped), because the per-request agent rebuild has no way to reconstruct ephemeral MCPs from kv. The architectural fix dissolves that skip naturally.

This prompt does **not** prescribe a design. It hands you the goal, the model, the existing code, and the boundary tests. You should read the code yourself, ask clarifying questions before you commit to a design, and present an implementation plan before writing code. Use the `AskUserQuestion` tool freely.

---

## The mental model the user wants

There are three orthogonal things, all of which today are tangled into one:

1. **MCP record** — persisted under `mcp/<slug>` in kvStore. The "I know about this server" facet. Survives across sessions and process restarts.
2. **MCP connection** — a live network connection to the MCP server (HTTP-streamable or stdio child). Owned globally (one per `<user, slug>` pair); shared by every session that includes the MCP.
3. **Per-session inclusion set** — the set of slugs whose tools the agent in that session should currently see. A subset of "MCPs currently connected globally".

"User" here means: the auth principal in multi-tenant runtimes (`bodhi-pi-http`, `bodhi-pi-ws-server`); the process owner in single-tenant runtimes (`cli`, `browser`, `chrome-ext`, `in-memory`). The kvStore in each runtime is already user-scoped (see `wire-agent.ts` for the per-user path setup), so "global" = "global within the kvStore namespace".

---

## The six primitive operations (no hidden behavior)

The user was explicit: ship **basic constructs**; clients orchestrate higher-level flows. Each operation mutates exactly one of {record, connection, inclusion-set}, never more.

| Op | Record | Connection | Inclusion |
|---|---|---|---|
| `/mcp add` | **persist new** | untouched | untouched (NOT auto-included in issuing session) |
| `/mcp connect <slug>` | untouched (must already exist) | **establish** (idempotent) | untouched |
| `/mcp include <slug>` | untouched (must already exist; errors if record missing) | untouched (if not connected, mcp simply shows as disconnected to the agent — no auto-connect) | **add to current session's set** |
| `/mcp exclude <slug>` | untouched | untouched | **remove from current session's set** |
| `/mcp disconnect <slug>` | untouched | **close** | untouched (slug stays in every session's inclusion set; tool calls will fail until reconnected) |
| `/mcp remove <slug>` | **delete** | **close** | untouched (slug stays in every session's inclusion set; subsequent reads will surface "unknown mcp" until re-added) |

That asymmetry — disconnect/remove deliberately *don't* exclude from sessions — is intentional. The user said: clients orchestrate. If a UI wants to "remove cleanly", it issues exclude-from-all-sessions + remove. Don't bury orchestration in primitives.

### ACP-native `mcpServers` on `session/new`, `session/load`, `session/resume`

| `mcpServers` value | Behavior |
|---|---|
| **omitted (`undefined`)** | include every globally-connected MCP in this session |
| **`[]` (empty array)** | exclude all — this session sees no MCPs even if some are connected globally |
| **`[...non-empty]`** | include exactly these; any that are not yet connected get connected (and their record is persisted if not already); MCPs not in this list are excluded from *this session* only (do not touch other sessions' state, do not disconnect) |

This is the architectural fix for the current http skip: ephemeral MCPs from `session/new` become persisted (kv record + connection); only the **inclusion set** is session-scoped. Once that's true, the per-request http rebuild has everything it needs from kv to reconstruct.

---

## Cross-session propagation

In long-lived agents (cli, ws, in-memory, browser worker) one agent process holds many sessions in `BodhiPiAcpAgent.sessions: Map<string, SessionState>`. When session A disconnects an MCP, session B (alive in the same agent) needs to see its tools disappear immediately — otherwise B's agent loop will hallucinate tool calls that the LLM is told about but that the runtime can't satisfy.

In the per-request agent runtimes (http), there's only ever one session in the agent's map at a time (the one for the current request). Cross-session propagation reduces to "rebuild from kv on each request" — which kvStore already supports.

So you need an **in-agent event/observer mechanism** that lets all `SessionState`s in a single agent process react to global MCP mutations. The existing `EventDispatcher` already emits `mcp_status_change` events scoped by `sessionId`. You'll likely need a few new event types (or a generalization) that are **agent-scoped, not session-scoped** — fired once and consumed by every session's tool-list rebuild.

**Two design directions to weigh** (not prescriptive — please evaluate both, sketch both, then propose):

- **Direction A: dedicated subsystem**. Refactor `McpService` + `McpRegistry` so the registry is `Map<slug, ConnectedMcp>` (agent-scoped) plus a parallel `Map<sessionId, Set<slug>>` (inclusion sets). Add internal "global mutation" events; wire them in `event-wiring.ts` to update every session's `piAgent.state.tools` via `mergeTools(session.tools, includedMcpTools(sessionId))`.
- **Direction B: built-in extension**. Bodhi-pi already has an `ExtensionRunner` + `ExtensionAPI` surface. Could the MCP layer become a first-party built-in extension that the agent auto-attaches? Extensions already get `pi.on(eventType, handler)` callbacks. The "auto-attached built-in" pattern might give you cross-cutting state ownership without bolting on a new subsystem. Worth sketching.

Both directions need: a single owner for the connection map, a way to broadcast mutations to all live sessions, and a per-session inclusion filter applied to the running `piAgent.state.tools`.

---

## Multi-user implications

In `bodhi-pi-test-app-http`, every HTTP request constructs a fresh `BodhiPiAcpAgent` scoped to the authenticated user (see `wire-agent.ts:107` — `wireAgentForRequest(opts.user, opts.dataDir, opts.db, ...)`). The kvStore is per-user (`{dir: kvStoreDir/<userId>}`). So:

- Two requests from the same user → distinct agent instances but **same kvStore** (so persistence aligns).
- Two requests from different users → distinct agent instances and **distinct kvStores** (full isolation).

What this means for connections: the global MCP connection map cannot literally be a process-wide singleton — it has to be agent-scoped (so per-user, per-request in http). Within a single agent's lifetime, the connection map is shared by all sessions in that agent. Across requests from the same user under http, connections are re-established from kv on each request (no in-process sharing). This is fine as long as kv carries enough state to rebuild.

A nice-to-have for http: a process-wide connection cache keyed by `(userId, slug)` to avoid the per-request reconnect cost. **Out of scope** unless you measure it as a real problem; the design must work correctly without it.

---

## What needs to remain working

The committed test suites must still pass after the refactor. You may rewrite them to match new semantics where required (and you'll need to add the new-semantic tests), but don't regress the existing coverage:

- `packages/bodhi-pi/test/mcp.test.ts` — service-level kv + extension method round-trip
- `packages/bodhi-pi/test/mcp-http-integration.test.ts` — real mcp-everything over http-streamable
- `packages/bodhi-pi/test/mcp-stdio-integration.test.ts` — real mcp-everything over stdio
- `packages/bodhi-pi/src/mcp/*.test.ts` — slug + types + OAuth provider unit tests
- `packages/bodhi-pi/e2e/shared/mcp-public-http.e2e.ts` — 6-runtime e2e (currently 1 skipped under http — that skip should disappear in the new model)
- `packages/bodhi-pi/e2e/shared/mcp-stdio.e2e.ts` — stdio across 6 runtimes
- `packages/bodhi-pi/e2e-ui/shared/mcp-public-http.spec.ts` — 4-runtime Playwright through chat composer
- `packages/bodhi-pi/e2e/cli-headless/mcp.e2e.ts` + `mcp-stdio.e2e.ts` — cli e2e-ui via stdin/stdout
- `packages/bodhi-pi-cli/test/` — cli unit tests touching `/mcp*` REPL commands

The LLM-prompt sum test (`get-sum(20, 22) = 42`) is the load-bearing behavioral contract: after refactor, the prompt path must still work everywhere it works today.

---

## New tests to add

Multi-MCP and cross-session scenarios. Use `@modelcontextprotocol/server-time` as the second MCP (the user has approved `uvx` availability). Local checkout at `/Users/amir36/Documents/workspace/src/github.com/modelcontextprotocol/servers/src/time/`. Hosted via `uvx mcp-server-time`. Use it to assert tool isolation (sum-tool from mcp-everything must not clash with time tools from server-time).

Suggested scenarios (you should think through what else is needed):

1. **Two MCPs added, only one included.** Add A and B (both connected globally). New session with `mcpServers: [A]`. Agent sees A's tools, not B's. Send `/mcp include B`. Agent now sees both.
2. **Cross-session propagation in a long-lived agent.** Two sessions in the same cli agent. Session 1 disconnects A. Session 2's tool list immediately drops A's tools. (This test runs only under runtimes that have multi-session-per-agent: in-memory and cli; ws holds one session per connection but can be exercised by holding two connections in the same process.)
3. **`session/new` ephemeral path under http (was skipped).** Drop the skip; the test should pass once `mcpServers: [{...}]` on `session/new` persists the MCP and sets the session's inclusion set.
4. **Empty array semantic.** `session/new { mcpServers: [] }` with one globally-connected MCP → session sees zero MCP tools.
5. **`/mcp include` errors when slug not in kv.** Explicit error rather than silently succeeding.
6. **`/mcp remove` leaves inclusion sets dirty.** After remove, other sessions still have the slug in their inclusion set; tool-list rebuild filters it out (or surfaces "unknown mcp" state — exact behavior to confirm).
7. **LLM-prompt across two MCPs.** Connect mcp-everything (`get-sum`) and server-time (`get_current_time`). Prompt: "what time is it AND what's 20 + 22?" — verify both tool_calls happen and answers stream back.

For e2e-ui, mirror at least scenarios 1 and 4 through the slash command UI and Playwright.

---

## Files to read first (load-bearing today)

| Path | Why |
|---|---|
| `packages/bodhi-pi/src/mcp/mcp-service.ts` | Current dispatcher, `hydrate()`, all 9 ext handlers |
| `packages/bodhi-pi/src/mcp/mcp-registry.ts` | Per-session map today; this is the structure that gets inverted |
| `packages/bodhi-pi/src/acp/agent.ts` | `sessions: Map<string, SessionState>`, ext-handler wiring, hydrate call sites at L332/L414/L431, close/delete teardown at L458/L474 |
| `packages/bodhi-pi/src/events/dispatcher.ts` | `EventDispatcher` — per-agent today |
| `packages/bodhi-pi/src/events/types.ts` | All event types; `mcp_status_change` already exists but is untyped in the union (mcp-service.ts:277 emits via `Record<string, unknown>` cast) |
| `packages/bodhi-pi/src/acp/event-wiring.ts` | Pattern for wiring internal events to ACP `sessionUpdate` notifications — model for cross-session tool-list refresh |
| `packages/bodhi-pi/src/extensions/runner.ts` + `types.ts` | The built-in-extension direction; how `ExtensionAPI.on()` and `registerTool()` work |
| `packages/bodhi-pi/test-apps/http/src/server/agent/wire-agent.ts` | Per-user, per-request agent build — `supportsMcpStdio: false`, kvStore per-user dir |
| `packages/bodhi-pi/test-apps/http/src/server/acp/handler.ts:166-169` | The hardcoded `resumeSession({mcpServers: []})` that loses ephemeral state today |
| `packages/bodhi-pi-cli/src/repl/commands.ts` | Where the `/mcp*` slashes live (search for `case "/mcp":` and `/mcps`) |
| `packages/bodhi-pi/test-apps/browser/src/ui-lib/ui/commands.ts` | Browser slash dispatcher; mirrors cli `/mcp*` |
| `packages/bodhi-pi/test-apps/cli/src/repl/headless.ts` | Headless slash dispatcher used by `cli-headless` e2e |
| `packages/bodhi-pi/e2e/shared/mcp-public-http.e2e.ts:111-137` | The skipped http test; this should pass after the refactor |

---

## Suggested exploration sequence

1. Read every file above with the 6-primitive table in mind. Note which operations exist today and which are missing.
2. Decide which of Direction A (subsystem) vs Direction B (built-in extension) you'd take, and write a half-page sketch of each so you can compare on concrete tradeoffs (lines changed, test surface, parallel discovery / event delivery cost). Bring the comparison to the user before committing.
3. Walk the lifecycle of each of the 6 ops + 3 session-init flows (new/load/resume) + close/delete on paper, listing the kv writes, connection mutations, and event emissions each one produces. Look for dropped/double mutations.
4. Specifically work through the http per-request case: for each ext method, what does the agent see, what does kv hold, what does the inclusion set look like coming in? Confirm there's no information missing in kv for any operation to rebuild correctly.
5. Cross-check `cli-headless/mcp.e2e.ts`'s session-reuse pattern — its `sendChat`/`sendSlash` reuse one process, so it exercises the multi-session-in-one-agent path you're refactoring.
6. Before writing code, present the plan with: data structures, file paths to edit, test additions, and a mapping of the 6 primitives to specific code paths.

---

## Constraints

- **ACP-stable.** All session-init carrying mcpServers stays inside the standard ACP `session/new` / `session/load` / `session/resume` params. The 6 primitives map to existing `_bodhi-pi/mcp/*` extension methods plus two new ones (`_bodhi-pi/mcp/include` and `_bodhi-pi/mcp/exclude`). Do not invent new top-level ACP methods.
- **Secrets stay masked.** kv reads from ACP must continue to mask secret values (`{ secret: true }` nodes → `"***"`). Internal in-process reads remain unmasked.
- **`supportsMcpStdio: false` runtimes still reject stdio adds.** That gate stays in place at `_bodhi-pi/mcp/add`.
- **CSP-safe MCP client** — `CfWorkerJsonSchemaValidator` (chrome-ext MV3 dependency) stays.
- **Don't widen scope** — OAuth-DCR e2e-ui is out of scope for this work. Foundational OAuth machinery (`KvOAuthProvider`, `EXT_MCP_OAUTH_START/FINISH`) remains as-is and must keep working.

---

## Open questions you should ask the user before designing

Don't guess at these. Use `AskUserQuestion`.

1. **Inclusion set persistence.** Should the per-session inclusion set be persisted (so a session that's closed + reopened via `session/load` restores its prior inclusion set), or is it always re-derived from the most recent `session/new` / `session/load` / `session/resume` params? (Persisting it changes sessionStore's schema, but matches the "session state is durable" expectation.)
2. **Default at session start when nothing is connected.** If no MCPs are connected globally and a client sends `session/new` with `mcpServers: undefined` (= "include all connected"), the inclusion set is empty. If the client subsequently `/mcp connect <X>`, does X auto-include in this session (since "undefined" was the most recent intent), or does the user have to `/mcp include X`?
3. **`/mcp connect` failure semantics.** If connecting to a globally-listed MCP fails (network error, OAuth expired), what does `_bodhi-pi/mcp/list` show for status? `error` (current) or do we want a distinct `connecting`/`auth-required`?
4. **Tool name collisions across MCPs.** Two MCPs both expose a tool literally named `echo`. With the `<slug>__<tool>` namespacing this is already disambiguated, but should `_bodhi-pi/mcp/include` of a second MCP that overlaps with already-included tools surface a warning?
5. **`server-time` invocation.** Confirm the exact spawn command the user wants in `global-setup.ts`: `uvx mcp-server-time --local-timezone=UTC` (stdio) or some other form. The time MCP doesn't have an http-streamable mode in the official package, so it'd be a stdio-only fixture, which is fine for in-memory/cli runtimes but skipped under http/ws/browser/chrome-ext — confirm that matches the test plan.

---

## Deliverable shape

After exploration + Q&A, the implementation lands in two commits (or three if the test additions are large):

1. **Refactor commit.** New ownership model in `src/mcp/`, new event types, wire-up changes in `agent.ts` and `event-wiring.ts`, slash command additions in the three slash dispatchers, two new extension methods in `wire/constants.ts` and `client.ts`. All existing tests pass; the http skip is gone. No new test files needed.
2. **New-semantics test commit.** Multi-MCP fixtures (server-time via uvx in global-setup), cross-session propagation tests, include/exclude tests, the empty-array semantic test, the two-MCP LLM-prompt test. Add to `e2e/shared/`, `e2e-ui/shared/`, `cli-headless/`.
