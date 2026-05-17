# bodhi-pi review — mcp auth (public + http-param + oauth-preregistered + oauth-dcr + stdio)

**Snapshot:** 2026-05-17, range `b180f61b3f..fabd6878` (47 commits, 226 files in `packages/bodhi-pi/`). Variants shipped: `transport=http-streamable` × `auth = { public | http-param header/query | oauth-preregistered | oauth-dcr }` + `transport=stdio` (public only). Next slice: `transport=stdio` + `command=npx` with env-var injection. All findings verified at `HEAD`, every claim cites file:line, every finding is fix-now actionable.

Coding-agent drift comparison was skipped per `feedback_no_more_coding_agent_compare`. Brittle-LLM-assert findings against `e2e/shared/*.e2e.ts` `toContain("42")` were dropped because each is paired with structural tool-call/tool-result assertions earlier in the same test (e.g. `e2e/shared/mcp-public-http.e2e.ts:98-111` checks args + result content before the final text containment).

---

## Batch A — Auth-mode dispatch is half-tabled; stdio+npx will widen the lopsided side (Commit 1)

**A.1** Transport-side attachment was refactored to a `Record<McpAuthMode, AuthAttacher>` strategy table (good), but input-side parsing in `parseAuthInput` is still one big if/else over 4 input modes that map to 3 persisted modes. Adding stdio+npx + the env-var validation path will widen this function rather than add one table entry.
- `packages/bodhi-pi/src/mcp/mcp-client.ts:121-210` (existing table) vs `packages/bodhi-pi/src/mcp/mcp-service.ts:667-731` (sprawling parser).
- Symmetry is the point. The input side has an unspoken **input → persisted-mode** map (`oauth-preregistered`/`oauth-dcr` → `oauth`); make it explicit. Then the stdio+npx slice plugs in at a single key.

**A.2** `handleAdd` special-cases `oauth-dcr` at line 142-143 by routing to `runDcrAddFlow` BEFORE calling `parseAuthInput`; `parseAuthInput` then defensively throws `-32603` because oauth-dcr "should never reach it" (line 696-700). Two-site coupling: if a future input mode also needs async pre-processing (oauth-device-code, npx-with-network-discovery), the dispatch site and the defensive guard will both have to remember it.
- `packages/bodhi-pi/src/mcp/mcp-service.ts:141-143, 696-700`.
- The "this mode needs async pre-work" decision belongs in the same table that owns mode→config translation.

**A.3** `handleOauthStart` and `handleOauthFinish` each construct a `KvOAuthProvider` from scratch with the same 7-field constructor. A factory helper would catch the inevitable "added a new provider field, forgot one call site" diff.
- `packages/bodhi-pi/src/mcp/mcp-service.ts:281-288, 313-320`.
- Same concern applies to the third construction inside `refreshOauthTokens` (`mcp-client.ts:27-36`) with its sentinel `state: "unused-during-refresh"` — that's a code-smell shaped exactly like "this constructor wants two factories: interactive and refresh-only".

**A.4** `runDcrAddFlow` (mcp-service.ts:415-580) and `handleOauthRegister` (mcp-service.ts:364-405) duplicate the `OAuthClientMetadata` + `registerClient` call shape, including the same `Parameters<typeof registerClient>[1]["metadata"]` cast at lines 389 and 528. Drift between the two will only be caught when DCR works through one path and not the other.
- Single `registerOauthClient(endpoint, redirectUri, scopes?, clientName, clientUri?)` helper would dedupe.

**A.5** Cross-runtime base64url + state-token helpers (109 lines) live inside `mcp-service.ts` despite being MCP-agnostic. The file is now 824 lines and the next slice will only grow it.
- `packages/bodhi-pi/src/mcp/mcp-service.ts:582-628`.
- Either move to a sibling `src/wire/state-token.ts` or `src/mcp/oauth-state-token.ts`. Same impulse applies to `mcp-stdio-env.ts` (7 lines, one function) — when the npx slice lands, that file is either going to absorb env masking + arg validation + npx-presence checks or get renamed yet again (cf. the d100bcc9 rename).

---

## Batch B — OAuth error-code accuracy + missing concurrency lock (Commit 2)

**B.1** `oauth/discover` and `oauth/register` throw `-32603` for what are external/peer failures (bad URL, peer unreachable, server rejected registration). `-32603` per spec is "internal / refused" — these are user-supplied URLs failing externally, closer to `-32602` (invalid params) or a dedicated convention.
- `packages/bodhi-pi/src/mcp/mcp-service.ts:347-350, 393-397` and the analogous DCR-add discovery paths at `:456-462, :466-470`.
- Mis-coded errors cause clients to over-retry on the wrong axis. Decide one convention for "external peer failed" and apply.

**B.2** Token writeback under `mcp/<slug>` has no concurrency guard. `inFlightRefresh` (mcp-client.ts:154) only serialises refreshes within one transport instance; an interactive `oauth/start` re-issuing tokens while eager refresh is also writing (different code path, different file) can interleave through `KvOAuthProvider.mutate`.
- `packages/bodhi-pi/src/mcp/mcp-oauth-provider.ts:188-193`, `packages/bodhi-pi/src/mcp/mcp-client.ts:154-172`.
- Worth deciding what "last write wins" means here — and whether multi-tenant HTTP hosts need per-`<userId, slug>` mutex via the injected `McpConnectionProvider`.

**B.3** `parseAuthInput` "stdio + auth !== public" check (line 684-694) silently coerces a stdio entry to `mode: "public"` even when the user supplied `headers`/`queries` without an `auth` field at all — only the `authMode === "http-param" || …` branch trips the rejection. A stdio user passing `{command:"npx", headers:{Authorization:"…"}}` will get an `mcp/<slug>` entry with their headers silently dropped.
- `packages/bodhi-pi/src/mcp/mcp-service.ts:684-694`.
- The condition should trip on `hasHeaders || hasQueries` for stdio regardless of `authMode`.

**B.4** `OAuthStateKv.pruneExpired` runs an O(n) scan over every `mcp/oauth-state/` key on every `set` (line 56-63). Multi-tenant state tokens are tenant-prefixed (`mcp-service.ts:587-590`), so a noisy tenant can grow the global prefix scan unbounded — and the prune only deletes entries whose `now > expiresAt` trips during the scan window. For single-tenant hosts this is fine; for HTTP multi-tenant it scales with total active flows, not per-tenant.
- `packages/bodhi-pi/src/mcp/mcp-oauth-state-kv.ts:30-39, 56-63`.

**B.5** `parseAuthInput` carries TWO consecutive JSDoc blocks on the same function — a 10-line bullet-listed contract followed by a second 3-line narrative. Only the second adds anything the function signature doesn't.
- `packages/bodhi-pi/src/mcp/mcp-service.ts:651-666`.

---

## Batch C — OAuth test coverage gaps the user can't see from outside (Commit 3)

**C.1** The lazy 401-retry refresh branch is uncovered. `mcp-client.ts:193-208` handles "MCP server returned 401 → refresh once → retry". `e2e/helpers/oauth-mcp-server.ts:227,297` returns 401 only on invalid-client during the auth flow, never on the protected `/mcp` route after a token expires server-side. Eager refresh has a test (`test/mcp-oauth-refresh.test.ts:36-90`); lazy has none.
- `packages/bodhi-pi/src/mcp/mcp-client.ts:193-208`, fixture at `packages/bodhi-pi/e2e/helpers/oauth-mcp-server.ts`.
- The fixture needs a knob for "force 401 on the next protected request"; without it the lazy path can rot without anyone noticing.

**C.2** No state-TTL expiry test. `OAuthStateKv` returns `null` when `now > expiresAt` (line 45-49), and `handleOauthFinish` then errors with `-32602`. The test at `test/mcp-oauth.test.ts:213-225` only covers a hand-crafted non-existent state, not one that genuinely aged past 5 minutes.
- `packages/bodhi-pi/src/mcp/mcp-oauth-state-kv.ts:41-50`, `packages/bodhi-pi/test/mcp-oauth.test.ts:213-244`.
- Injecting a fake `now` (OAuthStateKv already accepts one) makes this a 10-line addition. Worth the proof; the 5-min TTL is the user-facing contract.

**C.3** No refresh-failure → "you need to re-auth" surface test. When `refreshOauthTokens` throws (revoked refresh token, network down), `mcp-client.ts:203-205` falls through with the original 401 silently. No test proves what the user sees, no slash output asserts "re-run `/mcp oauth start`". This is the UX critical path for token expiry past the slack window.
- `packages/bodhi-pi/src/mcp/mcp-client.ts:193-208`.

**C.4** stdio coverage is thin where the next slice will hurt. Only `mcp-stdio.e2e.ts` exists, only spawns `npx @modelcontextprotocol/server-everything stdio`, only asserts the happy path. No negative tests for: `auth: "http-param"` on a stdio entry (the runDcrAddFlow has a guard at line 419-421 but parseAuthInput's stdio branch silently swallows headers — see B.3); env-name collisions with PATH/HOME; `/mcp list` masking on stdio env values; missing `command` binary on PATH.
- `packages/bodhi-pi/e2e/shared/mcp-stdio.e2e.ts`, `packages/bodhi-pi/e2e/cli-headless/mcp-stdio.e2e.ts`.
- The npx+env slice is going to need these tests anyway. Land them first to lock in the contract.

**C.5** `e2e/cli-headless/mcp.e2e.ts:80` is the only LLM round-trip without a paired structural tool-call assertion (compare `e2e/shared/mcp-public-http.e2e.ts:98-111` which inspects tool-call args + tool result before the final text check). The cli-headless test can pass on coincidental "42" in the model output.
- `packages/bodhi-pi/e2e/cli-headless/mcp.e2e.ts:64-81`.

**C.6** No concurrent-flow test for OAuth. Two parallel `/mcp oauth start` calls for the same slug produce distinct state tokens (correct); two parallel `/mcp oauth finish` racing against eager refresh writing to `mcp/<slug>` has no test. The provider's `mutate` does read-modify-write without a lock (see B.2).
- `packages/bodhi-pi/test/mcp-oauth.test.ts`, `packages/bodhi-pi/src/mcp/mcp-oauth-provider.ts:188-193`.

**C.7** Three MCP fixture shapes in `e2e/helpers/` — `auth-mcp-server.ts`, `oauth-mcp-server.ts`, `test/helpers/spawn-mcp-everything.ts` — each rolls its own `/mcp` route + auth gating + tool registration. The next slice will need a fourth (stdio+npx with env). One fixture-factory keyed by `{transport, auth, expectsEnv}` would constrain the shape.
- `packages/bodhi-pi/e2e/helpers/`, `packages/bodhi-pi/test/helpers/spawn-mcp-everything.ts`.

---

## Batch D — Comment cleanup (Commit 4)

Concrete restate-the-code instances flagged by the user. The `feedback_no_low_value_comments` rule keeps non-obvious WHYs; these are not those.

**D.1** `packages/bodhi-pi/src/mcp/mcp-service.ts:141` — "oauth-dcr is async (network: discovery + DCR); all other branches are sync validation." restates the ternary on the next line, and is misleading since `handleAdd` is `async` throughout.

**D.2** `packages/bodhi-pi/src/mcp/mcp-service.ts:445-446` — "Discovery: skip when caller provided all the discovered fields explicitly OR when only DCR is desired and registrationEndpoint is supplied." Restates the `needsDiscovery` condition immediately following.

**D.3** `packages/bodhi-pi/src/mcp/mcp-service.ts:481` — "Scope: user override > discovered server-supported scopes (default empty for 'use default' semantics)." Restates the if/else.

**D.4** `packages/bodhi-pi/src/mcp/mcp-service.ts:505` — "DCR: only when the caller didn't supply a clientId override." Restates `if (!clientId)` on the next line.

**D.5** `packages/bodhi-pi/src/mcp/mcp-service.ts:651-666` — two consecutive JSDoc blocks on `parseAuthInput`. Keep one.

**D.6** `packages/bodhi-pi/src/mcp/mcp-client.ts:175` — "Eager refresh: token expires within the slack window AND we have a refresh_token." Restates the if condition (one line down).

**D.7** `packages/bodhi-pi/src/mcp/mcp-client.ts:193` — "Lazy refresh on 401 — single retry to avoid loops." The "single retry to avoid loops" half is fine; the rest restates the condition.

**D.8** `packages/bodhi-pi/src/mcp/mcp-client.ts:19-26` and `:212-217` — JSDoc on `refreshOauthTokens` and `buildHttpTransport`. The first restates the SDK call shape; the second restates the strategy table. Trim to one sentence each or delete.

**D.9** `packages/bodhi-pi/src/mcp/mcp-service.ts:233` — `out as unknown as Record<string, unknown>[]` is a double cast; `out` is already typed as `McpListEntry[]`. Drop both casts.

---

## Batch E — DCR/discover slashes wired in CLI only; 3 of 4 reference hosts lack them (Commit 5)

**E.1** Browser slash dispatcher only handles `/mcp oauth start`; `/mcp oauth discover` and `/mcp oauth register` are absent. Since HTTP/WS frontends import the browser `AppShell` (`packages/bodhi-pi/test-apps/http/src/client/react/App.tsx:3`) and chrome-ext reuses the same `commands.ts`, three runtimes inherit the gap.
- Browser slash handler: `packages/bodhi-pi/test-apps/browser/src/client/lib/commands.ts:317-471`.
- CLI counterpart wiring both: `packages/bodhi-pi/test-apps/cli/src/client/acp/headless.ts:139-170`.
- The slash names are stable and the wire methods exist (`EXT_MCP_OAUTH_DISCOVER`, `EXT_MCP_OAUTH_REGISTER`). The gap is purely client-side dispatcher work.

**E.2** No e2e-ui spec covers the discover/register slashes in any runtime. `e2e-ui/shared/mcp-oauth.spec.ts:113-141` covers `auth: "oauth-dcr"` end-to-end via the JSON `/mcp add` parser, which exercises the agent-side flow — but never the granular client-side `discover` → `register` → `add` sequence. The runtime-host parity rule treats per-Host UI surface as required; CLI-only DCR exploration is the kind of asymmetry that goes uncaught until a user files it.
- `packages/bodhi-pi/e2e-ui/shared/mcp-oauth.spec.ts`, `packages/bodhi-pi/e2e/cli-headless/mcp-oauth-dcr.e2e.ts`.

**E.3** `mcp_oauth_status_change` lifecycle event has the "Path B" lifecycle-event consumer in `commands.ts:414-419` but no test asserts that the http/ws projects in `e2e-ui` actually take this branch. The race between postMessage and the lifecycle event is the load-bearing piece of the HTTP redirect-loop story; right now both paths can resolve and the test can pass for the wrong reason.
- `packages/bodhi-pi/test-apps/browser/src/client/lib/commands.ts:371-425`.

---

## Batch F — Spec & CLAUDE.md drift (Commit 6, small)

**F.1** `packages/bodhi-pi/CLAUDE.md` MCP section still says: *"OAuth modes (oauth-dcr, oauth-preregistered) extend the discriminator and are tracked in `ai-docs/prompts/bodhi-pi-mcp-auth-oauth-*.md`."* They shipped. Trunk-based + "stale specs are a regression" rule applies.
- `packages/bodhi-pi/CLAUDE.md` "MCP (Model Context Protocol)" `**Auth.**` paragraph.

**F.2** `packages/bodhi-pi/CLAUDE.md` MCP key files table lists 4 classes (`McpService`, `McpStore`, `McpConnectionLifecycle`, `McpRegistry`) + the host-injected provider. `mcp-oauth-provider.ts`, `mcp-oauth-state-kv.ts`, `mcp-stdio-env.ts` are absent.
- `packages/bodhi-pi/CLAUDE.md` MCP table.

**F.3** `ai-docs/specs/bodhi-pi/mcp.md:5-20` "Why the decomposition" stops at commit `6a3966f4 (remove un-e2e-covered MCP auth variants)`. The OAuth lifecycle service decomposition (`mcp-oauth-provider`, `mcp-oauth-state-kv`, the input→persisted mode collapse) shipped after and isn't described.
- `ai-docs/specs/bodhi-pi/mcp.md:5-30`.

---

## Suggested commit grouping

Each batch is independently gate-checkable (`npm run check` + `npm test`; matrix gates only where listed). Order matches dependency: Batches A+B tighten the architecture so D+E land on stable ground; F is independent.

1. **Commit 1 — Batch A** (input-side auth-mode dispatch table; provider factory; dedup DCR-register call; relocate state-token helpers + audit `mcp-stdio-env.ts` for the imminent npx slice). Touches `src/mcp/mcp-service.ts`, `src/mcp/mcp-client.ts`, `src/mcp/mcp-oauth-provider.ts`, +1-2 new sibling files. No test changes; existing tests stay green.

2. **Commit 2 — Batch B** (OAuth error-code correction, stdio header/query rejection fix, decide mutex story or document the race). Touches `src/mcp/mcp-service.ts`, `src/mcp/mcp-oauth-provider.ts`, `src/mcp/mcp-oauth-state-kv.ts`. May touch fixture (`e2e/helpers/oauth-mcp-server.ts`) for B.4 verification.

3. **Commit 3 — Batch C** (lazy 401 refresh test, state-TTL expiry test, refresh-failure test, stdio negative tests, cli-headless assertion tightening, fixture-factory consolidation). Touches `test/mcp-oauth-refresh.test.ts`, `test/mcp-oauth.test.ts`, `test/mcp-stdio-integration.test.ts`, `e2e/helpers/`, `e2e/cli-headless/mcp.e2e.ts`. Matrix gate required.

4. **Commit 4 — Batch D** (comment cleanup + the line-233 cast). Touches `src/mcp/mcp-service.ts`, `src/mcp/mcp-client.ts`. No behavioural change.

5. **Commit 5 — Batch E** (browser/chrome-ext/http+ws discover+register slashes + matching e2e-ui spec). Touches `test-apps/browser/src/client/lib/commands.ts`, `e2e-ui/shared/mcp-oauth.spec.ts` (or sibling new spec). Matrix gate required.

6. **Commit 6 — Batch F** (CLAUDE.md + spec sync). Docs only.
