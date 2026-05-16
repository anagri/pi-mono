# Plan deliverable: spec-validation + cleanup

Runs the prompt at `ai-docs/prompts/2026-05-17-bodhi-pi-spec-validation-and-cleanup.md` against current source-of-truth. Executed as a single PR with phase-gated commits.

## Goal restatement

> **host/** = everything on the Host side of the ACP transport.
> **client/** = everything on the Client side of the ACP transport, including all rendering surfaces.
> A file straddles the seam if and only if it imports from both `AgentSideConnection`/`createBodhiPiAgent` AND `ClientSideConnection`/React/REPL. Straddling files MUST be split or explicitly justified.

This deliverable validates that `ai-docs/specs/bodhi-pi/` reflects this seam, source-side, and surfaces real design-smells in the code that the spec sync exposed.

## Drift report

3 confirmed drifts from a sample of 76 (12 `src/acp/agent.ts` line citations, 9 SessionEntry discriminators, 30 EXT_* constants, 4 MCP class files, 17 src/ folders, 4 line-cited modules, plus the in-memory naming sweep).

| Spec | Was | Now | Resolution |
|---|---|---|---|
| `ai-docs/specs/bodhi-pi/architecture.md:75-106` | `src/` layout omitted `src/client/` | Added `client/` row with cross-link to `client-sdk-seed.md` | Commit 522f50ec (Phase 1) |
| `ai-docs/specs/bodhi-pi/index.md:19` | `test-apps/{in-memory,app-utils}/` | `test-apps/{node-adapters,app-utils}/` | Commit 522f50ec (Phase 1) |
| `ai-docs/specs/bodhi-pi/hosts.md:3` | `(in-memory/, app-utils/)` | `(node-adapters/, app-utils/)` | Commit 522f50ec (Phase 1) |
| `packages/bodhi-pi/CONTEXT.md:109` (caught during full sweep) | `("in-memory" test-app's wrappers)` | `("node-adapters" test-app's wrappers)` | Commit 522f50ec (Phase 1) |

Citations validated: every cited line range in `acp.md`/`lifecycle.md`/`mcp.md`/`hosts.md`/`architecture.md` against current source. **Zero shifted citations.** Source code line numbers are stable for the methods documented.

Vocabulary collapse (CONTEXT.md): Client/UI merged into Client; UI demoted to sub-concept inside `client/`. Flagged-ambiguity entry updated to RESOLVED. ExtensionEntry-vs-custom entry rewritten as formalised divergence (don't propose rename). Commit 46562652.

CLAUDE.md / PARITY.md audit (Commit 84fe17d9): OAuth language verified breadcrumb-only; `supportsMcpStdio` default `true` claim verified against `src/acp/agent.ts:215`; "Mirror coding-agent" guidance verified operative; D11 inline-fix sharpened the MCP ownership clause for stateless server Hosts.

## Hack / design-smell report

**Comment-marker sweep**: zero `TODO`/`FIXME`/`HACK`/`XXX`/`as any`/`@ts-expect-error`/`@ts-ignore` in `packages/bodhi-pi/src/` and `packages/bodhi-pi/test-apps/*/src/`. (Reframed at user request: hack hunt = design-smell hunt, not comment hunt.)

**Architectural design-smells found** (12 total; severity scale cosmetic / design-smell / risk):

| # | Smell | File:line | Severity | Resolution in this PR |
|---|---|---|---|---|
| D1 | Optional `SessionStore.setLeafId?` / `forkRecord?` / `readExtensionEntries?` force runtime branching | `src/sessions/session-store.ts:72,80-90,96` | design-smell | Flagged in follow-up plan |
| D2 | 555-line `BodhiPiAcpAgent` is both façade + service-locator + lifecycle orchestrator | `src/acp/agent.ts:162-555` | design-smell | Flagged in follow-up plan |
| D3 | `loadSession` (358-437) duplicates 85-line history-replay block; new/load/resume share 80% of bootstrap | `src/acp/agent.ts:339-449` | design-smell | Flagged in follow-up plan |
| D4 | Cross-branch navigate fall-through is ambiguous | `src/sessions/session-graph-service.ts:77-137` | cosmetic | **Inline-fixed in Commit 06a29f1e** — added 3-line clarifying comment |
| D5 | `McpConnectionLifecycle.hydrate` silently skips unknown slugs in ephemeral list | `src/mcp/mcp-connection-lifecycle.ts:72-79` | risk | Flagged in follow-up plan |
| D6 | Settings fragmentation: merged dict + scattered runtime fields; parallel key namespaces (`defaultModelId` vs `defaultModel`) | `src/settings/settings-service.ts`, `src/sessions/session-state.ts:20-40` | design-smell | Documented in `configuration.md` § Known weaknesses |
| D7 | `supportsMcpStdio` defaults to `true`; wrong value = silent UX bug on browser/HTTP | `src/acp/agent.ts:105` | risk | **Inline-fixed in Commit 06a29f1e** — sharpened jsdoc to "MUST set" |
| D8 | Extension factories silently log-and-continue on factory failure | `src/acp/agent.ts:280-296` | risk | Flagged in follow-up plan |
| D9 | Capability advertisement vs Host-injected reality mismatch (`kvStore`/`terminal`/`scriptExecutor` optional → runtime `-32601`) | `src/kv/kv-service.ts:33-36`, `src/mcp/mcp-service.ts:37`, `src/models/registry.ts:36` | design-smell | Documented in `configuration.md` § Known weaknesses |
| D10 | Event→sessionUpdate mapping is ad-hoc; MCP uses direct `conn.sessionUpdate()` outside the event bus | `src/acp/event-wiring.ts`, `src/mcp/mcp-connection-lifecycle.ts:95` | design-smell | Flagged in follow-up plan |
| D11 | Per-Host `McpConnectionProvider` ownership semantics understated for stateless servers | `packages/bodhi-pi/CLAUDE.md` | cosmetic | **Inline-fixed in Commit 84fe17d9** — sharpened ownership clause |
| D12 | Test-apps lack a shared Host bootstrap template; each invents its own initialization order | `test-apps/*/src/agent.ts`-equivalents | design-smell | Flagged in follow-up plan (out-of-scope for this PR; natural home is the host/client split prompt) |

3 inline fixes landed (D4 comment, D7 jsdoc, D11 CLAUDE.md). 9 deferred to `ai-docs/plans/2026-05-17-bodhi-pi-design-smell-followup.md`.

## New spec doc outlines (sections shipped)

### `configuration.md` (Commit c4a0626a, 189 lines)

1. Three config layers diagram.
2. App-start config — `BodhiPiConfig` required vs optional table; throw-at-construction rule (only `sessionStore` + `filesystem` throw eagerly).
3. Disk hierarchy — global / project paths, walk semantics, `parseSettingValue` JSON coercion, `MCP_PREFIX`/`AUTH_PREFIX` KV namespaces.
4. Session-mutable — `setSessionConfigOption` (ACP-blessed) vs `_bodhi-pi/session/settings/*` (arbitrary dotted keys).
5. Persistence boundaries — KV vs file vs in-memory mapping table.
6. Wire constants leakage policy (zero `_bodhi-pi/` literals outside `src/wire/`).
7. Known weaknesses (D6, D7, D9) with pointer to design-smell follow-up plan.

### `client-sdk-seed.md` (Commit 12838097, 104 lines)

1. Why `src/client/` exists.
2. Public surface table (BodhiPiClient + helpers + ~70 shaped types).
3. BodhiPiClient method groups: 7 areas across 35 methods.
4. What it does NOT cover (transport / React / slash UX / runtime adapters).
5. Seam with ACP SDK — re-exports table.
6. Current consumers verified: cli uses it; http/browser/chrome-ext don't (browser carries deferral comment).
7. Future SDK extraction roadmap (intent only).

## Per-commit log

| # | SHA | Phase | Subject | Files | Tests |
|---|---|---|---|---|---|
| 0 | b9426cab | scaffolding | bodhi-pi: kickoff prompts for spec-validation + host/client split | +3 (prompts) | — |
| 1 | 522f50ec | Phase 1 | bodhi-pi: specs sync trivial drift to source | +4 (specs+CONTEXT.md) | — |
| 2 | 46562652 | Phase 1 | bodhi-pi: collapse Client/UI vocabulary; formalise ExtensionEntry divergence | +4 | — |
| 3 | 84fe17d9 | Phase 1 | bodhi-pi: CLAUDE.md MCP ownership clarity for stateless server Hosts (D11) | +1 | — |
| 4 | c4a0626a | Phase 2 | bodhi-pi: add specs/configuration.md (three-layer config map) | +3 (new spec + cross-links) | — |
| 5 | 12838097 | Phase 2 | bodhi-pi: add specs/client-sdk-seed.md (publishable Client SDK seed) | +2 (new spec + index row) | — |
| 6 | 4a90d51b | Phase 3 | bodhi-pi: hosts.md per-file Host/Client classification tables | +1 (87 files rowed) | — |
| 7 | 59d79122 | Phase 4 | bodhi-pi: strip "ported from" comments referencing deprecated packages | +15 (test-apps src) | 50/399 ✓ |
| 8 | 06a29f1e | Phase 5 | bodhi-pi: inline micro-fixes for low-risk design-smells (D4, D7) | +2 (src/) | 50/399 ✓ |
| 9 | (this commit) | Phase 6 | bodhi-pi: write spec-validation deliverable + design-smell follow-up plans | +2 (plans) | — |

## Verification commands & their actual outputs

### Phase 0 — baseline

```
$ cd packages/bodhi-pi && npm test
 Test Files  50 passed (50)
      Tests  399 passed (399)
   Duration  4.79s

$ npx biome check . --error-on-warnings
Checked 238 files in 106ms. No fixes applied.

$ npx tsgo --noEmit                                                   → pass (exit 0)
$ npx tsgo --noEmit -p packages/bodhi-pi/tsconfig.json                → pass
$ npx tsgo --noEmit -p packages/bodhi-pi/test-apps/{app-utils,node-adapters,cli}/tsconfig.json  → pass
$ npx tsgo --noEmit -p packages/bodhi-pi/test-apps/http/tsconfig.server.json                    → pass
$ npx tsgo --noEmit -p packages/bodhi-pi/test-apps/http/tsconfig.frontend.json                  → pass
$ npx tsgo --noEmit -p packages/bodhi-pi/test-apps/browser/tsconfig.frontend.json               → pass
$ npx tsgo --noEmit -p packages/bodhi-pi/test-apps/chrome-ext/tsconfig.frontend.json            → pass
$ npx tsgo --noEmit -p packages/bodhi-pi/e2e-ui/tsconfig.json                                   → pass
```

### Per-commit pre-commit hooks

`npm run check` (biome + 17 tsgo projects + browser-smoke + web-ui check) ran on every commit. **All commits passed**: `✅ All pre-commit checks passed!`.

### Phase 4 gate (after Commit 59d79122 — comment strip)

```
$ grep -rn "ported from packages/bodhi-pi-" packages/bodhi-pi/test-apps/ --include="*.ts" --include="*.tsx" --include="*.mjs"
(no output)

$ cd packages/bodhi-pi && npm test
 Test Files  50 passed (50)
      Tests  399 passed (399)
   Duration  4.01s
```

Counts match baseline (50/399).

### Phase 5 gate (after Commit 06a29f1e — D4+D7 inline fixes)

```
$ cd packages/bodhi-pi && npm test
 Test Files  50 passed (50)
      Tests  399 passed (399)
   Duration  4.03s
```

Counts match baseline (50/399).

### Phase 7 — final integration gate (actuals)

```
$ cd packages/bodhi-pi && npm test
 Test Files  50 passed (50)
      Tests  399 passed (399)
   Duration  4.07s
```
Matches baseline. ✓

```
$ cd packages/bodhi-pi && npm run test:e2e          (real LLM via gpt-4o-mini)
 Test Files  1 failed | 110 passed | 1 skipped (112)
      Tests  1 failed | 210 passed | 11 skipped (222)
   Duration  290.38s
```

**Single failure**: `e2e/shared/chat.e2e.ts > switching model mid-session changes provenance` (http runtime). Assertion at line 117-121 checks that after switching to gpt-4o-mini mid-session, the LLM's response text contains one of `"openai"`/`"gpt"`/`"chatgpt"`. gpt-4o-mini answered with text mentioning "anthropic" instead — common LLM self-identification confusion when conversation context started with Claude.

**Causality analysis** — this failure is **NOT** caused by this PR's changes:
- Phase 4 (Commit 59d79122) only touched test-apps source comments / divergence-note headers — no runtime code.
- Phase 5 (Commit 06a29f1e) added a 3-line clarifying comment to `src/sessions/session-graph-service.ts` and sharpened jsdoc on `src/acp/agent.ts:supportsMcpStdio`. Neither touches model switching, http handlers, or provider routing.
- Re-running `npm test` after `npm run test:e2e` confirmed integration tests still green at 50/399.

**Root cause**: The test asserts on exact LLM response text — exactly the anti-pattern `packages/bodhi-pi/CLAUDE.md` warns against ("Assertion style: side effects and stable substrings, never exact model text"). The test is pre-existing flake; the gpt-4o-mini model is known to misidentify provenance mid-session.

**Decision** per fix-forward policy: **document and proceed**. Do not skip / suppress / revert. The test is a backlog item independent of this PR.

**Skipped**: Playwright UI e2e (`e2e-ui/`). Justification: Phase 4 + 5 source changes are comment / jsdoc only with zero rendered-UI impact. Pre-commit `npm run check` typechecked all 17 projects after every commit. The signal-to-cost ratio of a 10-minute Playwright + real-LLM run is unfavourable for this PR's change set.

### Pre-existing-flake backlog

| Test | File | Notes |
|---|---|---|
| `switching model mid-session changes provenance` (http) | `packages/bodhi-pi/e2e/shared/chat.e2e.ts:117-121` | Asserts on LLM response text — anti-pattern per CLAUDE.md. Move to assert on `current_model_update` notification + `model_change` SessionEntry instead. Defer to a follow-up plan. |

## Decisions taken autonomously (per user instruction "no mid-run pauses")

1. **Phase 4 comment strip**: 4 of 15 files carried a divergence note in addition to the `ported from` line (extended sandbox-bridge surface, no-background.js manifest divergence, widened RPC surface for extensions.e2e). **Decision**: REWRITE those 4 to standalone form preserving the divergence context (without naming the deprecated package); DELETE the 11 single-line provenance comments. Rationale: the divergence notes are non-obvious context git history can't easily surface; the bare provenance comments are noise.

2. **CLAUDE.md spec list reference** (Phase 1 Commit 2): Added `configuration.md` + `client-sdk-seed.md` to the spec-list sentence in CLAUDE.md BEFORE those files existed (they were created in Phase 2). Since the PR ships as one unit and Phase 2 lands within the same PR, the inconsistency is sub-PR-merge only. No bisect risk because the affected line is a documentation pointer, not code.

3. **`ui-lib/lib/seed-parser.ts` straddler** (Phase 3 Commit 6): Classified as Client (target), flagged as STRADDLER in the hosts.md table because today it's imported by both browser Host (`runtime/adapter.ts:21`) and http Client (`frontend/adapter-http.ts`). **Resolution deferred** to the host/client split prompt where Host can be reshaped to receive already-parsed `seedFiles` via the worker init message. Did not refactor in this PR (out of scope per user's stated boundaries).

4. **Did NOT rename two `sandbox.ts` files in chrome-ext** per locked user decision; instead documented their distinct roles in `hosts.md`.

5. **Did NOT rewrite hosts.md's per-Host sections for granular sub-folder choices inside `client/{react,acp,deps,lib}/`** beyond the per-file table. The host/client folder-split prompt owns that decision.

6. **Did NOT touch the deprecated `packages/bodhi-pi-*` packages**. Their typecheck still runs via `npm run check`; all green.

## Out of scope

- Host/client folder split — owned by `ai-docs/prompts/2026-05-17-bodhi-pi-test-apps-host-client-split.md`.
- 9 deferred design-smell refactors — own follow-up plan at `ai-docs/plans/2026-05-17-bodhi-pi-design-smell-followup.md`.
- SDK package extraction (`@bodhiapps/bodhi-pi-{agent,client}-*`).
- OAuth re-introduction.
- Deprecated `packages/bodhi-pi-*` deletion.
- Config redesign — `configuration.md` § Known weaknesses points at a future ADR.
- Console-log prefix `[bodhi-pi-browser]` and `.bodhi-pi-cli/` path constant cleanup — those are operational identifiers, not provenance comments.
