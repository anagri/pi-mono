# bodhi-pi MCP — auth=oauth-dcr re-introduction

## Status going in

The first MCP rollout in bodhi-pi shipped OAuth Dynamic Client Registration scaffolding (`KvOAuthProvider`, `runAuthFlow`, `EXT_MCP_OAUTH_START`/`FINISH`) without an end-to-end test at any layer. It was deleted in commit `6a3966f4` as part of the MCP cleanup (`ai-docs/plans/prepare-clean-up-plan-crispy-moler.md`). This prompt is the re-introduction.

You will rebuild OAuth-DCR alongside its e2e and e2e-ui from commit 1 so the same gap does not recur.

## What still exists

The post-cleanup MCP surface (see `ai-docs/plans/2026-05-16-mcp-target-spec.md`):

- 9 extension methods: `_bodhi-pi/mcp/{add,remove,connect,disconnect,reconnect,list,tools,include,exclude}`.
- Types in `packages/bodhi-pi/src/mcp/mcp-types.ts` — `McpAuthMode = "public"`, `McpAuthConfig = { mode }`. Both will need to grow.
- `McpService` decomposed into `McpStore` + `McpConnectionLifecycle` + a slim facade. Lifecycle broadcasts (`mcp_status_change`, `mcp_tools_change`) are working.
- Per-session `mcp_inclusion_set` log entries restore inclusion on `session/load`/`session/resume`.
- Per-host slash parser: shared `parseMcpAddArgs` in `src/client/mcp-slash.ts` (currently public-only — `url=`, `command=`, `args=`, `env_<NAME>=`, `label=`).

## What got deleted (study before designing)

Look at `git show 6a3966f4` to see the prior shape. Specifically:

- `packages/bodhi-pi/src/mcp/mcp-oauth-host-api.ts` (`KvOAuthProvider` implementing `OAuthClientProvider`, `runAuthFlow`, `DEFAULT_OAUTH_CLIENT_NAME`).
- `packages/bodhi-pi/src/mcp/mcp-service.ts` had `handleOAuthStart`/`handleOAuthFinish` handlers + `parseAuthParam` accepting `oauth-dcr`/`oauth-preregistered`.
- `packages/bodhi-pi/src/wire/constants.ts` exported `EXT_MCP_OAUTH_START`/`EXT_MCP_OAUTH_FINISH`.
- Tests at `packages/bodhi-pi/src/mcp/mcp-oauth-host-api.test.ts` — unit only, no e2e, no e2e-ui.

You are free to reuse, adapt, or start over. The prior code was clean enough to lift if it fits the post-cleanup shape; if `McpStore`/`McpConnectionLifecycle` make a tighter pluggable seam available, take it.

## Goal

`auth=oauth-dcr` lets a user connect to an MCP server that requires OAuth. The server publishes its OAuth metadata (`.well-known/oauth-authorization-server` or via MCP's discovery hooks); the client (bodhi-pi agent) auto-registers itself as an OAuth client (DCR — Dynamic Client Registration per RFC 7591), then runs the authorization-code flow. The user does the consent step in a browser; the callback returns tokens; bodhi-pi stores them in kv and uses them as a Bearer header on every MCP request.

The runtime split makes "where the callback lands" a per-host question:

| Runtime | Callback strategy |
|---|---|
| cli | loopback HTTP server bound to `127.0.0.1:<random>`; print URL, wait for code |
| http test-app | server-side route `/oauth/callback`; same-origin redirect |
| ws test-app | same as http |
| browser test-app | same-origin callback page + `BroadcastChannel` from the popup back to the worker |
| chrome-ext | `chrome.identity.launchWebAuthFlow(...)` returning the redirected URL |
| in-memory | no real callback — drive a fake authorize URL + injected code via `EXT_MCP_OAUTH_FINISH` |

The agent owns the state machine; the host owns the UX. Decide where the seam goes.

## Process — iterative TDD across the matrix

Per `feedback_e2e_coverage_keeps_feature` and the `packages/bodhi-pi/CLAUDE.md` 6-step workflow: a variant is "done" only when it has at least one of `{e2e, cli-headless, Playwright}` per supported runtime. Integration-only is not enough.

Recommended depth-first sequence — finish each runtime end-to-end before moving on:

1. **Integration first.** `packages/bodhi-pi/test/` — drive `_bodhi-pi/mcp/oauth/start` + `oauth/finish` end-to-end through a faux OAuth server (a tiny Node `http.createServer` exposing the DCR registration endpoint + authorize + token endpoints). Faux providers, no real network. Cover happy path + token-refresh + invalid-code.
2. **e2e direct-ACP (in-memory + cli + http + ws).** `packages/bodhi-pi/e2e/shared/mcp-oauth-dcr.e2e.ts` — start a real OAuth-protected MCP (could be a fixture server you ship in `e2e/helpers/oauth-server/`); have the client drive `_bodhi-pi/mcp/oauth/start` → simulate user consent → `_bodhi-pi/mcp/oauth/finish` → assert connection comes up. Runtime-gate where loopback callback machinery can't run.
3. **e2e-ui CLI.** Extend `packages/bodhi-pi-cli/src/repl/commands.ts` with the loopback-callback flow and the `/mcp logout <slug>` token-clearing command (deleted in cleanup; re-add). `packages/bodhi-pi/e2e/cli-headless/mcp-oauth-dcr.e2e.ts` drives via stdin/stdout.
4. **e2e-ui Playwright.** Browser test-app spins up the same fixture OAuth server in `global-setup.ts`. Playwright drives the slash command + simulates the consent step + asserts the toolset appears. Chrome-ext spec uses `chrome.identity.launchWebAuthFlow`.

For each step: write the failing test first, make it pass, refactor, retro between runtimes for shared helpers (likely a fixture OAuth server + a callback-helper abstraction).

## Open exploration questions to resolve before designing

These are the design choices that fell out of the original implementation without being justified. Pick them deliberately this time:

- **Callback seam location.** Should the agent define a `McpOAuthCallbackHandler` interface (one per host) and inject it via `BodhiPiConfig`, the way `McpConnectionProvider` is injected today? Or stay with the current "client owns the callback" shape where `_bodhi-pi/mcp/oauth/start` returns an `authorizeUrl` and the client side does whatever fits the runtime?
- **Token refresh.** Where does refresh happen — in `connectMcp` on 401 (interceptor-style)? In a periodic timer? On the next `EXT_MCP_CONNECT`? Each has tradeoffs for stateless-rebuild hosts (`bodhi-pi-http`).
- **Storage.** Tokens go into the same `mcp/<slug>` kv entry under `auth.tokens`. The masking layer (`maskSecrets` in `kv/kv-store.ts`) already masks `{ secret: true }` values on ACP reads — confirm the round-trip works for nested oauth tokens without leaking access tokens via `EXT_KV_GET`.
- **Logout.** What does `/mcp logout <slug>` mean — clear tokens only, or also clear `client_id`/`client_secret` so a fresh DCR registration runs next time? In the original code (`packages/bodhi-pi-cli/src/repl/commands.ts`) it cleared only tokens.
- **Browser callback channel.** Same-origin `<iframe>`-style postMessage, or `BroadcastChannel`, or `window.open(...)` + polling? Pick one and document.
- **stateless rebuild interaction.** `bodhi-pi-http` rebuilds the agent per request. The OAuth state machine's intermediate state (`codeVerifier`, `state`) — where does it live during the redirect roundtrip? In kv? Memory in the host? Decide.

Use `AskUserQuestion` for any of these you can't resolve from the code + plan docs.

## Gate-check + commit cadence

- One commit per runtime slice (`feedback_phasing_depth_first`).
- After each commit run the matrix: `npm run -w packages/bodhi-pi test`, `npm run -w packages/bodhi-pi e2e`, `npm run -w packages/bodhi-pi e2e:ui`, `npm run -w packages/bodhi-pi-cli e2e`.
- Refactor / retro between runtimes — pull duplicated callback machinery into a shared helper as patterns emerge.
- Final commit: any cross-runtime cleanup + the docs update (`packages/bodhi-pi/CLAUDE.md` MCP section, `ai-docs/plans/2026-05-16-mcp-current-spec.md` and `target-spec.md` re-flow).

## References

- MCP authorization spec: <https://modelcontextprotocol.io/specification/draft/basic/authorization>
- RFC 7591 (Dynamic Client Registration): <https://datatracker.ietf.org/doc/html/rfc7591>
- RFC 8252 (OAuth 2.0 for Native Apps — loopback callback): <https://datatracker.ietf.org/doc/html/rfc8252>
- MCP SDK's `OAuthClientProvider`: `@modelcontextprotocol/sdk/client/auth.js` — the type contract `KvOAuthProvider` used to implement
- Prior bodhi-pi implementation: `git show 6a3966f4 -- packages/bodhi-pi/src/mcp/mcp-oauth-host-api.ts packages/bodhi-pi/src/mcp/mcp-service.ts`
- Surviving public+http shape (the contract you extend): `packages/bodhi-pi/src/mcp/`
- Per-session-inclusion architecture: `ai-docs/prompts/bodhi-pi-mcp-global-state-with-per-session-inclusion.md` (already wired)
- Companion variant prompts that share infrastructure: `ai-docs/prompts/bodhi-pi-mcp-auth-oauth-preregistered.md`, `ai-docs/prompts/bodhi-pi-mcp-auth-header-query.md`

## Out of scope

- Provider-side OAuth (the agent's *own* auth — handled separately via `auth/*` kv).
- Refresh-token rotation policy beyond the basic "use refresh_token when access_token is 401".
- Multi-account-per-MCP (one slug = one OAuth identity for now).
- `bodhi-pi-http` production semantics — the test-apps' simplified callback flow is the reference.
