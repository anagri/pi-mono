# Implementation plan — bodhi-pi MCP review fixes (single commit)

## Context

The review at `ai-docs/reviews/2026-05-17-bodhi-pi-mcp-auth.md` enumerated six batches of findings against the MCP code that landed between `b180f61b3f..fabd6878` (public + http-param + oauth-preregistered + oauth-dcr + stdio). The next planned slice is `transport=stdio` + `command=npx` with env-var injection; the explicit intent of this commit is to clean architecture, error semantics, test coverage, comments, slash parity, and stale docs **before** that slice lands so it plugs into stable scaffolding instead of widening the existing rough edges.

User scope decisions taken before planning (asked + answered):

- **OAuth start-vs-refresh race (Batch B.2)** — defer the mutex; document as a known limitation in CLAUDE.md + spec. No runtime guard added in this commit.
- **Fixture consolidation (Batch C.7)** — dropped. Only the 401-on-protected-route knob lands in `oauth-mcp-server.ts`; the three fixtures keep their current shapes.
- **REPL slash gap (discovered during planning)** — verify in Phase 0 whether `repl.ts` wires `/mcp` slashes at all. If genuinely unwired, log as a follow-up review item (out of this commit) rather than expand scope.

Execution model: one squashed commit, phased internally for safety (each phase keeps the tree green when run in isolation). Verification is `just test-e2e` + `just test-e2e-ui` run **after all phases land**, with regressions fixed in-place before the commit closes. The single-commit constraint is the user's, overriding the review's 6-commit suggestion.

## Phase 0 — Verification & prep (read-only)

Goal: settle the REPL question so Phase 5 scope is firm.

- Read `packages/bodhi-pi/test-apps/cli/src/client/acp/repl.ts` end-to-end. Confirm whether `/mcp` slashes reach any dispatch path. If `tryHandleSlash` from `headless.ts` is not invoked and no other slash router handles `/mcp`, log the gap in this plan (append a "Deferred follow-ups" section) and **do not** widen this commit to fix REPL. If REPL shares a router we missed, fold discover/register wiring into Phase 5 with no scope growth.
- Re-read `packages/bodhi-pi/src/mcp/mcp-service.ts`, `mcp-client.ts`, `mcp-oauth-provider.ts`, `mcp-oauth-state-kv.ts` end-to-end. Confirm the line numbers cited in the review still hold at HEAD before editing.
- Read `packages/bodhi-pi/test-apps/browser/src/client/lib/commands.ts:317-471` (the `oauth start` branch) end-to-end so the new `discover`/`register` branches match the surrounding `pushSystemMessage` + `data-mcp-event` shape.

## Phase 1 — Architecture (Batch A)

Files: `packages/bodhi-pi/src/mcp/mcp-service.ts`, `packages/bodhi-pi/src/mcp/mcp-client.ts`, `packages/bodhi-pi/src/mcp/mcp-oauth-provider.ts`. Net-new: `packages/bodhi-pi/src/mcp/oauth-state-token.ts` (or sibling).

- **A.1 + A.2 input-side dispatch table.** Add a `McpAuthInputMode` type alias next to `McpAuthMode` in `mcp-types.ts:18` covering the four user-facing variants (`public | http-param | oauth-preregistered | oauth-dcr`). Replace the if/else in `parseAuthInput` (`mcp-service.ts:667-731`) with a `Record<McpAuthInputMode, { sync: boolean; validate(...): McpAuthConfig | Promise<McpAuthConfig> }>` table. The "sync" flag drives whether `handleAdd` (`mcp-service.ts:127-159`) routes through the async DCR path or the sync path — collapses the special-case routing at line 142-143 and the defensive throw at line 696-700 into one site.
- **A.3 provider factory.** Extract a `makeKvOAuthProvider(slug, entry, redirectUri, stateKv, state)` helper used by `handleOauthStart` (`mcp-service.ts:281-288`), `handleOauthFinish` (`mcp-service.ts:313-320`), and `refreshOauthTokens` (`mcp-client.ts:27-36`). The refresh path uses a `makeKvOAuthProviderForRefresh(kvStore, slug, cfg)` sibling that hides the sentinel `state: "unused-during-refresh"` so the smell doesn't bleed across files.
- **A.4 DCR call dedup.** Extract `registerOauthClient({registrationEndpoint, redirectUri, scopes?, clientName, clientUri?}): Promise<RegisteredClient>` used by both `handleOauthRegister` (`mcp-service.ts:364-405`) and `runDcrAddFlow` (`mcp-service.ts:519-548`). Centralises the `Parameters<typeof registerClient>[1]["metadata"]` cast at lines 389 and 528.
- **A.5 relocate cross-cutting helpers.** Move `makeStateToken`, `decodeTenantFromState`, `base64UrlEncodeBytes`, `base64UrlEncodeString`, `base64UrlDecodeToString` (`mcp-service.ts:582-628`) into a new `packages/bodhi-pi/src/mcp/oauth-state-token.ts`. `mcp-service.ts` shrinks ~50 lines and the next slice gets a clean home for any further token machinery. **Do NOT** pre-emptively expand `mcp-stdio-env.ts`; leave it alone unless one of the test additions in Phase 3 forces a touch.

Type-check pass after this phase: `npm --workspace @bodhiapp/bodhi-pi run check`.

## Phase 2 — Correctness (Batch B minus B.2)

Files: `packages/bodhi-pi/src/mcp/mcp-service.ts`, `packages/bodhi-pi/src/mcp/mcp-oauth-state-kv.ts`, `packages/bodhi-pi/CLAUDE.md`, `ai-docs/specs/bodhi-pi/mcp.md`.

- **B.1 error-code correction.** Pick one convention for "external/peer failed" (proposal: `-32602` for malformed inputs, a single shared `-32099` "external dependency failed" or stay on `-32603` with a clarifying message — decide while reading the JSON-RPC docs in the SDK). Apply to: `handleOauthDiscover` failure (`mcp-service.ts:347-350`), `handleOauthRegister` failure (`mcp-service.ts:393-397`), discovery-during-DCR add (`mcp-service.ts:456-462, 466-470`). Update any test that asserts the previous code (search `-32603` under `packages/bodhi-pi/test/`).
- **B.3 stdio header/query rejection.** Tighten the stdio branch of `parseAuthInput` (`mcp-service.ts:684-694`) so the rejection trips on `hasHeaders || hasQueries` regardless of `authMode`. Today a stdio entry with `{command:"npx", headers:{...}}` and no `auth` field silently drops the headers — the new test added in Phase 3 (C.4) exercises this and will start passing once this fix lands.
- **B.4 pruneExpired audit.** Decide between (a) keeping the opportunistic comment + adding a hard cap of e.g. 100 keys per scan to bound multi-tenant blowup, or (b) leaving as-is and documenting the trade-off. Pick (a) only if it's a one-line change. Touch `packages/bodhi-pi/src/mcp/mcp-oauth-state-kv.ts:56-63`.
- **B.5 dedup JSDoc.** Collapse the two consecutive JSDoc blocks at `mcp-service.ts:651-666` into one short summary on `parseAuthInput`.
- **B.2 documentation (deferred fix).** Add a 3-4 line note in `packages/bodhi-pi/CLAUDE.md` MCP section AND `ai-docs/specs/bodhi-pi/mcp.md` (next to the OAuth flow description) recording that interactive `oauth/start` writes are NOT serialised against eager refresh writes for the same `mcp/<slug>` key, with a TODO marker pointing back to this plan. Multi-tab flows + concurrent eager refresh are a known race; revisit when a real bug surfaces.

## Phase 3 — Test coverage (Batch C minus C.7)

Files: `packages/bodhi-pi/e2e/helpers/oauth-mcp-server.ts`, new tests under `packages/bodhi-pi/test/`, edit `packages/bodhi-pi/e2e/cli-headless/mcp.e2e.ts`.

- **Fixture knob for C.1/C.3.** Extend `SpawnOAuthMcpServerOptions` (`e2e/helpers/oauth-mcp-server.ts:39-45`) with `forceNext401?: boolean` (or a `setForce401()` method on the returned fixture handle, whichever is cleaner to drive from a test). The seam is the protected `/mcp` route at `oauth-mcp-server.ts:288-320` — before the existing bearer check, if `forceNext401` is set, respond `401` once and clear the flag. Keep the existing invalid-bearer 401 path intact.
- **C.1 lazy 401-retry refresh test.** New `packages/bodhi-pi/test/mcp-oauth-lazy-refresh.test.ts`. Setup the OAuth fixture, complete `oauth/start`+`finish`, connect, trip `forceNext401`, fire a tool call, assert: server saw two distinct bearers on the same logical request (proves refresh happened) AND the retry succeeded. Lives next to `mcp-oauth-refresh.test.ts` for grep-ability.
- **C.2 state-TTL expiry test.** Add to `packages/bodhi-pi/test/mcp-oauth.test.ts` (sibling to the existing "invalid/expired state" test at line 213). Inject a custom `now()` into `OAuthStateKv` (the constructor already accepts one — `mcp-oauth-state-kv.ts:23`) so it returns `Date.now() + 6 * 60 * 1000`. Call `handleOauthFinish` with the previously-issued state; assert `-32602` AND that the entry was removed via the read-then-remove path at `mcp-oauth-state-kv.ts:45-49`.
- **C.3 refresh-failure → re-auth test.** Same file as C.1 or a sibling. Configure fixture to 401 the refresh token endpoint (oauth-mcp-server.ts already 401s for invalid_client at line 297), trigger a fresh tool call after expiry, assert the request returns the upstream 401 and `mcp/<slug>` tokens remain intact (no silent token deletion). Document that the user-visible path is "re-run `/mcp oauth start`".
- **C.4 stdio negative tests.** Extend `packages/bodhi-pi/test/mcp-stdio-integration.test.ts` (or `packages/bodhi-pi/test/mcp.test.ts` if more apt) with: (a) `/mcp add {command:"npx", headers:{...}}` rejects with `-32602` (this passes after B.3 fix); (b) `/mcp list` masks values inside `env: [{name,value,secret:true}]`; (c) `/mcp add {command:"npx", auth:"http-param", ...}` rejects with `-32602`. No npx spawning required — these are validation tests, not transport tests.
- **C.5 cli-headless assertion tightening.** Edit `packages/bodhi-pi/e2e/cli-headless/mcp.e2e.ts:64-81`. Before the final `toContain("42")`, assert the response includes the tool name (`${slug}__get-sum`) being invoked, or assert a stable substring that proves the tool path was taken (e.g. response length, a phrase like "calculated" or the tool result wrapper). Pick the cheapest substring that fails on coincidental "42" mentions.
- **C.6 concurrent-flow smoke test.** New small test in `mcp-oauth.test.ts` that issues two `oauth/start` for the same slug in parallel, asserts distinct state tokens, completes both `finish` calls (one wins, one fails with `-32602` for stale state OR both succeed in the current racy implementation — assert whichever the current code does, with an inline comment pointing at the B.2 deferred-lock note). The point is documenting current behaviour so a future fix doesn't silently break a contract nobody recorded.

## Phase 4 — Comment cleanup (Batch D)

Files: `packages/bodhi-pi/src/mcp/mcp-service.ts`, `packages/bodhi-pi/src/mcp/mcp-client.ts`. Each edit is a single-line or single-block deletion/replacement; nothing else.

Apply the nine cites verbatim from review Batch D:

- D.1 mcp-service.ts:141 — delete the misleading "oauth-dcr is async..." comment.
- D.2 mcp-service.ts:445-446 — delete the "Discovery: skip when..." narrative.
- D.3 mcp-service.ts:481 — delete the "Scope: user override > discovered..." comment.
- D.4 mcp-service.ts:505 — delete the "DCR: only when..." comment.
- D.5 mcp-service.ts:651-666 — handled in Phase 2 (B.5).
- D.6 mcp-client.ts:175 — delete the "Eager refresh:..." comment.
- D.7 mcp-client.ts:193 — collapse the "Lazy refresh on 401 — single retry to avoid loops." comment to just "single retry to avoid loops" or delete; the second clause is the only non-restate part.
- D.8 mcp-client.ts:19-26 and :212-217 — trim each JSDoc to one sentence or delete if the function name already carries the meaning.
- D.9 mcp-service.ts:233 — drop the `out as unknown as Record<string, unknown>[]` double cast (return `{ entries: out }` directly; widen the return type to `Record<string, unknown>` at the call boundary if TypeScript objects).

## Phase 5 — Slash parity (Batch E)

Files: `packages/bodhi-pi/test-apps/browser/src/client/lib/commands.ts`, new `packages/bodhi-pi/e2e-ui/shared/mcp-oauth-discover.spec.ts` (or extend `mcp-oauth.spec.ts`).

- **E.1 browser discover/register slashes.** Extend the `else if (sub === "oauth")` block (`commands.ts:317-471`) with two new actions next to `start`:
  - `/mcp oauth discover <url>` → `ctx.conn.extMethod(EXT_MCP_OAUTH_DISCOVER, {url})`, push system message with `data-mcp-event="oauth-discover"` carrying `authorizeUrl`/`tokenUrl`/`registrationEndpoint` as data attributes.
  - `/mcp oauth register <registrationEndpoint> <redirectUri> [--scopes=a,b]` → `ctx.conn.extMethod(EXT_MCP_OAUTH_REGISTER, {...})`, push `data-mcp-event="oauth-registered"` with `data-mcp-client-id`. Match the CLI shape at `test-apps/cli/src/client/acp/headless.ts:137-170` for argument parsing semantics so behaviour is identical across runtimes. The chrome-ext and http+ws frontends inherit the change automatically because they import `AppShell` from `@bodhiapp/bodhi-pi-test-app-browser/client`.
- **E.2 e2e-ui spec for the granular flow.** New test in `e2e-ui/shared/mcp-oauth-discover.spec.ts` (or append to `mcp-oauth.spec.ts`): drive `/mcp oauth discover` → assert `authorizeUrl`/`tokenUrl`/`registrationEndpoint` come back in the system-message data attributes; drive `/mcp oauth register` with the discovered endpoint → assert `clientId` returned; finally `/mcp add` with `auth:"oauth-preregistered"` using the registered credentials → `/mcp oauth start --auto` → `/mcp connect`. Single test proves the chain end-to-end on http+ws+browser+chrome-ext projects (the existing playwright.config.ts already fans out across all four — no config change needed).
- **E.3 lifecycle-event proof.** Add an assertion in the http+ws projects branch of the new spec that the `mcp_oauth_status_change` event appears in the events panel (`data-mcp-event` carrier from `commands.ts:414-419`'s "Path B"), to lock in the lifecycle-bus path. Use `testInfo.project.metadata.transportPath` to gate (browser/chrome-ext use postMessage; http/ws use the lifecycle event).
- **REPL follow-up** — per Phase 0 outcome, append the REPL gap (or its absence) to the "Deferred follow-ups" section at the bottom of this file before commit.

## Phase 6 — Spec & docs (Batch F)

Files: `packages/bodhi-pi/CLAUDE.md`, `ai-docs/specs/bodhi-pi/mcp.md`.

- **F.1** Update the `**Auth.**` paragraph in `CLAUDE.md` MCP section to record that OAuth modes have shipped (input modes `oauth-preregistered`, `oauth-dcr`; persisted as `mode:"oauth"`; collapse rule). Drop the "tracked in `ai-docs/prompts/...`" sentence.
- **F.2** Extend the "MCP key files" table in `CLAUDE.md` with rows for `mcp-oauth-provider.ts`, `mcp-oauth-state-kv.ts`, `mcp-stdio-env.ts`, and the new `oauth-state-token.ts` (from Phase 1). Update the "Decomposed into" sentence in the same section so the count matches the actual class set after Phase 1.
- **F.3** Extend `ai-docs/specs/bodhi-pi/mcp.md` "Why the decomposition" + the class diagram to describe the OAuth lifecycle additions (provider, state KV, dispatch table). Add a small section on the input→persisted mode collapse (`oauth-preregistered`/`oauth-dcr` → `oauth`) and the `dcrInfo` provenance field. Add the B.2 deferred-race note alongside the OAuth flow description.

## Phase 7 — Gate + regression fix + single commit

Run, in order:

1. `npm --workspace @bodhiapp/bodhi-pi run check` (root-level type/lint sanity after all edits).
2. `npm --workspace @bodhiapp/bodhi-pi test` (unit + in-process integration; covers the new Phase 3 tests).
3. `just test-e2e` — builds the 6 test-apps then runs `vitest --run --config vitest.e2e.config.ts` across cli/http/ws/browser projects. Slow (~minutes).
4. `just test-e2e-ui` — Playwright across http/ws/browser/chrome-ext projects. Slow.

For any regression: identify whether the test asserted obsolete behaviour (error code change in B.1, comment text rolling into a snapshot, slash parser shape change), fix the test if the new behaviour is correct, fix the code if not. Do **not** mask regressions with `it.skip`.

Once both `just` targets are green, stage the full set of changes and create one commit. Suggested message shape:

```
bodhi-pi: mcp auth review fixes (input dispatch, errors, lazy-refresh tests, discover/register slashes, docs sync)
```

Co-author tag per repo convention.

## Critical files (single-commit touch list)

Code:
- `packages/bodhi-pi/src/mcp/mcp-service.ts` (A.1-A.4, B.1, B.3, B.5, D.1-D.4, D.9)
- `packages/bodhi-pi/src/mcp/mcp-client.ts` (A.3, D.6-D.8)
- `packages/bodhi-pi/src/mcp/mcp-oauth-provider.ts` (A.3)
- `packages/bodhi-pi/src/mcp/mcp-oauth-state-kv.ts` (B.4)
- `packages/bodhi-pi/src/mcp/mcp-types.ts` (A.1 — new `McpAuthInputMode`)
- `packages/bodhi-pi/src/mcp/oauth-state-token.ts` (A.5 — new)
- `packages/bodhi-pi/test-apps/browser/src/client/lib/commands.ts` (E.1)

Tests + fixtures:
- `packages/bodhi-pi/e2e/helpers/oauth-mcp-server.ts` (C.1/C.3 — 401 knob)
- `packages/bodhi-pi/test/mcp-oauth-lazy-refresh.test.ts` (new — C.1, C.3)
- `packages/bodhi-pi/test/mcp-oauth.test.ts` (C.2, C.6)
- `packages/bodhi-pi/test/mcp-stdio-integration.test.ts` (C.4)
- `packages/bodhi-pi/e2e/cli-headless/mcp.e2e.ts` (C.5)
- `packages/bodhi-pi/e2e-ui/shared/mcp-oauth.spec.ts` or new `mcp-oauth-discover.spec.ts` (E.2, E.3)

Docs:
- `packages/bodhi-pi/CLAUDE.md` (F.1, F.2, B.2 race note)
- `ai-docs/specs/bodhi-pi/mcp.md` (F.3, B.2 race note)

## Existing utilities to reuse (do not reinvent)

- `KvOAuthProvider` constructor shape — already takes the 7-field `KvOAuthProviderOptions` (`mcp-oauth-provider.ts:19-27`). The A.3 factory just hides field plumbing, not invents a new shape.
- `OAuthStateKv(kv, now)` second constructor arg already exists (`mcp-oauth-state-kv.ts:23`) — use it directly for C.2 instead of building an injection wrapper.
- `ATTACHERS` strategy-table pattern at `mcp-client.ts:121-210` — mirror its shape in A.1 for the input-side dispatch so the two sides of the auth surface look symmetric.
- `data-mcp-event` system-message pattern in `commands.ts:265-316` — reuse for E.1's `oauth-discover` / `oauth-registered` events.
- `pushSystemMessage(msg, dataAttrs)` interface already supports arbitrary data-attrs (`commands.ts:44` per exploration) — no new client API needed.
- `requireStringParam`, `requireNonEmptyString`, `validateOauthUrl` validators in `mcp-service.ts` — reuse inside the new dispatch table.
- `RequestError` from `@agentclientprotocol/sdk` — keep throwing this; just correct the codes (B.1).

## Verification end-to-end

- **Unit/integration**: `npm --workspace @bodhiapp/bodhi-pi test` covers Phase 3 additions.
- **Per-runtime e2e**: `just test-e2e` proves cli/http/ws/browser still round-trip OAuth + stdio + http-param after the dispatch-table refactor.
- **Browser UI**: `just test-e2e-ui` proves the new `/mcp oauth discover` and `/mcp oauth register` slashes work in all four UI runtimes (http, ws, browser, chrome-ext).
- **Manual smoke** (optional, only if a regression won't reproduce in CI): build cli host (`npm --workspace @bodhiapp/bodhi-pi-test-app-cli run build`) and walk: `/mcp oauth discover https://...` → `/mcp oauth register <regUrl> http://localhost:7777/callback` → `/mcp add {...}` → `/mcp oauth start` → `/mcp connect`. Mirror in the browser test-app via `npm --workspace @bodhiapp/bodhi-pi-test-app-browser run dev`.

## Deferred follow-ups (NOT in this commit)

- OAuth interactive-vs-refresh race lock (review B.2) — per user decision; documented as known limitation.
- Three-fixture consolidation (review C.7) — per user decision.
- REPL `/mcp` slash wiring (discovered during planning) — Phase 0 confirmed `packages/bodhi-pi/test-apps/cli/src/client/acp/repl.ts:117` dispatches via `handleCommand` from `test-apps/cli/src/client/lib/commands.ts`, which has zero `/mcp` cases (grep finds only `mcpServers: []` in session new/load). REPL users cannot run ANY `/mcp` slash today — `/mcp add`, `/mcp connect`, `/mcp oauth start` etc. all fall through. Filed as separate follow-up; out of this commit.
