# Plan: bodhi-pi spec-gap cleanup

> Conventional location is `ai-docs/plans/2026-05-16-bodhi-pi-spec-gap-cleanup.md` at the repo root. The harness wrote it here; move it on adoption.

## Context

Writing the `ai-docs/specs/bodhi-pi/` set + `packages/bodhi-pi/CONTEXT.md` (commit `3dd47a8f`) surfaced ten residual gaps between live code and the operating-manual docs. Kickoff prompt: `ai-docs/prompts/2026-05-16-bodhi-pi-spec-gap-cleanup.md`. Code-state verification (2× Explore agents, full report under `## Verified facts` below) graded each item:

- 🔴 doc drift: items 1, 4, 7 (OAuth residue + deprecated-pkg references + terminology) → must fix
- 🟡 small misnomer: items 5, 8 (`test-app-in-memory`, `mcp-auth.ts`) → user approved rename
- 🟢 already clean: items 3, 7-imports, 8-deadness → no action
- 🟦 deferred: items 9 (refresh while we're in CLAUDE.md), 2 (formalise in comment), 6 (one-line docstring)
- ⏭ out of scope: item 10 (capability advertisement) → user deferred to a separate plan

## Scope

**In scope** — three commits, all bounded to items above:

1. **Commit 1: docs cleanup** — items 1, 2, 4, 6, 7, 9.
2. **Commit 2: rename `mcp-auth.ts` → `mcp-stdio-env.ts`** — item 8.
3. **Commit 3: rename `test-apps/in-memory/` → `test-apps/node-adapters/`** — item 5.

**Out of scope**:
- Host/UI folder split (separate kickoff: `ai-docs/prompts/2026-05-16-bodhi-pi-test-apps-host-ui-split.md`)
- `_meta["bodhi-pi"]` capability advertisement (item 10 — deferred)
- OAuth re-introduction (separate exploratory prompts already exist)
- Deletion of deprecated `packages/bodhi-pi-*` packages (file separately when truly orphaned)
- ExtensionEntry rename (not worth ~13 cross-repo SQLite store touches)
- Permissions phase
- Any new feature

## Verified facts (from Phase 1 exploration)

| Item | Status | Key citations |
|---|---|---|
| 1 OAuth residue | 🔴 | `src/` clean (0 hits for `oauth`/`OAuth`/`EXT_MCP_OAUTH`/`KvOAuthProvider`). CLAUDE.md:98 + 102-103 stale. PARITY.md:61-62 stale. No test files reference OAuth. |
| 2 ExtensionEntry rename | 🟡 | Comment at `src/sessions/entries.ts:73-75`. ~9 in-repo `"extension"` discriminator sites: `src/sessions/in-memory-session-store.ts:110`, `test-apps/in-memory/sessions/single-tenant/store.ts:203`, `test-apps/in-memory/sessions/multi-tenant/store.ts:253`, `test-apps/browser/src/ui-lib/sessions/dexie-session-store.ts:171`, `src/extensions/runner.ts:152`, `test-apps/in-memory/sessions/shared.ts:25`, plus the type def itself. CONTEXT.md already documents the divergence. Rename not worth the migration; drop the TODO promise instead. |
| 3 ModelRegistry location | 🟢 | `src/models/registry.ts` exists. Zero stale `acp/model-registry` references in code or active specs. No action. |
| 4 Naming drift in CLAUDE.md | 🔴 | CLAUDE.md uses "host" loosely vs CONTEXT.md's precise Host/Client/UI. Audit pass needed. |
| 5 `in-memory` misnomer | 🟡 | `packages/bodhi-pi/test-apps/in-memory/package.json:2` = `@bodhiapp/bodhi-pi-test-app-in-memory`. `index.ts` exports 100% Node-side adapters: `createNodeFilesystem`, `createNodeKvStore`, `createNodeScriptExecutor`, `createSqliteSessionStore` (single + multi), `createNodePackageExtensionLoader`, `createBashTerminal`. Actual in-memory adapters live in `src/sessions/in-memory-session-store.ts` + `src/filesystem/in-memory-filesystem.ts`. Consumers: `test-apps/cli`, `test-apps/http` only. Low rename cost. |
| 6 MCP_PREFIX/AUTH_PREFIX docstrings | 🟦 | One-line docstring add each. |
| 7-imports Stale `bodhi-pi-*` imports | 🟢 | Zero imports outside the deprecated packages themselves. No action. |
| 7-docs Stale `bodhi-pi-*` doc refs | 🔴 | CLAUDE.md:19-32 reference-clients table + §36 parity rule + §53-55 6-step workflow + Key files table all describe deprecated packages as live. PARITY.md:6 reference list same. Per user: full rewrite to `test-apps/*` + 1-line "deprecated reference" breadcrumb. |
| 8 Dead MCP code | 🟢 | `mcp-client.ts` + `mcp-auth.ts` both active. `mcp-auth.ts` only export = `resolveStdioEnv` (a misnomer — does stdio env, not auth). User approved rename to `mcp-stdio-env.ts`. |
| 9 "Mirror coding-agent" pillar | 🟡 | CLAUDE.md:15. `packages/coding-agent/` still exists. Only 2/50 recent commits cite it. Inline divergences are well-documented in code. Pillar still operative but worth a "headless-only" clarification while we're in CLAUDE.md. |
| 10 `_meta["bodhi-pi"]` capability advert | ⏭ | Real lazy-failure paths (`kvStore`, `supportsMcpStdio`, `terminal`, `scriptExecutor`). User deferred. |

## Commit 1 — docs cleanup

Files modified: `packages/bodhi-pi/CLAUDE.md`, `packages/bodhi-pi/PARITY.md`, `packages/bodhi-pi/src/sessions/entries.ts`, `packages/bodhi-pi/src/mcp/mcp-types.ts`, `packages/bodhi-pi/src/kv/kv-store.ts`.

Edits, in order:

### `packages/bodhi-pi/CLAUDE.md`

1. **§19-32 "Reference clients & publishable adapters"** — replace the table + intro prose so it documents the live `test-apps/{cli,http,browser,chrome-ext}` set + a final "Shared infrastructure: `test-apps/{in-memory,app-utils}`" row + a one-line "Deprecated reference: `packages/bodhi-pi-{cli,web,http,ws-server,ws-frontend,chrome-ext,node,browser}` (not maintained)" breadcrumb. Follow the matrix in `ai-docs/specs/bodhi-pi/hosts.md`. Note: rename `in-memory` → `node-adapters` in this row IF Commit 3 has landed; otherwise keep `in-memory` and rely on Commit 3 to update CLAUDE.md.
2. **§34-42 "Runtime-host parity rule"** — replace the five-package reference list with `test-apps/{cli,http,browser,chrome-ext}` + a note that `bodhi-pi-http` per-turn-rebuild lens now lives in `test-apps/http`.
3. **§44-58 "Feature workflow (TDD across the matrix)"** — replace every `bodhi-pi-{cli,node,browser,web,http}/` path with the corresponding `test-apps/{cli,browser,chrome-ext,http}/` and `test-apps/in-memory/` / `test-apps/app-utils/` (or `node-adapters/` post-Commit-3).
4. **§62-78 "Key files"** — sanity-check every cited path still exists; replace any `bodhi-pi-*` references.
5. **§86-110 "MCP (Model Context Protocol)"** — remove OAuth lines:
   - Line 98: drop `oauth/start,finish` from the extension-methods list.
   - Lines 102-104 (the full "OAuth-DCR" paragraph): replace with one-line "OAuth re-introduction is tracked in `ai-docs/prompts/bodhi-pi-mcp-auth-oauth-{dcr,preregistered}.md` (not currently supported; `auth.mode = \"public\"` only)."
   - Drop the trailing sentence about KvOAuthProvider mechanics.
6. **§15 "Mirror coding-agent" pillar** — append a clarifying half-sentence: "bodhi-pi is **headless-only** (no TUI, no terminal-render extensions); see `src/extensions/types.ts:75-80` and `CONTEXT.md` flagged-ambiguities for documented divergences."
7. **Terminology audit (item 4)** — read CLAUDE.md end-to-end; every bare "host" / "client" / "frontend" gets reviewed against CONTEXT.md's Host / Client / UI definitions and edited where the use is loose. Goal: every occurrence is unambiguous. Likely affected: §19 prose ("Hosts inject…"), §27-32 host descriptions, anywhere "frontend" appears.

### `packages/bodhi-pi/PARITY.md`

1. **Line 6** — replace the five-host reference list with `test-apps/{cli,http,browser,chrome-ext}` (note the host pair `ws-server`+`ws-frontend` is now folded into `test-apps/http` per `hosts.md`).
2. **Lines 61-62** — keep the "Deferred" row label but update body: drop `KvOAuthProvider` mention; cite the exploratory prompts (`ai-docs/prompts/bodhi-pi-mcp-auth-oauth-{dcr,preregistered,header-query}.md`) as the re-introduction path.
3. Scan rest of file for `bodhi-pi-{cli,node,browser,web,http,ws-*,chrome-ext}` literals; replace with `test-apps/*` equivalents.

### `packages/bodhi-pi/src/sessions/entries.ts:73-75`

Replace the existing "Naming note" comment:

> "Naming note: coding-agent calls this `custom`. bodhi-pi keeps the name `extension` because the runtime discriminator is exposed across five store impls + the ExtensionRunner contract. Rename is a separate change."

With:

> "Naming note: coding-agent calls this `custom`. bodhi-pi keeps `extension` — see `packages/bodhi-pi/CONTEXT.md` flagged-ambiguities for the formalised divergence."

Drops the "separate change" promise (decision made: keep `extension`).

### `packages/bodhi-pi/src/mcp/mcp-types.ts`

Add a one-line docstring above the `MCP_PREFIX` declaration:

```ts
/** KV-key namespace prefix for persisted MCP server entries: `mcp/<slug>`. */
export const MCP_PREFIX = "mcp/";
```

### `packages/bodhi-pi/src/kv/kv-store.ts`

Add a one-line docstring above the `AUTH_PREFIX` declaration:

```ts
/** KV-key namespace prefix for auth credentials: `auth/<provider>` (secret values masked on ACP reads). */
export const AUTH_PREFIX = "auth/";
```

**Commit subject**: `bodhi-pi: docs cleanup — drop OAuth residue, repoint to test-apps, formalise naming notes`

**Verification**: `npm run lint && npm test` (no source-of-truth code changes; pre-commit hook is biome+tsc only).

## Commit 2 — rename `mcp-auth.ts` → `mcp-stdio-env.ts`

Files modified: rename `packages/bodhi-pi/src/mcp/mcp-auth.ts` → `packages/bodhi-pi/src/mcp/mcp-stdio-env.ts`; update `packages/bodhi-pi/src/mcp/mcp-client.ts:5` import path.

Verify no other importers via `grep -r "mcp-auth" packages/bodhi-pi/` — Phase-1 agent confirms only `mcp-client.ts` imports it.

**Commit subject**: `bodhi-pi: rename mcp-auth.ts → mcp-stdio-env.ts (only export is resolveStdioEnv)`

**Verification**: `npm run lint && npm test -- mcp` to exercise the MCP integration tests; `npm run e2e -- e2e/mcp.e2e.ts` if it exists.

## Commit 3 — rename `test-apps/in-memory/` → `test-apps/node-adapters/`

Files moved + paths/imports updated:

1. `git mv packages/bodhi-pi/test-apps/in-memory packages/bodhi-pi/test-apps/node-adapters`
2. `packages/bodhi-pi/test-apps/node-adapters/package.json` — rename `"name": "@bodhiapp/bodhi-pi-test-app-in-memory"` → `"@bodhiapp/bodhi-pi-test-app-node-adapters"`. Update `description` to match.
3. Root `package.json` workspaces — the glob pattern likely already covers `packages/bodhi-pi/test-apps/*`, so no workspace change needed. Verify before commit.
4. Update package.json dependency entries in consumer test-apps:
   - `packages/bodhi-pi/test-apps/cli/package.json` — replace `@bodhiapp/bodhi-pi-test-app-in-memory` with `@bodhiapp/bodhi-pi-test-app-node-adapters`.
   - `packages/bodhi-pi/test-apps/http/package.json` — same.
5. Update consumer source imports (grep `@bodhiapp/bodhi-pi-test-app-in-memory` across `packages/bodhi-pi/test-apps/{cli,http}/src/`):
   - `test-apps/cli/src/agent.ts` (createSingleTenantSqliteSessionStore + extension loader + defaultDbPath)
   - `test-apps/http/src/server/**` (createMultiTenantSqliteSessionStore + openDb + upsertUser + extension loader)
6. Update spec docs to match new name:
   - `ai-docs/specs/bodhi-pi/hosts.md` — three sections cite `test-apps/in-memory/` + `@bodhiapp/bodhi-pi-test-app-in-memory`. Replace.
   - `ai-docs/specs/bodhi-pi/architecture.md` — `Per-Host runtime matrix` table + shared-adapters mention.
   - `ai-docs/specs/bodhi-pi/testing.md` — shared-helpers prose.
   - `ai-docs/specs/bodhi-pi/index.md` — "Shared infrastructure" line.
   - `packages/bodhi-pi/CONTEXT.md` — no specific occurrence, but verify.
   - `packages/bodhi-pi/CLAUDE.md` — Commit 1 already rewrites this section; either Commit 3 lands before Commit 1 (then Commit 1 uses new name), OR Commit 3 lands second and re-edits the Commit 1 output. Recommend Commit 3 second to keep Commit 1's diff focused on doc cleanup.
7. Update root `package-lock.json` (run `npm install` after the rename).

**Commit subject**: `bodhi-pi: rename test-app-in-memory → test-app-node-adapters (package contains 0 in-memory adapters)`

**Verification**:
- `npm install` (regenerates lockfile entries)
- `npm run lint && npm test` (workspace-wide)
- `npm test -w @bodhiapp/bodhi-pi-test-app-cli` (smoke the renamed consumer)
- `npm test -w @bodhiapp/bodhi-pi-test-app-http`
- Optional: `npm run e2e` for each touched test-app

## Commit grouping rationale

- **Three commits** keep diffs single-concern + reviewable. Commit 1 is docs-only (largest LoC, no behaviour). Commit 2 is one-file rename + one import (trivial). Commit 3 is a package rename touching ~10 files + lockfile (medium blast radius, all path/string updates).
- **Order**: 1 → 2 → 3. Commit 1 stabilises the docs; Commit 2 is independent of both; Commit 3's spec/CLAUDE.md edits build on Commit 1's structure.
- **Each commit verifiable independently** — see per-commit verification above.

## Risk register

1. **Commit 1 line numbers drift** — `CLAUDE.md` sections cited by `§N-M` are best-effort. The plan executor must read CLAUDE.md fresh before editing and locate sections by heading not line.
2. **Commit 3 lockfile churn** — `package-lock.json` may show large diffs from `npm install`. Don't hand-edit; let npm regenerate.
3. **Commit 3 vs deprecated packages** — the deprecated `packages/bodhi-pi-*` packages may still declare `@bodhiapp/bodhi-pi-test-app-in-memory` as a dep. Per the prompt's anti-patterns, don't touch deprecated packages. If npm install fails because a deprecated package depends on the old name, document the failure and consider deleting the deprecated dependency entry only (don't refactor deprecated code).
4. **Commit 1 OAuth removal** — verify the PARITY.md "Deferred" row reads correctly after edit; OAuth re-introduction is still desired, just deferred.
5. **Comment-only edits to entries.ts may trigger biome** — verify pre-commit hook passes after the comment swap.

## Verification matrix

| After commit | Command | Expected |
|---|---|---|
| 1 | `npm run lint` | biome + tsc clean across workspace |
| 1 | `npm test` | all in-process tests green (no code change → no behaviour change) |
| 1 | manual grep `oauth\|OAuth\|EXT_MCP_OAUTH` in `CLAUDE.md` + `PARITY.md` | zero hits |
| 2 | `npm test -- mcp` | MCP test suite green |
| 2 | `grep -r "mcp-auth" packages/bodhi-pi/` | zero hits |
| 3 | `npm install && npm run lint && npm test` | clean across workspace |
| 3 | `grep -r "@bodhiapp/bodhi-pi-test-app-in-memory" packages/bodhi-pi/test-apps/` | zero hits (deprecated `packages/bodhi-pi-*/` allowed to retain — out of scope) |
| 3 | `npm run e2e -w @bodhiapp/bodhi-pi-test-app-cli` (if e2e exists) | green |

## Critical files (paths to keep open while executing)

- `packages/bodhi-pi/CLAUDE.md` (Commit 1)
- `packages/bodhi-pi/PARITY.md` (Commit 1)
- `packages/bodhi-pi/src/sessions/entries.ts:73-75` (Commit 1)
- `packages/bodhi-pi/src/mcp/mcp-types.ts` (Commit 1)
- `packages/bodhi-pi/src/kv/kv-store.ts` (Commit 1)
- `packages/bodhi-pi/src/mcp/mcp-auth.ts` + `packages/bodhi-pi/src/mcp/mcp-client.ts:5` (Commit 2)
- `packages/bodhi-pi/test-apps/in-memory/package.json:2` (Commit 3)
- `packages/bodhi-pi/test-apps/in-memory/index.ts` (Commit 3)
- `packages/bodhi-pi/test-apps/cli/package.json` + `src/agent.ts` (Commit 3)
- `packages/bodhi-pi/test-apps/http/package.json` + `src/server/**` (Commit 3)
- `ai-docs/specs/bodhi-pi/{index,architecture,hosts,testing}.md` (Commit 3)

## Authority docs (source of truth — do NOT modify in this round)

- `ai-docs/specs/bodhi-pi/index.md` + every peer doc (just landed; spec edits in Commit 3 only update the renamed package name, not architecture statements)
- `packages/bodhi-pi/CONTEXT.md` (verify no `in-memory` mention requiring update in Commit 3)

## Reference

- Kickoff prompt: `ai-docs/prompts/2026-05-16-bodhi-pi-spec-gap-cleanup.md`
- Spec set landed in commit `3dd47a8f`
- Related kickoff (separate plan): `ai-docs/prompts/2026-05-16-bodhi-pi-test-apps-host-ui-split.md`
- Verified-facts Phase-1 reports: archived in this conversation; re-derivable via `git grep` per item.
