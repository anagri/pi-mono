# bodhi-pi MCP — `auth = oauth-preregistered` re-introduction

## Status going in

`bodhi-pi` currently ships two MCP auth modes on HTTP-streamable transport:

- `auth = "public"` — no credentials
- `auth = "http-param"` — static `headers` and/or `queries` attached to every request (slices 1-8 of `ai-docs/plans/ai-docs-prompts-bodhi-pi-mcp-auth-heade-sequential-wren.md`, committed `335de262…001187df`)

The earlier OAuth rollout (deleted in commit `6a3966f4`) shipped `oauth-preregistered` and `oauth-dcr` as enum values on `McpAuthConfig` without any flow code, validation, or e2e coverage. This prompt re-introduces `oauth-preregistered` **only** — see § Out of scope.

> **Trunk-based:** this work follows the repo convention spelled out in `packages/bodhi-pi/CLAUDE.md` § Trunk-based development. No PRs, no review branches. Each slice lands on `main` as a green commit.

## Scope of this prompt

Add a third top-level `auth` discriminator on `_bodhi-pi/mcp/add`:

```text
/mcp add {"url":"https://example/mcp", "auth":"oauth-preregistered",
          "client_id":"...", "client_secret":"...",       // both pre-issued, no DCR
          "authorize_url":"...", "token_url":"...",       // both explicit, no .well-known discovery
          "scopes":["repo","read"],
          "redirect_uri":"..."                            // optional override per runtime
}
```

Build the full **authorization-code-with-PKCE** state machine end-to-end across all four reference Hosts, with a fixture OAuth server that mirrors `e2e/helpers/auth-mcp-server.ts` for http-param.

**Skip entirely**: dynamic client registration (DCR), authorization-server metadata discovery (RFC 8414), implicit / device-code / client-credentials grant types, resource indicators (RFC 8707).

## Locked design decisions (do not re-litigate)

These were resolved in the kickoff conversation; treat them as fixed inputs.

| # | Decision | Reasoning |
|---|---|---|
| 1 | **Always require PKCE S256** | OAuth 2.1 best practice; MCP servers that don't support PKCE are unsupported. One code path. |
| 2 | **`client_secret` allowed on browser + chrome-ext runtimes** | Stored as `{value, secret: true}` in the runtime's KvStore (Dexie). User takes the exposure risk — same trust model as their api keys + http-param headers already in there. Mask on ACP reads, document the risk in `mcp.md`. |
| 3 | **CLI `redirect_uri` defaults to `http://localhost:7777/callback`**; user-overridable per `/mcp add` | Most flexible. Bind the port on demand for the duration of the flow; release after. Port conflict → clear error. |
| 4 | **HTTP/WS callback path is shared `/oauth/callback`; user+slug encoded in `state`** | One redirect_uri to pre-register. State is already required for CSRF; doubling it as the routing key is clean. State entries live in short-TTL kv (~5 min). |
| 5 | **Token exchange (`code → token`) always happens host-side** | Including browser (worker can fetch the token endpoint) and chrome-ext (service worker can fetch). Client never holds the `client_secret`. |
| 6 | **Code capture varies per runtime** — see § Per-runtime architecture | This is the load-bearing architectural split. |
| 7 | **Agent loop is oblivious** | Same as http-param: auth attachment happens inside the MCP connection layer. `pi-agent-core` types untouched. |
| 8 | **Persisted shape extends `McpAuthConfig` union, doesn't replace it** | `oauth-preregistered` is a fourth-variant `{mode, …}` object; existing `"public"` and `"http-param"` entries keep working byte-for-byte. |

## Canonical OAuth 2.1 authorization-code-with-PKCE flow

```text
┌──────────┐  /mcp oauth start <slug>           ┌──────┐
│  Client  │ ──────────────────────────────────►│ Host │
└──────────┘                                    └──────┘
     │                                              │ 1. Generate code_verifier (random ~64 bytes)
     │                                              │    code_challenge = base64url(SHA256(verifier))
     │                                              │    state = random ~32 bytes
     │                                              │    Persist {state → {slug, codeVerifier, redirectUri, expiresAt}}
     │       {authorize_url}                        │ 2. authorize_url = authorize_url + ?
     │ ◄────────────────────────────────────────────┤    response_type=code &
     │                                              │    client_id=… &
     │                                              │    redirect_uri=… &
     │                                              │    scope=… &
     │                                              │    state=… &
     │                                              │    code_challenge=… &
     │                                              │    code_challenge_method=S256
     │
     │ 3. Open authorize_url in browser (mechanism varies per runtime — see below)
     │
     │ 4. User authenticates with OAuth provider, grants consent
     │
     │ 5. OAuth provider redirects browser to redirect_uri?code=…&state=…
     │
     │ 6. Code capture (varies per runtime — see below)
     │
     │ 7. Host: validate state, look up codeVerifier, POST to token_url:
     │     {grant_type=authorization_code, code, redirect_uri, client_id,
     │      [client_secret], code_verifier}
     │
     │ 8. Host: persist tokens {access, refresh?, expiresAt, tokenType} under
     │    auth.tokens of the McpServerEntry; all values tagged secret:true.
     │
     │       mcp_oauth_status_change{slug, status:"completed"}
     │ ◄────────────────────────────────────────────┤
     │                                              │
     │ 9. /mcp connect <slug> now uses tokens — sends `Authorization: Bearer <access>`
     │    on every MCP request. On 401, refresh via refresh_token if present, else
     │    re-trigger the interactive flow.
     │
```

All four runtimes implement the same nine-step flow. **Only step 6 (code capture) and the URL-opening mechanism at step 3 differ.**

## Per-runtime architecture

### CLI (`packages/bodhi-pi/test-apps/cli`)

| Concern | Owner | Mechanism |
|---|---|---|
| State machine + PKCE generation | host | in-process |
| `authorize_url` composition | host | returns to client |
| URL opening | client | print to stdout + best-effort `child_process.spawn("open"/"xdg-open"/"start", [url])` |
| Redirect server | host | ephemeral `http.createServer` bound to `127.0.0.1:7777` for the duration of one flow |
| Code capture | host | redirect server's `GET /callback` handler reads `?code=…&state=…` |
| Code → token | host | `fetch(token_url, …)` from the host process |
| Notification | host | `mcp_oauth_status_change` ACP notification; `/mcp oauth start` slash blocks until status emitted or timeout |

CLI is the only runtime where the host owns the redirect listener. Port collision → `/mcp oauth start` returns `error: port 7777 in use; pass redirect_uri=… on /mcp add to override`.

### HTTP (`packages/bodhi-pi/test-apps/http`, HTTP+SSE on `/acp`)

| Concern | Owner | Mechanism |
|---|---|---|
| State machine + PKCE | host (server side) | per-user kv prefix |
| `authorize_url` composition | host | redirect_uri = `${SERVER_BASE_URL}/oauth/callback` |
| URL opening | client (React frontend) | `window.open(authorize_url, "oauth")` popup |
| Redirect server | host | existing http server; new HTTP route (not ACP) `GET /oauth/callback` |
| Code capture | host (`/oauth/callback` handler) | decodes `state` → `{userId, slug, codeVerifier}`, hands off to `McpService` |
| Code → token | host | `fetch(token_url, …)` from server |
| Notification | host → client | `mcp_oauth_status_change` lifecycle notification down the open SSE/WS channel for that user |

Server must know its own base URL (for composing `redirect_uri`). Resolution: `Host` header on the inbound ACP call, OR a server-startup flag `--public-base-url`. See open question #8.

### WS (`packages/bodhi-pi/test-apps/http` with WebSocket transport on `/acp-ws`)

Identical to HTTP. The same `/oauth/callback` HTTP route handles the redirect; the notification fires down the open WebSocket instead of SSE. Per-connection stateful agent means in-memory state-kv is also an option, but stick with per-user kv for consistency with HTTP.

### Browser (`packages/bodhi-pi/test-apps/browser`, Vite+React+Worker)

| Concern | Owner | Mechanism |
|---|---|---|
| State machine + PKCE | host (Worker) | Dexie kv |
| `authorize_url` composition | host | redirect_uri = `${window.location.origin}/oauth/callback` — main thread passes `origin` to Worker at init |
| URL opening | client (main React thread) | `window.open(authorize_url, "oauth", "popup")` |
| Redirect server | client (React route) | a dedicated `/oauth/callback` route renders in the popup window |
| Code capture | client (popup) → host (Worker) | popup's React component parses `?code=…&state=…`, `window.opener.postMessage({code, state})`, then `window.close()`. Main thread receives postMessage → calls `_bodhi-pi/mcp/oauth/finish` over the MessagePort |
| Code → token | host (Worker) | `fetch(token_url, …)` from Worker context |
| Notification | host → client | `mcp_oauth_status_change` |

Browser is the only runtime where the client (popup window) physically captures the redirect. The host stays involved for everything secret. This means the wire surface needs **two** methods: `oauth/start` (returns URL) and `oauth/finish` (client hands back `{code, state}`).

### Chrome-ext (`packages/bodhi-pi/test-apps/chrome-ext`, MV3)

| Concern | Owner | Mechanism |
|---|---|---|
| State machine + PKCE | host (service worker) | Dexie kv |
| `authorize_url` composition | host | redirect_uri = `chrome.identity.getRedirectURL()` → `https://<ext-id>.chromiumapp.org/` |
| URL opening + redirect capture | host (service worker) | `chrome.identity.launchWebAuthFlow({url, interactive: true})` — Chrome opens its managed window and returns the full redirect URL synchronously after the user completes |
| Code → token | host (service worker) | `fetch(token_url, …)` from service worker |
| Notification | host → client | response of the `oauth/start` call (it blocks for the whole flow, since `launchWebAuthFlow` blocks) |

Chrome-ext is the only runtime where the **host opens the URL itself** — the chrome.identity API owns the whole interactive piece. Manifest must declare `"identity"` permission. Some OAuth providers reject the `chromiumapp.org` scheme; document this constraint.

## Wire surface to design

The next session resolves the exact shapes. These are the methods that must exist (working names):

```text
_bodhi-pi/mcp/oauth/start    → {authorize_url, state}            // all runtimes
_bodhi-pi/mcp/oauth/finish   → {status: completed|failed, …}     // browser only — receives {code, state} from popup
_bodhi-pi/mcp/oauth/cancel   → {ok}                              // optional — for in-flight flows
```

Plus a new lifecycle event:

```text
mcp_oauth_status_change      // {slug, status: started|completed|failed|cancelled, errorMessage?}
```

`mcp_status_change` (existing) stays for connect/disconnect; oauth gets its own channel so UIs can render the "click here to authenticate" affordance independently.

The persisted `McpAuthConfig` union extends with:

```ts
| { mode: "oauth-preregistered";
    authorizeUrl: string;
    tokenUrl: string;
    clientId: string;
    clientSecret?: McpNamedSecret;          // optional for public clients
    scopes?: string[];
    redirectUri?: string;                   // optional override (cli mostly)
    tokens?: {
      access: McpNamedSecret;
      refresh?: McpNamedSecret;
      expiresAt?: number;                   // unix epoch ms
      tokenType?: string;                   // usually "Bearer"
    };
  }
```

## Open questions for the next session

These need to be resolved during exploration / implementation. Each has a recommendation; the next session should grill it and document the final decision before writing the implementation plan.

1. **Token refresh trigger** — eager (on every connect, check `expiresAt` with 60s slack and refresh if stale) vs lazy (refresh only on 401 from MCP server). **Recommend: both.** Eager catches the common case; lazy is a fallback for clock skew / server early-revoke.
2. **Refresh failure recovery** — if refresh fails (refresh_token expired/revoked), drop the tokens, mark the entry needs-reauth, surface via `mcp_oauth_status_change{status:"failed"}`, require `/mcp oauth start` to retrigger the interactive flow.
3. **Validation timing for `client_id`** — at `/mcp add` (fail-fast, my preference) vs at `/mcp oauth start` (allows partial entries). **Recommend: at `/mcp add`.**
4. **`authorize_url` + `token_url`** — both REQUIRED on `/mcp add` since we skip discovery. **Already locked** but call out in `mcp.md` so users aren't surprised.
5. **Auth flow timeout** — how long does the host wait for the callback before timing out the state entry? **Recommend: 5 minutes**, configurable later.
6. **HTTP-runtime `SERVER_BASE_URL` resolution** — three options: `Host` header on the inbound ACP request, `--public-base-url` startup flag, or a hard-coded `BODHI_PI_PUBLIC_BASE_URL` env. **Recommend: startup flag with `Host`-header fallback** — explicit when needed, implicit when not.
7. **Browser-runtime popup blocking** — `window.open` is blocked unless triggered by a user gesture. The slash command that fires `oauth/start` is a user gesture (Enter key) so the chain works; document this.
8. **Chrome-ext popup UX vs service-worker UX** — `chrome.identity.launchWebAuthFlow` works from both popup and service worker contexts. Decide which based on whether the flow needs to survive popup close. **Recommend: service worker** for resilience.
9. **Concurrent flows** — what if a user types `/mcp oauth start a` then `/mcp oauth start b` before the first redirect lands? Each flow has its own `state` token so they don't interfere; the state TTL kv just accumulates entries. No special handling needed; cap concurrent flows per user at e.g. 5 to bound state-kv growth.
10. **`Authorization: Bearer <access>` attachment on MCP requests** — the http-param work already wired headers via `StreamableHTTPClientTransport`'s `requestInit`. Token mode reuses the same path. The trick is the access token may need refreshing between requests within a long-lived MCP connection — handled by a `requestInit` builder that reads the latest token from kv on every request, OR by intercepting 401 and triggering a refresh+retry. **Recommend: read kv per request initially; optimize later if it's a perf problem.**
11. **Test fixture OAuth server** — mirror `e2e/helpers/auth-mcp-server.ts`. Implement `/authorize` (returns a redirect to `redirect_uri?code=…&state=…`), `/token` (validates PKCE + client_id, returns access+refresh tokens), and `/mcp` (existing — now requires `Authorization: Bearer …`). Hand-roll; the SDK doesn't ship an OAuth provider. Token issued is opaque random; introspection not needed.
12. **Token endpoint auth method** — `client_secret_basic` vs `client_secret_post` (RFC 6749 §2.3.1). **Recommend: support both via a `tokenAuthMethod?: "basic" | "post"` field on `McpAuthConfig`, default `basic`** — most providers accept basic, some require post.
13. **Scope rendering** — single string with space-separated values per RFC 6749 §3.3. Input shape `scopes: string[]` joined by space at request time.
14. **Per-runtime e2e coverage** — each runtime needs its own e2e for the interactive flow:
    - cli: cli-headless e2e drives `/mcp oauth start`, the test harness controls the fixture OAuth server to auto-approve (no real browser interaction needed in the test).
    - http/ws: Playwright drives the popup flow against the fixture OAuth server's `/authorize` (which is a trivial HTML page with one "Approve" button).
    - browser: Playwright same as http/ws.
    - chrome-ext: Playwright + stub `chrome.identity.launchWebAuthFlow` to return the fixture's callback URL directly (since real chrome-identity windows can't be driven by Playwright easily).
    All four runtimes share `e2e/helpers/oauth-mcp-server.ts` from global-setup.

## Process for the next session

This prompt is **not** a final implementation plan. Pick it up like this:

1. **Read the http-param landing** (`git log --oneline cb14de30..main`, files: `packages/bodhi-pi/src/mcp/`, `packages/bodhi-pi/test/mcp-auth.test.ts`, `packages/bodhi-pi/e2e/helpers/auth-mcp-server.ts`, `ai-docs/plans/ai-docs-prompts-bodhi-pi-mcp-auth-heade-sequential-wren.md`). The patterns there — discriminated `McpAuthConfig`, in-process fixture server with CORS, per-runtime `.e2e.ts` propagation, per-test-app vitest scaffolding — are the templates to follow.
2. **Explore the four reference Hosts** to confirm the per-runtime architecture sketch above survives contact with reality. Focus on:
   - `test-apps/cli/src/host/agent.ts` — where to inject the redirect-server lifecycle
   - `test-apps/http/src/host/server.ts` and `wire-agent-shared.ts` — where to add the `/oauth/callback` HTTP route
   - `test-apps/browser/src/host/runtime/bootstrap-worker.ts` and the React app's routing — where to add the `/oauth/callback` route + popup → opener postMessage handler
   - `test-apps/chrome-ext/manifest.json` — confirm `identity` permission can be added; check chrome.identity API surface from MV3 service workers
3. **Ask follow-up questions via `AskUserQuestion`** on the open questions in the previous section that you can't decide alone. Pay particular attention to #6 (server base URL), #8 (chrome-ext popup vs SW), and #10 (Bearer attachment refresh strategy).
4. **Write the implementation plan** as a separate file under `ai-docs/plans/` (use the slice/commit pattern from the http-param plan). Sketch the slices, then expand them after the open questions are resolved.
5. **Execute** the plan slice by slice, **trunk-based**: commits land on `main` directly, each commit independently passes `npm run check`, `npm test`, and the relevant matrix subset. After every 2-3 slices, run full `just test-e2e` + `just test-e2e-ui` and bisect any regressions.
6. **Same-commit spec updates** per `packages/bodhi-pi/CLAUDE.md` — touched ACP surface → update `acp.md`; auth-mode table grows → update `mcp.md`; new glossary terms → `CONTEXT.md`.

## Suggested slice shape (sketch only — next session reshapes)

The http-param work was 8 slices ending up as 4 commits on `main`. OAuth is bigger; expect 10-14 slices grouped into 5-7 commits.

Approximate grouping (let the next session refine):

1. **Types + fixture OAuth server** — extend `McpAuthConfig`, write `e2e/helpers/oauth-mcp-server.ts` (PKCE-validating mini OAuth provider with `/authorize` + `/token`), integration test of the state machine using the fixture
2. **Core handler: `_bodhi-pi/mcp/oauth/start` + `/finish` + `/cancel`** — server-side state generation, kv persistence, token exchange, event emission. Integration tests only.
3. **CLI runtime** — ephemeral redirect server in host, cli-headless e2e
4. **HTTP + WS runtime** — `/oauth/callback` HTTP route on the existing server, multi-tenant state lookup via `state` parameter, integration test for cross-user isolation, Playwright e2e
5. **Browser runtime** — React `/oauth/callback` route, popup→opener postMessage, Worker handles `oauth/finish`, Playwright e2e
6. **Chrome-ext runtime** — `identity` manifest permission, `chrome.identity.launchWebAuthFlow` from service worker, Playwright e2e (with stubbed chrome.identity)
7. **Token refresh + 401 retry** — applies to all runtimes uniformly inside the MCP connection layer; integration test forcing token expiry mid-flow
8. **Specs + glossary** — `mcp.md` § Auth table grows, `acp.md` rows for the new EXT methods + lifecycle event, `CONTEXT.md` glossary entries for OAuth-flow concepts

## Out of scope

- **Dynamic Client Registration (DCR)** — file separately under `ai-docs/prompts/bodhi-pi-mcp-auth-oauth-dcr.md` after this lands. The OAuth state machine here will be reusable.
- **Authorization-server metadata discovery** (RFC 8414 `/.well-known/oauth-authorization-server`) — explicit `authorize_url` + `token_url` on `/mcp add` is the contract.
- **MCP-server resource indicators** (RFC 8707) — not needed for the per-server token model bodhi-pi uses.
- **OAuth scopes UI / per-tool scope mapping** — the user enters whatever scopes the MCP server expects, no introspection.
- **Implicit / device-code / client-credentials grant types** — authorization-code-with-PKCE is the only flow supported.
- **OAuth proxying / shared client** — every user authenticates as themselves with their own pre-issued credentials; no aggregator pattern.
- **Stdio transport OAuth** — stdio has no HTTP auth concept; reject `auth: "oauth-preregistered"` when `transport === "stdio"` at `/mcp add` time (`-32602`).

## References

- Companion prompts:
  - `ai-docs/prompts/bodhi-pi-mcp-auth-header-query.md` — sibling prompt for the http-param work that just landed
  - `ai-docs/prompts/bodhi-pi-mcp-auth-oauth-dcr.md` — future DCR work, builds on this
- http-param landing (the pattern to follow):
  - Plan: `ai-docs/plans/ai-docs-prompts-bodhi-pi-mcp-auth-heade-sequential-wren.md`
  - Commits: `335de262` (core) → `f1564d1d` (test migration) → `5a5fc149` (fixture + auth e2e + adapters) → `001187df` (cli + Playwright + http integration)
- Prior bodhi-pi OAuth shape (deleted): `git show 6a3966f4 -- packages/bodhi-pi/src/mcp/mcp-types.ts packages/bodhi-pi/src/mcp/mcp-oauth-host-api.ts`
- Cleanup review with the bug-list to avoid: `ai-docs/reviews/2026-05-16-bodhi-pi-mcp-cleanup.md` (findings A.5, A.6 specifically about OAuth)
- RFCs / specs:
  - OAuth 2.0 — RFC 6749 <https://datatracker.ietf.org/doc/html/rfc6749>
  - PKCE — RFC 7636 <https://datatracker.ietf.org/doc/html/rfc7636>
  - OAuth 2.0 for Native Apps — RFC 8252 <https://datatracker.ietf.org/doc/html/rfc8252>
  - OAuth 2.1 draft — <https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1>
- MCP architecture: `ai-docs/specs/bodhi-pi/mcp.md` (esp. § Auth after http-param landed)
- Trunk-based development convention: `packages/bodhi-pi/CLAUDE.md` § Trunk-based development
