# bodhi-pi MCP — `auth = oauth-preregistered` implementation plan

## Context

The prompt at `ai-docs/prompts/bodhi-pi-mcp-auth-oauth-preregistered.md` asks to re-introduce a third `McpAuthConfig` discriminator — `oauth-preregistered` — alongside the just-landed `"public"` and `"http-param"` modes. A previous OAuth implementation existed (deleted in `6a3966f4`) but shipped without flow code, validation, or e2e coverage, and was flagged by `ai-docs/reviews/2026-05-16-bodhi-pi-mcp-cleanup.md` findings A.5 (missing `clientId` validation) and A.6 (unstructured auth attachment).

The contract is **OAuth 2.1 authorization-code-with-PKCE only**, with **no** DCR, **no** RFC 8414 metadata discovery, **no** RFC 8707 resource indicators, **no** stdio support. The user provides `authorize_url`, `token_url`, `client_id`, optional `client_secret`, optional `scopes`, optional `redirect_uri` override at `/mcp add` time; the host runs the interactive flow and persists `{access, refresh?, expiresAt}` under `auth.tokens`.

Locked decisions resolved before planning:
1. **Chrome-ext runtime gets a new MV3 background service worker** with `"identity"` permission, using `chrome.identity.launchWebAuthFlow`. Today's chrome-ext has no SW (only `worker.ts` re-exporting from browser bootstrap); this is net-new architecture.
2. **OAuth flow code wraps `@modelcontextprotocol/sdk/client/auth.OAuthClientProvider`** rather than hand-rolling PKCE / token exchange. The SDK normally discovers server metadata; we short-circuit by pre-populating `provider.discoveryState()` with the user-provided URLs so it never hits `/.well-known/oauth-authorization-server`.
3. **6 commits, depth-first per runtime**, each independently green on `main` per `packages/bodhi-pi/CLAUDE.md` § Trunk-based development.

Recommendations adopted from the prompt's "Open questions":
- **#1 Refresh trigger**: both eager (60s slack on connect) + lazy (401 retry).
- **#5 Flow timeout**: 5 minutes for state TTL.
- **#6 HTTP base URL**: `--public-base-url` startup flag with `Host` header fallback.
- **#10 Bearer attachment**: read kv per request via a `requestInit` builder closure.
- **#12 Token endpoint auth method**: `tokenAuthMethod?: "basic" | "post"`, default `"basic"`.

## Architecture

### Persisted shape — `McpAuthOAuthPreregisteredConfig`

Add a fourth variant to the discriminated union in `packages/bodhi-pi/src/mcp/mcp-types.ts`:

```ts
export type McpAuthMode = "public" | "http-param" | "oauth-preregistered";

export interface McpAuthOAuthPreregisteredConfig {
  mode: "oauth-preregistered";
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret?: McpNamedSecret;          // tagged secret:true, masked on ACP reads
  scopes?: string[];
  redirectUri?: string;                   // optional per-runtime override
  tokenAuthMethod?: "basic" | "post";     // default "basic"
  tokens?: {
    access: McpNamedSecret;
    refresh?: McpNamedSecret;
    expiresAt?: number;                   // unix epoch ms
    tokenType?: string;                   // usually "Bearer"
  };
}

export type McpAuthConfig =
  | McpAuthPublicConfig
  | McpAuthHttpParamConfig
  | McpAuthOAuthPreregisteredConfig;
```

`McpNamedSecret` auto-masking via `packages/bodhi-pi/src/kv/kv-store.ts:20-36` (`maskSecrets`) already handles `clientSecret` and `tokens.access` / `tokens.refresh`.

### Validation in `parseAuthInput`

Extend `packages/bodhi-pi/src/mcp/mcp-service.ts:274-310` to:
- Accept `"oauth-preregistered"` as a third `auth` value.
- Reject the variant when `transport === "stdio"` → `-32602`.
- Require `authorizeUrl`, `tokenUrl`, `clientId` strings → `-32602` if missing or empty (closes A.5).
- Validate `authorizeUrl` and `tokenUrl` are HTTPS URLs (allow `http://localhost*` for fixture) → `-32602`.
- Wrap `clientSecret` (if present) into `McpNamedSecret` via `recordToNamedSecrets` pattern.
- Reject sibling fields not part of this variant (`headers`, `queries`) → `-32602`.

### Auth attachment via strategy table

Refactor `packages/bodhi-pi/src/mcp/mcp-client.ts:72-86` (`buildHttpTransport`) from the current inline `if (auth.mode === "http-param")` to a `Record<McpAuthMode, AuthAttacher>` strategy table (closes A.6). Each attacher:

- `public` → no-op.
- `http-param` → append queries to `URL.searchParams`, set `requestInit.headers`.
- `oauth-preregistered` → set `requestInit` to a **function-style headers builder** that reads `auth.tokens.access.value` from the in-process `kvStore` on every request and returns `{ Authorization: "Bearer <access>" }`. This is the per-request kv read recommended in #10.

The transport keeps a reference to its `slug` so the builder can re-read kv after a refresh writes new tokens back.

### Flow code — `OAuthClientProvider` wrapper

New file `packages/bodhi-pi/src/mcp/mcp-oauth-provider.ts`:

```ts
export class KvOAuthProvider implements OAuthClientProvider {
  constructor(
    private readonly kv: KvStore,
    private readonly slug: string,
    private readonly cfg: McpAuthOAuthPreregisteredConfig,
    private readonly redirectUriResolver: () => string,
    private readonly stateKv: OAuthStateKv,           // short-TTL kv, ~5 min
  ) {}

  get redirectUrl() { return this.redirectUriResolver(); }
  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: this.cfg.tokenAuthMethod ?? "client_secret_basic",
      scope: this.cfg.scopes?.join(" "),
    };
  }
  clientInformation() { return { client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret?.value }; }
  // saveClientInformation deliberately undefined → SDK skips DCR

  // Pre-populate discovery to bypass RFC 8414:
  discoveryState() { return {
    authorizationServerUrl: this.cfg.authorizeUrl,
    authorizationServerMetadata: {
      authorization_endpoint: this.cfg.authorizeUrl,
      token_endpoint: this.cfg.tokenUrl,
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
    },
    resourceMetadata: undefined,                      // skip RFC 8707
  }; }
  saveDiscoveryState() { /* no-op, ours is static */ }

  tokens() { return this.cfg.tokens && {
    access_token: this.cfg.tokens.access.value,
    refresh_token: this.cfg.tokens.refresh?.value,
    token_type: this.cfg.tokens.tokenType ?? "Bearer",
    expires_in: this.cfg.tokens.expiresAt ? Math.max(0, Math.floor((this.cfg.tokens.expiresAt - Date.now()) / 1000)) : undefined,
  }; }
  async saveTokens(tokens) {
    // write back to kvStore as McpServerEntry.auth.tokens, secret:true on access/refresh
    const entry = await readEntry(this.kv, this.slug);
    entry.auth.tokens = {
      access: { name: "access", value: tokens.access_token, secret: true },
      refresh: tokens.refresh_token ? { name: "refresh", value: tokens.refresh_token, secret: true } : undefined,
      expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined,
      tokenType: tokens.token_type,
    };
    await this.kv.set(`mcp/${this.slug}`, serializeMcpServerEntry(entry));
  }

  redirectToAuthorization(url) { /* delegated to runtime — see per-runtime table */ }

  async saveCodeVerifier(v) { await this.stateKv.set(slug, { codeVerifier: v, expiresAt: Date.now() + 5*60*1000 }); }
  async codeVerifier() { return (await this.stateKv.get(slug)).codeVerifier; }
}
```

The `redirectToAuthorization` mechanics differ per runtime (see below); the provider exposes a hook the runtime overrides.

### Wire surface — ACP methods + lifecycle event

Three new ACP methods registered in `mcp-service.ts:76-88`:

```text
_bodhi-pi/mcp/oauth/start    {slug} → {authorize_url, state} | {status: "completed"}
_bodhi-pi/mcp/oauth/finish   {slug, code, state} → {status: "completed" | "failed", errorMessage?}
_bodhi-pi/mcp/oauth/cancel   {slug, state} → {ok: true}
```

`oauth/start` calls `auth(provider, { serverUrl: cfg.tokenUrl })`:
- If SDK returns `"AUTHORIZED"` (tokens cached + refreshable) → return `{status: "completed"}`.
- If SDK returns `"REDIRECT"` → provider captured the authorize URL; runtime returns it.

`oauth/finish` calls `auth(provider, { serverUrl, authorizationCode: code })` after validating `state`.

New lifecycle event piggybacks the existing `LIFECYCLE_EVENT_METHOD` notification path in `mcp-connection-lifecycle.ts:111-123`:

```text
mcp_oauth_status_change      {slug, status: "started" | "completed" | "failed" | "cancelled", errorMessage?}
```

`mcp_status_change` keeps owning connect/disconnect; oauth gets its own channel so UIs can render the "click to authenticate" affordance independently.

### Per-runtime architecture

| Runtime | `redirectToAuthorization` | Code capture | Code → token exchange |
|---|---|---|---|
| **CLI** | print URL + `child_process.spawn("open"/"xdg-open"/"start", [url])` | host: ephemeral `http.createServer` bound `127.0.0.1:7777`, `/callback` handler, released after flow | host (SDK `auth()`) |
| **HTTP+WS** | client (React) `window.open(url, "oauth")` | host: new `GET /oauth/callback` route on existing native http server; `state` carries `{userId, slug}` | host (SDK `auth()`) |
| **Browser** | client (React) `window.open(url, "oauth", "popup")` | client: dedicated `/oauth/callback` React route in popup, `window.opener.postMessage({code, state})`, then close; main thread relays to Worker via the existing MessagePort | host (Worker, SDK `auth()`) |
| **Chrome-ext** | host (SW) `chrome.identity.launchWebAuthFlow({url, interactive: true})` returns full redirect URL | host (SW) parses returned URL | host (SW, SDK `auth()`) |

**CLI redirect_uri** defaults to `http://localhost:7777/callback`, user-overridable per `/mcp add`. Port collision → `oauth/start` returns `error: port 7777 in use; pass redirect_uri=… on /mcp add to override`.

**HTTP+WS redirect_uri** = `${publicBaseUrl}/oauth/callback`. `publicBaseUrl` resolution order:
1. `--public-base-url` startup flag on `test-apps/http/src/host/server.ts`.
2. `Host` header on the inbound `/acp` request that triggered `oauth/start`.

**Browser redirect_uri** = `${window.location.origin}/oauth/callback`. The main thread passes `origin` to the Worker via the existing `InitMessage` in `bootstrap-worker.ts:44-72` (new field; net-new wiring).

**Chrome-ext redirect_uri** = `chrome.identity.getRedirectURL()` → `https://<ext-id>.chromiumapp.org/`. Document the constraint that some OAuth providers reject the `chromiumapp.org` scheme.

## Fixture OAuth server

New file `packages/bodhi-pi/e2e/helpers/oauth-mcp-server.ts`, modeled on `e2e/helpers/auth-mcp-server.ts`:

- `/authorize` — validates `code_challenge`, `client_id`, `state`; redirects to `redirect_uri?code=<random>&state=<state>`. For Playwright drives, returns a 1-button HTML "Approve" page; for CLI test harness, auto-approves with `?auto=1` query.
- `/token` — accepts both `client_secret_basic` (header) and `client_secret_post` (body), validates `code_verifier` against the original challenge, returns `{access_token, refresh_token, token_type, expires_in: 3600}`.
- `/mcp` — same as `auth-mcp-server.ts` but requires `Authorization: Bearer <access>`.
- Spawned by `e2e/global-setup.ts` alongside the existing fixtures (next free port).

CORS headers identical to `auth-mcp-server.ts` (already includes `Authorization`, `Access-Control-Allow-Origin: *`).

## 6-commit slice plan

Each commit lands green on `main`. Spec updates land in the same commit that touches the ACP surface (per `packages/bodhi-pi/CLAUDE.md` § Trunk-based development).

### Commit 1 — types + fixture server + state machine integration tests

- Extend `McpAuthConfig` union and `parseAuthInput` (closes A.5).
- Refactor `buildHttpTransport` to strategy table keyed by `mode` (closes A.6); `oauth-preregistered` attacher reads kv per request.
- Implement `KvOAuthProvider` in `src/mcp/mcp-oauth-provider.ts`; pre-populated `discoveryState()` short-circuits SDK discovery.
- Write `e2e/helpers/oauth-mcp-server.ts`; integrate into `e2e/global-setup.ts` and `e2e-ui/global-setup.ts`.
- Integration tests in `test/mcp-oauth.test.ts`: `parseAuthInput` happy/error paths, `KvOAuthProvider` state machine round-trip using fixture server, kv masking of `clientSecret` + `tokens.access`/`tokens.refresh`.
- Update `packages/bodhi-pi/CONTEXT.md` glossary with: OAuth tokens, PKCE, redirect URI, state parameter.
- Update `ai-docs/specs/bodhi-pi/mcp.md` § Auth table with `oauth-preregistered` row.

### Commit 2 — core ACP handlers + lifecycle event

- Register `_bodhi-pi/mcp/oauth/start`, `_bodhi-pi/mcp/oauth/finish`, `_bodhi-pi/mcp/oauth/cancel` in `mcp-service.ts`.
- Implement runtime-pluggable `RedirectAuthorizer` interface (default impl throws "no runtime registered").
- Add `mcp_oauth_status_change` to lifecycle event broadcaster in `mcp-connection-lifecycle.ts`.
- Add `OAuthStateKv` with 5-min TTL for `codeVerifier` + `expiresAt` per slug; mounted under `mcp/oauth-state/<slug>` kv prefix.
- Integration tests in `test/mcp-oauth-handlers.test.ts`: `oauth/start` returns URL, `oauth/finish` exchanges code, `oauth/cancel` clears state, `state` expiry honored, concurrent flows per user.
- Update `ai-docs/specs/bodhi-pi/acp.md` with the three new EXT rows and the lifecycle notification row.

### Commit 3 — CLI runtime + cli-headless e2e

- Wire `RedirectAuthorizer` in `test-apps/cli/src/host/cli.ts` to: spawn ephemeral `http.createServer` on `127.0.0.1:7777` (port from `cfg.redirectUri`), bind for the flow duration, handle `GET /callback?code=&state=` → call `oauth/finish` internally, release.
- Add `/mcp oauth start <slug>` slash in `test-apps/cli/src/client/acp/headless.ts:65`, blocks until `mcp_oauth_status_change{completed|failed}` or 5-min timeout.
- New `packages/bodhi-pi/e2e/cli-headless/mcp-oauth.e2e.ts` drives the full flow against `oauth-mcp-server.ts` with auto-approve.

### Commit 4 — HTTP + WS runtime + multi-tenant Playwright

- Add `GET /oauth/callback` route in `test-apps/http/src/host/server.ts:193`; decodes `state` → `{userId, slug}`, dispatches into per-user `McpService`, returns minimal HTML "you can close this window".
- Add `--public-base-url` startup flag with `Host` header fallback in `server.ts` startup.
- New `test/integration/oauth-multi-tenant.test.ts` proves user A's OAuth state invisible to user B.
- New `e2e-ui/shared/mcp-oauth.spec.ts` Playwright: `/mcp add` with oauth-preregistered config → `oauth start` opens popup → fixture server's `/authorize` "Approve" button → callback lands → `mcp_oauth_status_change{completed}` → `/mcp connect <slug>` succeeds → `whoami` tool returns "authenticated via bearer".

### Commit 5 — Browser runtime + Playwright

- Extend `InitMessage` in `test-apps/browser/src/host/runtime/bootstrap-worker.ts:44-72` with `clientOrigin: string`; main thread passes `window.location.origin`.
- Add `/oauth/callback` React route under `test-apps/browser/src/client/react/` that parses `?code=&state=`, calls `window.opener.postMessage({code, state, kind: "oauth-callback"}, origin)`, then `window.close()`.
- Main thread handler in `adapter.ts:54-71` forwards `oauth-callback` messages over the existing ACP MessagePort as `_bodhi-pi/mcp/oauth/finish` calls.
- Worker-side `RedirectAuthorizer` simply forwards `redirectToAuthorization(url)` back to main thread via the existing event channel; main thread does `window.open(url, "oauth", "popup")`.
- New `e2e-ui/shared/mcp-oauth-browser.spec.ts` Playwright runs the popup flow against fixture server.

### Commit 6 — Chrome-ext runtime + refresh/401 retry + spec finalization

- Add `"identity"` to `test-apps/chrome-ext/manifest.json` permissions.
- Register `"background": { "service_worker": "background-sw.js" }` in manifest.
- New `test-apps/chrome-ext/src/host/background-sw.ts`: minimal RPC bridge — `chrome.runtime.onMessage` listens for `{kind: "oauth-launch", url}` from the Worker, calls `chrome.identity.launchWebAuthFlow({url, interactive: true})`, posts result `{redirectUrl}` back.
- Worker-side `RedirectAuthorizer` for chrome-ext uses `chrome.runtime.sendMessage` to talk to the SW; on response, parses `?code=&state=` from `redirectUrl` and calls `oauth/finish` in-process.
- Token refresh: in the `oauth-preregistered` attacher in `buildHttpTransport`, check `expiresAt - 60_000 < Date.now()` on each request → call `auth(provider, { serverUrl })` to refresh before sending; on 401 from MCP server, call `auth()` once more then retry.
- Refresh-failure path: `mcp_oauth_status_change{status: "failed"}`, drop tokens, require manual `/mcp oauth start` to re-auth.
- `e2e-ui/shared/mcp-oauth-chromeext.spec.ts` Playwright stubs `chrome.identity.launchWebAuthFlow` (via `chrome.debugger` or test fixture injection) to return fixture's callback URL directly.
- Final spec sweep: update `mcp.md` § Auth row examples, `acp.md` Mode-Of-Operation matrix, `CONTEXT.md` glossary final entries.

## Critical files

**New**:
- `packages/bodhi-pi/src/mcp/mcp-oauth-provider.ts` — `KvOAuthProvider` (~120 LOC)
- `packages/bodhi-pi/src/mcp/mcp-oauth-state-kv.ts` — short-TTL state kv wrapper (~40 LOC)
- `packages/bodhi-pi/test/mcp-oauth.test.ts` — provider + state machine integration tests
- `packages/bodhi-pi/test/mcp-oauth-handlers.test.ts` — ACP handlers integration tests
- `packages/bodhi-pi/e2e/helpers/oauth-mcp-server.ts` — fixture OAuth + MCP server
- `packages/bodhi-pi/e2e/cli-headless/mcp-oauth.e2e.ts`
- `packages/bodhi-pi/e2e-ui/shared/mcp-oauth.spec.ts`
- `packages/bodhi-pi/e2e-ui/shared/mcp-oauth-browser.spec.ts`
- `packages/bodhi-pi/e2e-ui/shared/mcp-oauth-chromeext.spec.ts`
- `packages/bodhi-pi/test-apps/chrome-ext/src/host/background-sw.ts`
- `packages/bodhi-pi/test-apps/browser/src/client/react/oauth-callback.tsx`
- `packages/bodhi-pi/test-apps/http/src/test/integration/oauth-multi-tenant.test.ts`

**Modified**:
- `packages/bodhi-pi/src/mcp/mcp-types.ts` — extend union, add OAuth-preregistered types
- `packages/bodhi-pi/src/mcp/mcp-service.ts` — `parseAuthInput`, register oauth/{start,finish,cancel}
- `packages/bodhi-pi/src/mcp/mcp-client.ts` — strategy-table refactor of `buildHttpTransport`
- `packages/bodhi-pi/src/mcp/mcp-connection-lifecycle.ts` — add `mcp_oauth_status_change` emitter
- `packages/bodhi-pi/test-apps/cli/src/host/cli.ts` — redirect server lifecycle
- `packages/bodhi-pi/test-apps/cli/src/client/acp/headless.ts` — `/mcp oauth start` slash
- `packages/bodhi-pi/test-apps/http/src/host/server.ts` — `/oauth/callback` route, `--public-base-url` flag
- `packages/bodhi-pi/test-apps/browser/src/host/runtime/bootstrap-worker.ts` — `clientOrigin` field in InitMessage
- `packages/bodhi-pi/test-apps/browser/src/client/runtime/adapter.ts` — `oauth-callback` postMessage relay
- `packages/bodhi-pi/test-apps/chrome-ext/manifest.json` — `"identity"` perm, `"background"` SW
- `packages/bodhi-pi/e2e/global-setup.ts` + `packages/bodhi-pi/e2e-ui/global-setup.ts` — spawn oauth fixture
- `packages/bodhi-pi/CONTEXT.md` — glossary entries
- `ai-docs/specs/bodhi-pi/mcp.md` — Auth table
- `ai-docs/specs/bodhi-pi/acp.md` — EXT methods + lifecycle notification rows

## Functions to reuse

- `packages/bodhi-pi/src/mcp/mcp-types.ts` — `McpNamedSecret`, `serializeMcpServerEntry`, `parseAuthConfigStored`
- `packages/bodhi-pi/src/mcp/mcp-service.ts:325-329` — `recordToNamedSecrets`
- `packages/bodhi-pi/src/kv/kv-store.ts:20-36` — `maskSecrets` (auto-handles new `secret:true` fields)
- `packages/bodhi-pi/src/mcp/mcp-connection-lifecycle.ts:111-123` — `emitStatusBroadcast` (mirror for OAuth)
- `packages/bodhi-pi/e2e/helpers/auth-mcp-server.ts` — copy structure (HTTP server + CORS + MCP `/mcp` route)
- `@modelcontextprotocol/sdk/client/auth` — `OAuthClientProvider` interface + `auth()` driver (wrap, don't re-implement)
- `@modelcontextprotocol/sdk/client/streamableHttp` — `StreamableHTTPClientTransport` (already used; OAuth piggybacks via `requestInit` builder)

## Verification

End-to-end verification per commit:

1. **`npm run check` + `npm test`** — both must pass before the commit lands.
2. **Matrix gates** (after commits 3-6): `just test-e2e` and `just test-e2e-ui` cover cli-headless / http / browser / chrome-ext respectively.
3. **Per-feature e2e** uses gpt-4o-mini per memory `feedback_bodhi_pi_e2e_strategy.md`.
4. **Multi-tenant proof** (commit 4): `oauth-multi-tenant.test.ts` adds an oauth-preregistered server for user A, runs the flow, then verifies user B's `_bodhi-pi/mcp/list` returns no entry and user B's kv read for `mcp/<slug>` returns `undefined`.
5. **Secret masking proof** (commit 1): test asserts `client.kv.get({key: "mcp/<slug>"})` returns `clientSecret.value === "***"` and `tokens.access.value === "***"` while in-process `harness.kvStore.get(...)` returns plaintext.
6. **Refresh proof** (commit 6): fixture server issues a 1-second-expiry token; test sleeps 2s, makes a tool call, asserts the request carries a *new* Bearer (via fixture server log) without manual re-auth.
7. **Cancel path** (commit 2): start a flow, call `oauth/cancel` before code returns, assert state kv entry deleted and a later `oauth/finish{code, state}` returns `-32602`.
8. **chrome-ext stubbed flow** (commit 6): Playwright injects a fake `chrome.identity.launchWebAuthFlow` via test fixture; the SW path runs end-to-end against the fixture's callback URL.

After commit 6: full `just test-e2e && just test-e2e-ui` green on `main`, plus a manual smoke against a real MCP server with pre-registered credentials (e.g., GitHub MCP if it ships an OAuth endpoint, or any test provider — note the requirement at the prompt's open question #11).
