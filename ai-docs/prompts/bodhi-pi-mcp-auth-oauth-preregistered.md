# bodhi-pi MCP — auth=oauth-preregistered re-introduction

## Status going in

The first MCP rollout shipped `auth=oauth-preregistered` as a mode value on `McpAuthConfig` without any flow code, validation, or test. It was deleted in commit `6a3966f4` alongside `oauth-dcr` (cleanup plan `ai-docs/plans/prepare-clean-up-plan-crispy-moler.md`). This prompt re-introduces it on top of the OAuth-DCR work.

**Sequence prerequisite.** Land `ai-docs/prompts/bodhi-pi-mcp-auth-oauth-dcr.md` first. Pre-registered shares the OAuth state machine + callback machinery; the only difference is *where* the client credentials come from (offline-provided vs auto-registered).

## What pre-registered means

Some MCP servers do not allow Dynamic Client Registration. The operator hands you a `client_id` (and often a `client_secret`) out-of-band — via a developer console, a config file, an environment variable. The flow is otherwise identical to DCR:

1. User adds the MCP with the pre-issued credentials.
2. User runs `/mcp oauth start` → bodhi-pi composes the authorize URL using the pre-registered `client_id`.
3. User consents in browser; callback delivers `code`.
4. `/mcp oauth finish` exchanges code → access token + refresh token, stores in kv.
5. Token refresh from then on is automatic.

The DCR registration endpoint call (`POST /register`) is the only step skipped.

## Goal

Extend the surface produced by the oauth-dcr prompt so that:

- `McpAuthMode` includes `"oauth-preregistered"`.
- `McpAuthConfig` accepts `clientId` (required) + `clientSecret` (optional — public-client flows omit it).
- `_bodhi-pi/mcp/add` validates: if `mode === "oauth-preregistered"`, `clientId` is required; reject with `-32602` otherwise. (This was a real bug in the prior implementation — see review finding A.5 at `ai-docs/reviews/2026-05-16-bodhi-pi-mcp-cleanup.md`.)
- The OAuth state machine (`KvOAuthProvider`-equivalent) skips the DCR registration step and reads `client_id`/`client_secret` from kv on first use.
- All hosts that grew slash UX for DCR also accept the pre-registered shape — for cli: `/mcp add url=… auth=oauth-preregistered client_id=… [client_secret=…]`. Browser/chrome-ext via their form UI.

## Process — iterative TDD across the matrix

Same shape as the OAuth-DCR prompt — depth-first per runtime, integration → e2e → e2e-ui, one commit per slice.

The unit-test fixture OAuth server you built for DCR adds a "no DCR allowed" mode where `POST /register` returns 405. The pre-registered tests use that mode.

1. **Integration.** `packages/bodhi-pi/test/mcp-oauth-preregistered.test.ts` — drive `EXT_MCP_ADD` with `auth: { mode: "oauth-preregistered", clientId, clientSecret }`; assert kv contains the credentials, then drive `EXT_MCP_OAUTH_START` → assert authorize URL uses the pre-registered client_id (no DCR call made); drive `EXT_MCP_OAUTH_FINISH` with a faux code → assert tokens persist.
2. **e2e direct-ACP** — same fixture OAuth server in "no DCR allowed" mode. One spec covers add → connect → tool call flow.
3. **e2e-ui CLI.** Add `client_id=` / `client_secret=` parsing to `parseMcpAddArgs` (`packages/bodhi-pi/src/client/mcp-slash.ts`). cli-headless drives the slash + simulates the consent step.
4. **e2e-ui Playwright.** Browser test-app form takes the credentials; spec drives add + consent + tool list.

## Design choices to resolve

- **Validation timing.** `_bodhi-pi/mcp/add` should reject missing `client_id` immediately, OR `_bodhi-pi/mcp/oauth/start` should reject only at flow start. Earlier is better but the former couples add to oauth knowledge — pick one.
- **client_secret secrecy.** It's a secret — must be tagged `{ value, secret: true }` in kv so it masks on `EXT_KV_GET` reads. Confirm masking works.
- **Bootstrap from environment.** Some users will pre-register many MCPs via an env var or config file. Worth designing a `BODHI_PI_MCP_PRECONFIGURED_CLIENTS` hook that pre-populates kv at host startup, or leave that for a later milestone? Recommendation: leave for later; first cut uses `/mcp add` only.
- **Re-registration.** If `client_secret` rotates, what's the UX — `/mcp add` again with the same `url=` (current slug collision logic would suffix with `-<hex>`)? Or a `/mcp credentials <slug> client_secret=…` subcommand?

## Gate-check + commit cadence

Same as the DCR prompt. Run the full matrix between runtime slices.

## References

- DCR companion prompt: `ai-docs/prompts/bodhi-pi-mcp-auth-oauth-dcr.md`
- OAuth 2.0 RFC 6749: <https://datatracker.ietf.org/doc/html/rfc6749>
- Confidential vs public clients: RFC 6749 §2.1
- Prior bodhi-pi shape: `git show 6a3966f4 -- packages/bodhi-pi/src/mcp/mcp-types.ts packages/bodhi-pi/src/mcp/mcp-oauth-host-api.ts` (pre-cleanup)
- Surviving public-only types: `packages/bodhi-pi/src/mcp/mcp-types.ts`
- Cleanup review finding A.5: `ai-docs/reviews/2026-05-16-bodhi-pi-mcp-cleanup.md`

## Out of scope

- DCR (handled by `bodhi-pi-mcp-auth-oauth-dcr.md`).
- Bootstrap-from-env (deferred — see above).
- Cross-tenant credential sharing.
