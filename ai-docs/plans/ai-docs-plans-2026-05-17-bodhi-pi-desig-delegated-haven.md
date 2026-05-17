# Design-smell follow-up — execution plan

## Execution outcome (added after the work landed)

All 9 smells landed as commits on `bodhi-pi/design-smell-followup`. Fork decisions taken at execution time per the recommended defaults: **D8 = C** (per-extension `required?`), **D10 = A** (unify through `event-wiring.ts`), **D6 = A** (canonical `defaultModelId` with back-compat). All 407 in-tree vitest tests pass; the Playwright matrix across browser + chrome-ext (46 tests) passes; `npm run check` (Biome + tsgo across 14 tsconfigs + host/client seam) is clean.

Partial completions explicitly documented in their commits and in the touched specs:

- **D6 partial**: naming reconciled (`defaultModelId` canonical, `defaultModel` kept as back-compat read). `runtime.currentModelId` / `runtime.thinkingLevel` deliberately kept as a fast-path cache rather than computed from `sessionOverrides` — full option-A unification would touch every read site through the prompt loop; tracked as remaining work in `configuration.md § D6`.
- **D2 partial**: extracted `ExtensionRunnerHost` cleanly (`src/extensions/extension-runner-host.ts`). Did **not** extract `SessionLifecycleManager` or introduce a `Services` bundle — both require touching every method that holds `this.sessions`, which the source backlog estimates at 2-3 weeks. `agent.ts` shrank from 621 → 605 lines (target ≤200 remains aspirational).

All other smells (D1, D3, D5, D8, D9, D10, D12) are fully landed per the per-slice plan below.

## Context

`ai-docs/plans/2026-05-17-bodhi-pi-design-smell-followup.md` captured 9 deferred architectural design-smells (D1, D2, D3, D5, D6, D8, D9, D10, D12) from the spec-validation PR. That doc is a backlog; this is the **execution** plan that lands all 9 in a single PR as a sequence of independently-reviewable commits.

**Why now**: the 9 smells span latent bugs (D5, D8, D9 silently degrade UX), god-class drift (`BodhiPiAcpAgent` is 559 lines and growing), config fragmentation (D6 has two parallel naming schemes for the same setting), and a Host-bootstrap duplication (D12) that the just-landed host/client split has now unblocked. Letting them sit guarantees they regress further and complicates the eventual SDK extraction (`ai-docs/prompts/20250517-sdk-client-extraction.md`).

**Constraints from user direction**:
- **One PR, many commits** — per-smell (or per-slice within a smell) commits, all on a single branch.
- **No formal ADRs** — design decisions land as updates to `ai-docs/specs/bodhi-pi/*.md` instead.
- **Open forks surfaced as open questions** in this plan (D6/D8/D10) — decisions are made during execution, not pre-committed here.

**Path correction vs. source doc**: every `src/...` reference in the source doc resolves to `packages/bodhi-pi/src/...`. Test-app paths now live under `packages/bodhi-pi/test-apps/<app>/src/host/...` after the May 14–17 host/client split.

**Stale-claim corrections** (verified by exploration):
- D1: `readExtensionEntries` is already required — only `setLeafId?` and `forkRecord?` remain optional. Drop one slice from the D1 commit set.
- D3: `bootstrapDeps()` + `rehydrateSessionFn` already exist; the remaining replay block is ~60 lines (not 85). Smaller extraction than the doc anticipated.
- D12: the doc said "bundle into host/client split work" — that split is now complete (commits `29f435a2`, `ebb680a7`, `ab6e356a`, `ab519a39`). D12 is now a standalone slice in this PR.

## Execution order

Risk bucket first (cost-of-doing-nothing accumulates), then Design ordered by dependency flow:

| # | Smell | Why this position |
|---|-------|-------------------|
| 1 | **D5** | Risk, small blast radius, no dependencies. Quick win. |
| 2 | **D9** | Risk, small. Pairs naturally with D5 (both surface previously-silent failures to Clients). |
| 3 | **D8** | Risk, needs a policy decision (open question). Touches `RegisteredExtension` shape — must land before D2 reshuffles agent.ts. |
| 4 | **D1** | Design, small. Interface cleanup — drops the `?` from two `SessionStore` methods. Independent of everything else. |
| 5 | **D10** | Design, needs decision. Mapping-policy fix; should land before D2 since D2 may move event-wiring around. |
| 6 | **D3** | Design, medium. Extract `bootstrapSession` + `replayHistoryForLoad` from `agent.ts` — preparatory work for D2's god-class split. |
| 7 | **D6** | Design, large, needs decision. Settings unification. Cross-cuts D9 (capability advertisement reads from settings). Land after D9 stabilises the shape. |
| 8 | **D2** | Design, largest. `BodhiPiAcpAgent` decomposition. Benefits from D3's extracted helpers and from D6's settled config shape. |
| 9 | **D12** | Design, medium. Common Host bootstrap helper in `test-apps/app-utils/`. Last because it consumes the cleaned-up agent surface from D2. |

## Per-smell commit slicing

Every smell ends with a spec-update commit in place of an ADR (per user direction). All file paths are relative to repo root unless noted.

### 1. D5 — surface unknown MCP slugs (Risk)

**Files**: `packages/bodhi-pi/src/mcp/mcp-connection-lifecycle.ts:50-83` (hydrate), `packages/bodhi-pi/src/mcp/mcp-service.ts`, `packages/bodhi-pi/src/events/types.ts:243-256` (BodhiPiEventType union).

**Commits**:
1. Emit `mcp_status_change{status:"error", errorMessage:"unknown slug"}` for each dropped slug in `hydrate()`; add `notFoundSlugs: string[]` to `NewSessionResponse._meta`. Behaviour-preserving: `session/new` still succeeds. Add integration test asserting both signals fire.
2. Update `ai-docs/specs/bodhi-pi/mcp.md` § "Hydration flow on session boot" and `ai-docs/specs/bodhi-pi/acp.md` § `newSession` row.

### 2. D9 — capability availability flags (Risk)

**Files**: `packages/bodhi-pi/src/acp/agent.ts:318-337` (initialize handler), `packages/bodhi-pi/src/kv/kv-service.ts`, `packages/bodhi-pi/src/mcp/mcp-service.ts`, `packages/bodhi-pi/src/models/registry.ts`.

**Commits**:
1. Compute per-namespace availability at agent construction from the injected adapter set; expose as `agentCapabilities._meta["bodhi-pi"].available = {kv, mcp, terminal, scriptExecutor, settings}`. Add integration test: agent constructed without `kvStore` → flag is `false`.
2. Update `ai-docs/specs/bodhi-pi/acp.md` § initialize and `ai-docs/specs/bodhi-pi/configuration.md` § Known weaknesses.

### 3. D8 — extension factory failure policy (Risk, needs decision)

**Files**: `packages/bodhi-pi/src/extensions/runner.ts`, `packages/bodhi-pi/src/extensions/types.ts:109` (`RegisteredExtension`), `packages/bodhi-pi/src/acp/agent.ts:278-304` (`ensureExtensionRunner`).

**Open fork (decide at execution time)**:
- **A. Strict** — first factory failure aborts construction; Hosts opt-in via `BodhiPiConfig.strictExtensions:true`.
- **B. Lenient + visibility (current + diff)** — log+continue, but surface failed extension names via `initialize` `_meta`.
- **C. Per-extension severity** — `RegisteredExtension.required:boolean`; required → abort, optional → log+continue.

**Recommended default (if execution time has to choose unilaterally)**: **C** — most aligned with how the bodhi-pi extension model already treats extensions as independent units; lets Hosts mark `bash` or `kv-backed` extensions as required without forcing a global mode.

**Commits**:
1. Update `ai-docs/specs/bodhi-pi/extensions-skills-commands.md` with the chosen policy (locks the decision in spec form, per "no ADRs" rule).
2. Type + runner change: add `required?:boolean` (or chosen alternative) to `RegisteredExtension`; update `ExtensionRunner.build()` failure handling.
3. Surface failed extension names via `initialize` `_meta` (always, regardless of policy choice — visibility is orthogonal to abort/continue).
4. Update `ai-docs/specs/bodhi-pi/acp.md` § initialize sequence diagram.

### 4. D1 — drop optional `SessionStore.setLeafId?` and `forkRecord?` (Design)

**Files**: `packages/bodhi-pi/src/sessions/session-store.ts:72,80-84` (interface). Implementations:
- `packages/bodhi-pi/src/sessions/in-memory-session-store.ts`
- `packages/bodhi-pi/test-apps/browser/src/host/sessions/dexie-session-store.ts`
- `packages/bodhi-pi/test-apps/node-adapters/sessions/single-tenant/store.ts`
- `packages/bodhi-pi/test-apps/node-adapters/sessions/multi-tenant/store.ts`
- Any test stubs in `packages/bodhi-pi/test/helpers/`.

**Commits**:
1. Add `setLeafId` and `forkRecord` implementations to every in-tree `SessionStore` (no interface change yet — verifies all stores have working impls).
2. Drop the `?` from the interface; remove optional-chaining + the throw-`-32603` fall-throughs in `packages/bodhi-pi/src/sessions/session-graph-service.ts` and `packages/bodhi-pi/src/acp/agent.ts`.
3. Update `ai-docs/specs/bodhi-pi/lifecycle.md` § "How an entry is appended (`appendEntry`)" — remove the `setLeafId?` caveat.

### 5. D10 — unify event→sessionUpdate mapping (Design, needs decision)

**Files**: `packages/bodhi-pi/src/acp/event-wiring.ts` (lines 19-45), `packages/bodhi-pi/src/mcp/mcp-connection-lifecycle.ts:111-144` (`emitStatusBroadcast` + `notifyLifecycle`), possibly `packages/bodhi-pi/src/events/dispatcher.ts`.

**Open fork**:
- **A. All wire-bound events through `event-wiring.ts`** — MCP lifecycle emits events; wiring translates. More indirection, more uniform.
- **B. Drop event-wiring.ts translation** — each service that needs to send a notification calls `conn.sessionUpdate` directly. More explicit, less indirection.

**Recommended default**: **A** — keeps a single translation surface; future SDK extraction can stub one module. The indirection cost is small (~40 lines).

**Commits**:
1. Update `ai-docs/specs/bodhi-pi/acp.md` § "session/update notifications" and § "`LIFECYCLE_EVENT_METHOD` notifications" — lock in the chosen mapping policy.
2. Implementation: refactor MCP lifecycle to emit events, extend `event-wiring.ts` to translate `mcp_status_change` + `mcp_tools_change`. Or B's inverse — refactor `event-wiring.ts` translations into the originating services.

### 6. D3 — extract `bootstrapSession` + `replayHistoryForLoad` (Design)

**Files**: `packages/bodhi-pi/src/acp/agent.ts:343-458` (`newSession`/`loadSession`/`resumeSession`).

**Commits** (2 — partial extraction is already done):
1. Extract `bootstrapSession({restoreMode, ...}) → SessionState` consolidating the ~60-line shared bootstrap. Three entry points become 5-10 lines each. All session-boot integration tests must remain green.
2. Extract `replayHistoryForLoad(session, conn)` from `loadSession`; this isolates the ACP sessionUpdate-formatting block. No spec change needed (sequence stays identical) — optional doc clarification in `ai-docs/specs/bodhi-pi/lifecycle.md` § "Session boot".

### 7. D6 — settings unification (Design, needs decision, large blast radius)

**Files**: `packages/bodhi-pi/src/settings/settings-service.ts`, `packages/bodhi-pi/src/sessions/session-state.ts:25,39-40` (runtime fields), `packages/bodhi-pi/src/acp/agent.ts:67-119` (BodhiPiConfig), every `_bodhi-pi/session/settings/*` handler, every test that asserts on either path.

**Open fork** (largest design call in the PR):
- **A. Unify on `sessionOverrides`** — `setSessionConfigOption("model", …)` writes to `sessionOverrides.<key>`; `runtime.currentModelId`/`runtime.thinkingLevel` become computed getters. Single source of truth.
- **B. Unify on runtime fields** — settings-service writes to `runtime.*` for known ACP-blessed keys; `sessionOverrides` only for arbitrary/unknown keys.
- **C. Introduce a `Config` aggregate** — a facade reads from the merged hierarchy; runtime keeps a snapshot.

Plus naming: rename `defaultModel` → `defaultModelId` everywhere, or accept divergence and document.

**Recommended default**: **A** with `defaultModelId` rename — `sessionOverrides` is already the more-general mechanism; runtime fields are an under-grown special case. Naming: `defaultModelId` since `BodhiPiConfig.defaultModelId` is the more recent/typed of the two.

**Commits** (~6, each touching ≤3 files):
1. Update `ai-docs/specs/bodhi-pi/configuration.md` and `CONTEXT.md` glossary — lock in the chosen shape + naming.
2. Rename `defaultModel` → `defaultModelId` (or vice versa) at every reference; mechanical search-replace.
3. Introduce computed getters / write-through (depending on choice A/B/C); add parity tests.
4. Update `_bodhi-pi/session/settings/*` handlers to write to the unified target.
5. Remove the deprecated dual write path.
6. Update spec § Known weaknesses to remove the "two systems track session config" caveat.

### 8. D2 — `BodhiPiAcpAgent` decomposition (Design, largest)

**Files**: `packages/bodhi-pi/src/acp/agent.ts` (currently 559 lines, ~9 services in constructor). New homes per `feedback_bodhi_pi_src_layout`: extracted services live in their domain folder, not under `src/acp/services/`.

**Target split**:
- `BodhiPiAcpAgent` (~150 lines) — wire-level ACP method dispatcher only.
- `SessionLifecycleManager` in `packages/bodhi-pi/src/sessions/` — owns `sessions: Map`, new/load/resume bootstrap (consumes D3 helpers), close, hydration.
- `ExtensionRunnerHost` in `packages/bodhi-pi/src/extensions/` — lazy `ensureExtensionRunner()` (consumes D8's policy), factory wrapping, partial-failure surfacing.
- A `Services` bundle for service-locator injection.

**Commits** (5):
1. Add tests around the SessionLifecycleManager extraction boundary if coverage gaps exist.
2. Extract `SessionLifecycleManager`; agent.ts delegates.
3. Extract `ExtensionRunnerHost`; agent.ts delegates.
4. Introduce `Services` bundle; constructor signature simplified.
5. Remove the now-empty god-class scaffolding; final cleanup pass.

### 9. D12 — common Host bootstrap helper (Design)

**Files**: `packages/bodhi-pi/test-apps/app-utils/` (existing package), each Host:
- `packages/bodhi-pi/test-apps/cli/src/host/agent.ts`
- `packages/bodhi-pi/test-apps/http/src/host/agent/wire-agent-shared.ts`
- `packages/bodhi-pi/test-apps/browser/src/host/runtime/bootstrap-worker.ts`
- `packages/bodhi-pi/test-apps/chrome-ext/src/host/worker.ts`

**Commits** (5):
1. Add `createBodhiPiHostAgent({adapters: RuntimeAdapterSet, ...}) → ReturnType<typeof createBodhiPiAgent>` to `test-apps/app-utils/src/`. Each Host's specialisation becomes a `RuntimeAdapterSet` only.
2. Retarget cli Host to use the helper.
3. Retarget http Host to use the helper.
4. Retarget browser Host to use the helper.
5. Retarget chrome-ext Host to use the helper.

## Critical files to be modified

Listed for executor reference (full per-smell breakdown above):

- `packages/bodhi-pi/src/acp/agent.ts` — D2, D3, D8, D9
- `packages/bodhi-pi/src/acp/event-wiring.ts` — D10
- `packages/bodhi-pi/src/sessions/session-store.ts` + 4 implementations — D1
- `packages/bodhi-pi/src/sessions/session-state.ts` — D6
- `packages/bodhi-pi/src/settings/settings-service.ts` — D6
- `packages/bodhi-pi/src/mcp/mcp-connection-lifecycle.ts` — D5, D10
- `packages/bodhi-pi/src/mcp/mcp-service.ts` — D5, D9
- `packages/bodhi-pi/src/extensions/runner.ts` + `types.ts` — D8
- `packages/bodhi-pi/src/events/types.ts` — D5
- `packages/bodhi-pi/test-apps/app-utils/src/` — D12 (new file)
- `packages/bodhi-pi/test-apps/{cli,http,browser,chrome-ext}/src/host/` — D12

Spec files touched: `ai-docs/specs/bodhi-pi/{acp.md, lifecycle.md, mcp.md, configuration.md, extensions-skills-commands.md}` and `CONTEXT.md`.

## Reuse existing utilities

- D2's `Services` bundle: model after the existing constructor arg shape in `packages/bodhi-pi/src/acp/agent.ts:181-269` — don't invent a new dependency-injection abstraction.
- D3's `bootstrapSession`: reuse `rehydrateSessionFn` + `bootstrapDeps()` helpers that already exist in `agent.ts`; the extraction is consolidation, not new infrastructure.
- D12's helper: `test-apps/app-utils/` already exports `pickDefined`, `just-bash-fs-adapter`, `just-bash-terminal`; the new `createBodhiPiHostAgent` belongs alongside them.

## Verification

The bodhi-pi `CLAUDE.md` mandates a **7-step TDD gate** for every feature: (1) core integration test, (2) core e2e against real LLM, (3) Node adapters, (4) browser-host, (5) cli e2e, (6) browser Playwright, (7) http integration + optional cross-turn e2e.

**Per-commit verification** (cheap loop):
```
cd packages/bodhi-pi
npm test                    # vitest --run (core unit + integration)
npm run check               # Biome + tsgo + host/client seam + browser smoke
```

**Per-smell verification** (after the smell's last commit):
```
cd packages/bodhi-pi
npm run test:e2e            # 6-step build matrix + e2e suite (expensive)
```

**PR-level verification** (before requesting review):
- Full 7-step gate per CLAUDE.md, including Playwright via `cd packages/bodhi-pi/e2e-ui && npm test`.
- `scripts/check-host-client-seam.mjs` — must pass (D2's extractions cross the agent surface; verify no host-internal imports leak).
- Spec drift check: for every spec file touched, re-run any spec-link checker that exists, or manually grep for stale references to renamed identifiers from D6.

**Smell-specific end-to-end checks**:
- **D5**: `cd packages/bodhi-pi && npm test -- mcp-connection-lifecycle` — assert unknown-slug emits both `mcp_status_change` and `notFoundSlugs` `_meta`.
- **D8**: integration test with a deliberately-throwing factory; assert the chosen policy (abort vs. continue+surface) holds.
- **D9**: construct agent without `kvStore` → `initialize` `_meta.available.kv === false`.
- **D2**: god-class line count must drop to ≤200; `BodhiPiAcpAgent` constructor must take a `Services` bundle (or equivalent).
- **D12**: each of the 4 Hosts must use the new helper; per-Host adapter-set is the only specialisation remaining.

## Notes on PR shape

This PR will land ~30 commits across ~8 weeks of work (D2 + D6 alone are 2-3 weeks each by the source doc's estimate). To keep review tractable:

- Push commits incrementally so the reviewer can re-read in passes between smells.
- Each commit message should cite the smell ID (`D5: surface unknown MCP slugs in hydration`) so the reviewer can match against this plan and the source doc.
- Open questions (D6 / D8 / D10) should be resolved via discussion + spec update **before** the implementation commits for that smell land.

## See also

- `ai-docs/plans/2026-05-17-bodhi-pi-design-smell-followup.md` — source backlog (per-smell rationale, target behaviours, blast-radius estimates).
- `ai-docs/plans/2026-05-17-bodhi-pi-spec-validation-and-cleanup.md` — the PR that generated the backlog.
- `ai-docs/prompts/20250517-sdk-client-extraction.md` — downstream consumer; D2 + D12 unblock this work.
- `ai-docs/specs/bodhi-pi/architecture.md` — three-roles diagram + service composition (the picture D2 is trying to make true).
- `packages/bodhi-pi/CLAUDE.md` — 7-step TDD gate (verification source of truth).
