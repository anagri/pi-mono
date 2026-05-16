# Kickoff: plan the spec-gap cleanup

**Output**: a written plan in `ai-docs/plans/YYYY-MM-DD-bodhi-pi-spec-gap-cleanup.md` covering bounded cleanup items the spec exercise surfaced. Plan only — no code changes in this round.

## Authority

Read first:

- `ai-docs/specs/bodhi-pi/index.md` + every peer doc
- `packages/bodhi-pi/CONTEXT.md`
- `packages/bodhi-pi/CLAUDE.md` (may need updates per the items below)
- `packages/bodhi-pi/PARITY.md` (likewise)

## Scope (bounded)

The plan covers **only** items surfaced by writing the spec docs. Do NOT scope-creep into broader refactors, performance work, or new features.

### Items to investigate and plan

1. **OAuth removal residue in docs.** Commit `6a3966f4` removed all OAuth MCP code (no `_bodhi-pi/mcp/oauth/*` methods, no `KvOAuthProvider`, no `EXT_MCP_OAUTH_*` wire constants). But:
   - `packages/bodhi-pi/CLAUDE.md` "MCP (Model Context Protocol)" section still claims `_bodhi-pi/mcp/oauth/start` and `_bodhi-pi/mcp/oauth/finish` are extension methods and describes `KvOAuthProvider`. **Stale.**
   - `packages/bodhi-pi/PARITY.md` references OAuth state machine.
   - Confirm by greping `oauth` / `OAuth` / `EXT_MCP_OAUTH` in `src/` — should yield zero hits.
   - Plan a docs-only edit removing those sections; add a one-line "OAuth deferred — see exploratory prompts" pointer.

2. **ExtensionEntry rename note.** `src/sessions/entries.ts:72-82` carries a comment: "Naming note: coding-agent calls this `custom`. bodhi-pi keeps the name `extension` because the runtime discriminator is exposed across five store impls + the ExtensionRunner contract. Rename is a separate change." That separate change has not happened. Decide: rename (with store-impl migration) OR formalise the divergence in CONTEXT.md "Flagged ambiguities" and drop the TODO comment. Recommend the latter unless rename is cheap.

3. **ModelRegistry location.** `ai-docs/plans/20260514-solid-bodhi-pi-2.md` prescribes moving the model registry to `src/models/registry.ts` (peer domain folder). Verify current state by reading `src/models/registry.ts` (already exists) AND grepping for any lingering `src/acp/model-registry.ts` references in the codebase or docs. If references to the old location remain in docs, plan their update.

4. **Naming drift between CLAUDE.md and CONTEXT.md.** The new CONTEXT.md defines Host / Client / UI precisely. CLAUDE.md may still use "host" loosely. Audit `packages/bodhi-pi/CLAUDE.md` for terminology drift and plan inline edits.

5. **`test-apps/in-memory/` naming.** The package is named `@bodhiapp/bodhi-pi-test-app-in-memory` but exports Node-side adapters (`createNodeFilesystem`, `createSingleTenantSqliteSessionStore`, `createMultiTenantSqliteSessionStore`, etc.) — none of which are in-memory. The name predates current contents. Plan a rename (e.g. `bodhi-pi-test-app-node-adapters`) or document the historical reason in the package README. Don't rename without confirming consumer impact.

6. **`MCP_PREFIX` / `AUTH_PREFIX` convention.** These exist as wire-namespace prefixes for KV keys. Spec doc mentions them in passing. Confirm they're documented in `src/kv/kv-store.ts` and `src/mcp/mcp-types.ts`; plan a one-line comment add if not.

7. **Stale references to deprecated `packages/bodhi-pi-*`.** Search for any production-code import / docs reference to `bodhi-pi-cli`, `bodhi-pi-web`, `bodhi-pi-http`, `bodhi-pi-ws-server`, `bodhi-pi-ws-frontend`, `bodhi-pi-chrome-ext`, `bodhi-pi-node`, `bodhi-pi-browser` outside their own package directories. Anything outside should be redirected to `test-apps/*` or `test-apps/{in-memory,app-utils}`. Decide separately whether to fully delete the deprecated packages now (separate larger commit).

8. **Dead code from MCP decomposition.** With `McpService` decomposed into Store/Lifecycle/Registry, check `src/mcp/mcp-client.ts` and `src/mcp/mcp-auth.ts`:
   - Is `mcp-auth.ts` still referenced now that only `mode: "public"` exists? Likely a stale file.
   - Is `mcp-client.ts` purely transport plumbing used by `in-process-provider.ts`? Confirm it's still needed.
   - Plan deletion of any provably-unreferenced module.

9. **CLAUDE.md "Mirror coding-agent" guidance.** The CLAUDE.md still says "Read `packages/coding-agent/` first, strip TUI/Node parts, replicate field/method shape." Is this still operative? bodhi-pi has diverged from coding-agent in several places (CONTEXT.md flagged-ambiguities; the `extension` vs `custom` naming; the headless-only `ExtensionAPI`). Audit whether this guidance is still useful or now misleading.

10. **`agentCapabilities._meta["bodhi-pi"]` payload.** The initialize response includes `{version}`. The spec implies it should also list which extension namespaces are supported (so Clients can detect MCP/KV/settings support per-Host based on Host-injected adapters). Investigate whether richer capability advertisement would prevent the runtime `-32601` "kvStore not configured" errors that Hosts currently learn about lazily.

## Plan structure (mandatory sections)

1. **Scope statement** — quote which items above are in / out, with one-line justification.
2. **Per-item slice** — for each item: file references with `path:line`, current state vs target state, commit subject, verification command.
3. **Commit grouping** — propose 2-4 commits grouping related items (e.g. all docs-only edits in one commit; all dead-code deletions in another; rename items as separate commits to keep diffs reviewable).
4. **Verification matrix** — `npm run lint`, `npm test`, `npm run e2e` per affected package after each commit.
5. **Risk register** — items most likely to surface unknowns (item 5 rename, item 8 deletion, item 10 capability change).
6. **Out of scope** — explicit list: no host/ui folder split (separate prompt), no MCP feature additions, no OAuth re-introduction, no permissions phase.

## Anti-patterns to avoid

- Do NOT propose touching production code in `src/` beyond what's directly justified by an item above. No drive-by refactors.
- Do NOT bundle the host/ui folder split (separate plan).
- Do NOT plan OAuth re-introduction (separate exploratory prompt: `ai-docs/plans/2026-05-15-mcp-oauth-re-intro.md` may exist or land later).
- Do NOT plan the deprecated `bodhi-pi-*` package deletion in this plan unless it's a 1-commit no-consumer-impact removal — otherwise flag for a follow-up plan.
- Do NOT change the spec docs themselves in this round; they were just written. If a spec doc is wrong, fix it in this plan's first commit before subsequent commits build on it.

## When done

Print the plan path, the commit subjects, and which items each commit covers. No code edits.
