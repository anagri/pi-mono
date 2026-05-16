# Design-smell follow-up plan

Captures the 9 architectural design-smells deferred from `ai-docs/plans/2026-05-17-bodhi-pi-spec-validation-and-cleanup.md`. Each entry: file:line, current behaviour, target behaviour, refactor blast-radius estimate, suggested commit slicing. **No code changes here** — this is a backlog plan.

Three smells were inline-fixed in the spec-validation PR (D4 = comment, D7 = jsdoc, D11 = CLAUDE.md sentence) and are NOT in this plan.

## Priority bucketing

| Bucket | Smells |
|---|---|
| **Risk** (latent bug or silent UX failure) | D5, D8, D9 |
| **Design** (clarity / extensibility, no current bug) | D1, D2, D3, D6, D10, D12 |

Recommended order: tackle Risk bucket first because the cost-of-doing-nothing accumulates. Within Design, D6 (settings fragmentation) is the highest-leverage; addressing it also paves the way for D9 (capability advertisement) since both touch the same config-discovery surface.

## Per-smell entries

### D1 — Optional `SessionStore.setLeafId?` / `forkRecord?` / `readExtensionEntries?`

- **File:line**: `src/sessions/session-store.ts:72,80-90,96`.
- **Current behaviour**: Three `SessionStore` methods are declared with `?` (optional). Callers branch on existence at runtime; missing implementations either silently degrade (`setLeafId?`) or throw `-32603` at call time (`forkRecord?`). The optionality forces every caller site to think about graceful degradation.
- **Target behaviour**: Make them required on `SessionStore`. In-memory + Dexie + SQLite (single-tenant + multi-tenant) stores implement them. Callers stop branching.
- **Blast radius**: 5 store implementations need to grow (in-memory, dexie-session-store, single-tenant SQLite, multi-tenant SQLite, any test stub). ~6 call sites in `src/sessions/session-graph-service.ts` and `src/acp/agent.ts` simplify. Public type change — anyone outside the repo implementing `SessionStore` would need to add the methods.
- **Commit slicing** (3 commits):
  1. Add the three methods to every in-tree implementation (no interface change yet). All implementations must work.
  2. Drop the `?` from the interface; update callers to remove the optional-chaining and the throw-`-32603` fall-throughs.
  3. Update `lifecycle.md` § "How an entry is appended" to remove the `setLeafId?` caveat; update `extensions-skills-commands.md` if any reference shifts.

### D2 — 555-line `BodhiPiAcpAgent` is both façade + service-locator + lifecycle orchestrator

- **File:line**: `src/acp/agent.ts:162-555`.
- **Current behaviour**: Single class owns: ACP method dispatch, 7 service references constructed in its constructor, extension-runner lazy init (`ensureExtensionRunner()` called in every session method), event-wiring setup, history replay logic for `loadSession` (85 lines), session map ownership, `extHandlers` map building. Reading it requires holding all seven services in your head at once.
- **Target behaviour**: Split into:
  - `BodhiPiAcpAgent` (~150 lines) — wire-level ACP method dispatcher only.
  - `SessionLifecycleManager` — owns the `sessions: Map`, new/load/resume bootstrap, close, hydration.
  - `ExtensionRunnerHost` — lazy `ensureExtensionRunner()` machinery, factory wrapping, partial-failure policy (see D8).
  - Service-locator pattern via a constructor-injected `Services` bundle.
- **Blast radius**: Large. Touches every service-instantiation site in the file; touches every test that constructs a `BodhiPiAcpAgent`. Likely 2-3 weeks of focused work. Test coverage on `test/` is good enough that behaviour preservation is verifiable.
- **Commit slicing** (5+ commits): one commit per extracted responsibility; each preceded by adding tests around the extraction boundary if missing; final commit removes the now-empty god-class methods.

### D3 — `loadSession` duplicates 85-line history-replay block; new/load/resume share 80% of bootstrap

- **File:line**: `src/acp/agent.ts:339-449`.
- **Current behaviour**: Three near-identical entry-point methods differing in: history replay (load only), and `restoredSlugs` parameter to `mcpService.hydrate`. The replay block (lines 373-424) inlines ACP `sessionUpdate` formatting for user chunks + tool_call + tool_call_update.
- **Target behaviour**: Extract `bootstrapSession({restoreMode: "new"|"load"|"resume", ...})` returning a `SessionState`. Extract `replayHistoryForLoad(session, conn)` as a method on the bootstrap result. The three entry points become 5-10 lines each.
- **Blast radius**: Medium. Touches `src/acp/agent.ts` only; affects all session-boot integration tests. Behaviour-preserving refactor — should not break any test.
- **Commit slicing** (3 commits):
  1. Extract `bootstrapSession` helper, keep all three methods calling it; verify tests green.
  2. Extract `replayHistoryForLoad`, keep `loadSession` calling it; verify tests green.
  3. Update `acp.md` + `lifecycle.md` sequence diagrams if helpful (citations stay the same).

### D5 — `McpConnectionLifecycle.hydrate` silently skips unknown slugs in ephemeral list

- **File:line**: `src/mcp/mcp-connection-lifecycle.ts:72-79`.
- **Current behaviour**: When `session/new` is called with `mcpServers: [...]` that references slugs the KV doesn't know about, those slugs are silently dropped from hydration. The session boots; the missing MCPs are simply absent; no event, no `-32602`, no warning. The user thinks their slugs are loaded.
- **Target behaviour**: Emit a `mcp_status_change{status:"error", errorMessage:"unknown slug"}` event for each dropped slug (consumed by Hosts that wire to it) AND include them in a `notFoundSlugs:string[]` array on the `NewSessionResponse._meta`. Don't throw — `session/new` should still succeed — but make the dropping visible.
- **Blast radius**: Small. Touches `src/mcp/mcp-connection-lifecycle.ts` + `src/mcp/mcp-service.ts` (response shape) + 1-2 integration tests. New event type added to `BodhiPiEventType` if needed.
- **Commit slicing** (1-2 commits): one for the code change + new test; one for spec update (`mcp.md` § Hydration flow + `acp.md` § `newSession`).

### D6 — Settings fragmentation: merged dict + scattered runtime fields + parallel key namespaces

- **File:line**: `src/settings/settings-service.ts`, `src/sessions/session-state.ts:20-40`, `src/acp/agent.ts:67-119` (BodhiPiConfig).
- **Current behaviour**:
  - The same conceptual setting lives in two places with different names: `BodhiPiConfig.defaultModelId` (in code) vs `BodhiPiProjectSettings.defaultModel` (on disk).
  - `SessionState.runtime.currentModelId` and `SessionState.runtime.thinkingLevel` are direct fields on the runtime, NOT in `sessionOverrides`. Two systems track session config.
  - The same key can be set via either `setSessionConfigOption("model", …)` OR `_bodhi-pi/session/settings/set("defaultModel", …, scope:"session")`. Different precedence, different write targets.
- **Target behaviour** (ADR required — three viable shapes):
  - **A. Unify on `sessionOverrides`** — `setSessionConfigOption` writes to `sessionOverrides.<key>`; runtime fields become computed from overrides.
  - **B. Unify on runtime fields** — settings-service writes to `runtime.*` for known ACP-blessed keys; `sessionOverrides` only for arbitrary keys.
  - **C. Introduce a `Config` aggregate** — single facade reads from the merged hierarchy; runtime keeps a snapshot.
  - Pick one; rename `defaultModel` to `defaultModelId` everywhere OR vice versa (or accept the divergence and document it).
- **Blast radius**: Large. Touches settings-service, session-bootstrap merge, ModelRegistry, `_bodhi-pi/session/settings/*` handlers, every test that asserts on either path. Public type change (`BodhiPiConfig`).
- **Commit slicing**: write an ADR FIRST, then ~6 commits to land the chosen shape with parity tests at each step.

### D8 — Extension factories silently log-and-continue on factory failure

- **File:line**: `src/acp/agent.ts:280-296` (the lazy `ensureExtensionRunner()` block).
- **Current behaviour**: When `ExtensionRunner.build()` is called, each factory is wrapped (per the runner contract); if a factory throws, the failure is logged and the runner proceeds without that extension. The agent then claims capabilities (slash commands, tools, providers) that the failed extension would have registered — but they don't actually exist.
- **Target behaviour**: Policy decision needed:
  - **Strict mode** — first factory failure aborts construction (`createBodhiPiAgent` throws). Hosts opt-in via `BodhiPiConfig.strictExtensions:true`.
  - **Lenient mode (current)** — log + continue, but surface failed extension names via `_meta` on `initialize` response so Clients can render warnings.
  - **Per-extension severity** — `RegisteredExtension.required:boolean` field; required extensions abort, optional log + continue.
- **Blast radius**: Touches `src/extensions/runner.ts`, `src/acp/agent.ts`, types in `src/extensions/types.ts`, plus tests covering extension partial-failure.
- **Commit slicing**: ADR for policy → 1 commit for type + runner change → 1 commit for `initialize` `_meta` extension → spec update.

### D9 — Capability advertisement vs Host-injected reality mismatch

- **File:line**: `src/kv/kv-service.ts:33-36`, `src/mcp/mcp-service.ts:37`, `src/models/registry.ts:36`; the `initialize` response at `src/acp/agent.ts:314-333`.
- **Current behaviour**: A Host that omits `kvStore` still gets an agent that advertises `_bodhi-pi/kv/*` methods in capabilities — calls just throw `-32601` at runtime. Same for `terminal` (silent — no `bash` tool registered, no error until invoked) and `scriptExecutor`.
- **Target behaviour**: `agentCapabilities._meta["bodhi-pi"]` enriched with per-namespace availability flags: `{kv:true, mcp:true, terminal:false, scriptExecutor:false, settings:true}`. Computed at agent construction from the injected adapter set. Clients can disable/hide unavailable UX surfaces.
- **Blast radius**: Small. Touches `src/acp/agent.ts` `initialize` handler + types. New flags propagate to UI through Clients that read them (cli, http frontend, browser).
- **Commit slicing** (2 commits): 1 for capability computation + advertisement; 1 for `acp.md` § initialize update.

### D10 — Event→sessionUpdate mapping is ad-hoc; MCP uses direct `conn.sessionUpdate()` outside the event bus

- **File:line**: `src/acp/event-wiring.ts`, `src/mcp/mcp-connection-lifecycle.ts:95` (`emitStatusBroadcast`).
- **Current behaviour**:
  - Some EventDispatcher events become `sessionUpdate` notifications via `event-wiring.ts` (auth_change, settings_change, model_select → `config_option_update`).
  - Other notifications bypass the event bus entirely: `mcp_status_change` + `mcp_tools_change` are sent via direct `conn.sessionUpdate(LIFECYCLE_EVENT_METHOD, ...)`.
  - The rule for "which events become wire notifications" is implicit.
- **Target behaviour**: Single mapping policy. Either:
  - **A.** All wire-bound events go through `event-wiring.ts`; MCP lifecycle emits events the wiring translates.
  - **B.** Drop `event-wiring.ts` translation; every service that needs to send a wire notification calls `conn.sessionUpdate` directly (more explicit, less indirection).
- **Blast radius**: Touches `src/acp/event-wiring.ts`, `src/mcp/mcp-connection-lifecycle.ts`, possibly `src/events/dispatcher.ts`. Visible only in trace tests.
- **Commit slicing**: ADR for direction → 1-2 implementation commits → spec update (`acp.md` § session/update notifications + LIFECYCLE_EVENT_METHOD).

### D12 — Test-apps lack a shared Host bootstrap template

- **File:line**: `test-apps/cli/src/agent.ts`, `test-apps/http/src/server/agent/wire-agent-shared.ts`, `test-apps/browser/src/ui-lib/runtime/bootstrap-worker.ts`, `test-apps/chrome-ext/src/worker.ts`.
- **Current behaviour**: Each Reference Host invents its own `createBodhiPiAgent({...})` invocation. The adapter set differs by runtime (Node vs browser-worker), but the structural shape (model registry setup, getApiKey wiring, extension factory discovery) is reinvented per Host. Future SDK extraction will discover this is a problem.
- **Target behaviour**: A common Host bootstrap helper in `test-apps/app-utils/` (or a new `test-apps/host-common/`) that takes a `RuntimeAdapterSet` and returns a configured agent. Each Host then specializes only its `RuntimeAdapterSet`.
- **Blast radius**: Medium-large. Best done together with the host/client folder split prompt — once each Host has a clean `src/host/` folder, extracting the shared bootstrap is mechanical. **Recommended to bundle into the host/client split work, not a standalone PR.**
- **Commit slicing**: drop into the host/client split prompt (`ai-docs/prompts/2026-05-17-bodhi-pi-test-apps-host-client-split.md`) rather than a separate PR.

## Cross-cutting note

D6 (settings) + D9 (capabilities) + D8 (extension partial-failure) all touch the same "what does this agent actually do?" question from different angles. Consider doing them together OR in immediate succession so the ADRs reference each other and the resulting model is internally consistent.

## See also

- `ai-docs/plans/2026-05-17-bodhi-pi-spec-validation-and-cleanup.md` — the PR that produced this backlog.
- `ai-docs/prompts/2026-05-17-bodhi-pi-test-apps-host-client-split.md` — natural home for D12 (and a possible enabler for D2 extraction).
- `ai-docs/specs/bodhi-pi/configuration.md` § Known weaknesses — D6, D7, D9 reader-facing summary.
- `ai-docs/specs/bodhi-pi/architecture.md` — the three-roles diagram + service composition.
