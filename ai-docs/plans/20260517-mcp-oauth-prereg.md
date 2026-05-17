# bodhi-pi MCP — `auth = "oauth-preregistered"` implementation plan

## Context

The prompt at `ai-docs/prompts/bodhi-pi-mcp-auth-oauth-preregistered.md` asks to re-introduce OAuth 2.1 authorization-code-with-PKCE as a third `McpAuthConfig` discriminator, alongside the just-landed `"public"` and `"http-param"` modes. A previous attempt (deleted in commit `6a3966f4`) shipped the persisted shape and a `KvOAuthProvider` skeleton but had no flow code, no validation, and no e2e coverage; review `ai-docs/reviews/2026-05-16-bodhi-pi-mcp-cleanup.md` findings A.5/A.6 flag the missing `clientId` validation and the unstructured per-mode auth attachment.

**Contract.** OAuth 2.1 authorization-code-with-PKCE only. **No** DCR, **no** RFC 8414 metadata discovery, **no** RFC 8707 resource indicators, **no** stdio support. The user passes `authorize_url`, `token_url`, `client_id`, optional `client_secret`, optional `scopes`, optional `redirect_uri` override at `/mcp add`; the host runs the flow and persists `{access, refresh?, expiresAt}` under `auth.tokens`. Trunk-based per `packages/bodhi-pi/CLAUDE.md` § Trunk-based development — each commit lands green on `main`.

**Open-question resolutions adopted** (from the prompt's "Open questions" section):
- **#1 Refresh trigger** — eager (60s slack on connect) **and** lazy (401 retry).
- **#5 Flow timeout** — 5 minutes for state TTL.
- **#6 HTTP base URL** — `--public-base-url` startup flag with `Host`-header fallback.
- **#8 Chrome-ext** — new MV3 background service worker (net-new architecture, see below).
- **#10 Bearer attachment** — per-request kv read via a `requestInit` builder closure.
- **#12 Token endpoint auth method** — `tokenAuthMethod?: "basic" | "post"`, default `"basic"`.

## Architecture

```mermaid
flowchart TB
  subgraph Persisted["McpAuthConfig persisted shape (mcp-types.ts)"]
    A["{ mode: 'oauth-preregistered',<br/>authorizeUrl, tokenUrl, clientId,<br/>clientSecret?, scopes?, redirectUri?,<br/>tokenAuthMethod?, tokens? }"]
  end

  subgraph Core["src/mcp/ — runtime-agnostic"]
    P[KvOAuthProvider<br/>OAuthClientProvider impl<br/>+ pending URL capture]
    S[McpService<br/>oauth/{start,finish,cancel} handlers]
    L[McpConnectionLifecycle<br/>mcp_oauth_status_change emitter]
    SK[OAuthStateKv<br/>5-min TTL: codeVerifier per slug]
    C[mcp-client.ts buildHttpTransport<br/>attacher strategy table:<br/>public / http-param / oauth-preregistered]
  end

  subgraph Wire["ACP wire surface"]
    W1[_bodhi-pi/mcp/oauth/start]
    W2[_bodhi-pi/mcp/oauth/finish]
    W3[_bodhi-pi/mcp/oauth/cancel]
    W4[lifecycle: mcp_oauth_status_change]
  end

  subgraph Runtimes["Per-runtime: code capture + URL opening"]
    R1[CLI host<br/>ephemeral http://127.0.0.1:7777<br/>spawn open/xdg-open/start]
    R2[HTTP+WS host<br/>GET /oauth/callback route<br/>client window.open popup]
    R3[Browser host<br/>worker → main thread → window.open<br/>popup React route → postMessage]
    R4[Chrome-ext host<br/>NEW MV3 background SW<br/>chrome.identity.launchWebAuthFlow]
  end

  subgraph Fixture["e2e/helpers/oauth-mcp-server.ts (new)"]
    F[/authorize + /token + /mcp<br/>PKCE-validating + Bearer-gated]
  end

  Persisted --> Core
  S --> P
  S --> L
  S --> SK
  C --> P
  S --> Wire
  L --> W4
  Wire --> Runtimes
  Runtimes -.flow.-> F
```

### Persisted shape — extend `McpAuthConfig` union

In `packages/bodhi-pi/src/mcp/mcp-types.ts`:

```ts
export type McpAuthMode = "public" | "http-param" | "oauth-preregistered";

export interface McpAuthOAuthPreregisteredConfig {
  mode: "oauth-preregistered";
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret?: McpNamedSecret;          // tagged secret:true, auto-masked
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

Extend `parseAuthConfigStored` and `serializeAuthConfig` symmetrically. `McpNamedSecret` masking via `maskSecrets` (`packages/bodhi-pi/src/kv/kv-store.ts:20-36`) already handles any `{value, secret:true}` node — `clientSecret`, `tokens.access`, `tokens.refresh` will mask automatically.

In `src/client/types.ts` (line 102 comment is already a TODO marker), extend `McpAuthMode` and `McpAddHttpParams` to include the new variant, and extend the body builder in `src/client/client.ts:296-313` (`mcpAdd`) to forward the new fields.

### Validation — extend `parseAuthInput` (closes A.5)

Extend `packages/bodhi-pi/src/mcp/mcp-service.ts:269-309` (`parseAuthInput`):
- Accept `"oauth-preregistered"` as the third valid `auth` value.
- Reject when `transport === "stdio"` → `-32602`.
- Require non-empty `authorize_url`, `token_url`, `client_id` strings → `-32602` if any missing.
- Validate both URLs parse and use `https:` (allow `http://localhost*` / `http://127.0.0.1*` for fixture) → `-32602` otherwise.
- Validate `scopes` is `string[]` if present.
- Validate `redirect_uri` is a valid URL if present.
- Validate `token_auth_method` is `"basic"` or `"post"` if present.
- Reject sibling `headers` / `queries` → `-32602` (oauth-preregistered does not accept them).
- Wrap `client_secret` (if present) as `{ name: "clientSecret", value, secret: true }`.
- Reject persisted `tokens` field at add time — only the OAuth handler may write it.

### Auth attachment — refactor `buildHttpTransport` to strategy table (closes A.6)

Refactor `packages/bodhi-pi/src/mcp/mcp-client.ts:72-86` from the inline `if (auth.mode === "http-param")` to a per-mode attacher table:

```ts
type AuthAttacher = (url: URL, opts: TransportOpts, ctx: AttachContext) => void;
const ATTACHERS: Record<McpAuthMode, AuthAttacher> = {
  "public": () => {},
  "http-param": attachHttpParam,
  "oauth-preregistered": attachOAuthBearer,
};
```

`attachOAuthBearer` sets `opts.requestInit` to a closure that reads the latest `auth.tokens.access.value` from the in-process kv per call. The transport keeps a `(kvStore, slug)` reference so the builder re-reads after refresh writes back. Signature change: `buildHttpTransport` must accept the kv handle for the oauth path — pass it through `connectMcp` via `ConnectOptions` in `mcp-client.ts:18-23`. Refresh on 401 (lazy) and eager 60s-slack check go here too (commit 6).

### Flow code — port `KvOAuthProvider` from commit `6a3966f4^`

New file `packages/bodhi-pi/src/mcp/mcp-oauth-provider.ts`. The deleted shape (`6a3966f4^:packages/bodhi-pi/src/mcp/mcp-oauth-host-api.ts`) is the right template — implements `OAuthClientProvider` from `@modelcontextprotocol/sdk/client/auth.js`, captures the authorize URL into `this.pending` rather than injecting a callback, then a top-level `runAuthFlow(provider, serverUrl, code?)` driver calls SDK's `auth()`.

**Port, don't undelete.** Differences from the deleted version:
- Constructor takes `{ kvStore, slug, redirectUriResolver: () => string, stateKv: OAuthStateKv }` instead of `redirectUrl` directly — runtimes inject the redirect resolver because the URL varies (e.g., HTTP `Host`-header fallback) and the resolver runs after the runtime is established.
- `saveCodeVerifier` / `codeVerifier` write to the **short-TTL kv** (`OAuthStateKv`), not in-memory `this.pending`. This matters because HTTP `/oauth/callback` may run in a different agent rebuild than `oauth/start`.
- `clientMetadata.token_endpoint_auth_method` reads from `cfg.tokenAuthMethod ?? "client_secret_basic"` instead of hardcoded `"none"`.
- `clientInformation()` returns `{ client_id, client_secret? }` directly from the cfg (no kv re-read needed — the values live on the in-memory cfg the service passes in).
- `saveClientInformation` deliberately throws (we skip DCR; if SDK ever calls it, that's a bug we want to see).

**Discovery short-circuit.** SDK's `auth()` normally hits `/.well-known/oauth-authorization-server`. Two viable paths to skip it — the implementation commit (commit 1) must verify which the installed SDK version supports against `node_modules/@modelcontextprotocol/sdk/dist/esm/client/auth.js` and pick one:
- **(preferred)** SDK exposes `saveAuthorizationServerMetadata` on the provider interface; implement `discoveryMetadata()` (or whatever the SDK version names it) to return a static `{ authorization_endpoint, token_endpoint, response_types_supported: ["code"], code_challenge_methods_supported: ["S256"] }`.
- **(fallback)** Wrap `auth()` with a pre-call that primes any module-level cache, or hand-roll the PKCE + token POST without `auth()` if no hook exists. The deleted code shipped without proving this end-to-end — that's the gap commit 1 must close.

### `OAuthStateKv` — short-TTL state store

New file `packages/bodhi-pi/src/mcp/mcp-oauth-state-kv.ts`. Wraps the host's `KvStore` under a `mcp/oauth-state/<slug>` prefix. Stores `{ codeVerifier, redirectUri, expiresAt }`; `get(slug)` returns `undefined` if `Date.now() > expiresAt`. TTL 5 minutes. `set(slug, …)` also opportunistically prunes expired sibling entries (bounded scan over `mcp/oauth-state/`).

### Wire surface — new ACP methods + lifecycle event

Three new method names in `src/wire/constants.ts`:

```ts
export const EXT_MCP_OAUTH_START  = "_bodhi-pi/mcp/oauth/start";
export const EXT_MCP_OAUTH_FINISH = "_bodhi-pi/mcp/oauth/finish";
export const EXT_MCP_OAUTH_CANCEL = "_bodhi-pi/mcp/oauth/cancel";
```

Register in `mcp-service.ts:76-88`:

| Method | Params | Result | Behavior |
|---|---|---|---|
| `oauth/start` | `{slug, redirectUri?}` | `{authorizeUrl, state} \| {status:"completed"}` | reads entry → builds `KvOAuthProvider` → `runAuthFlow(serverUrl=tokenUrl)`. If SDK returns `AUTHORIZED` (cached tokens, no flow needed) returns `{status:"completed"}`; otherwise returns `{authorizeUrl, state}` and persists `codeVerifier` to `OAuthStateKv`. |
| `oauth/finish` | `{slug, code, state}` | `{status:"completed" \| "failed", errorMessage?}` | validates `state`, loads `codeVerifier`, runs `auth(provider, {serverUrl, authorizationCode: code})`, emits `mcp_oauth_status_change{status:"completed"}` on success or `failed` with `errorMessage`. |
| `oauth/cancel` | `{slug, state}` | `{ok: true}` | deletes the `OAuthStateKv` entry, emits `mcp_oauth_status_change{status:"cancelled"}`. Subsequent `oauth/finish{state}` returns `-32602`. |

Add `mcp_oauth_status_change` emitter to `src/mcp/mcp-connection-lifecycle.ts:136-147` mirroring `emitStatusBroadcast`. Use the same `EventDispatcher` path (`src/acp/event-wiring.ts` already translates events into `LIFECYCLE_EVENT_METHOD` wire notifications — no direct `conn.notification` per the comment at `mcp-connection-lifecycle.ts:21-27`).

### Per-runtime architecture

| Runtime | URL opening | Code capture | Token POST |
|---|---|---|---|
| **CLI** | host: spawn `open` / `xdg-open` / `start` | host: ephemeral `http.createServer` bound `127.0.0.1:7777` (or `cfg.redirectUri`'s port), `/callback` handler, released after flow | host |
| **HTTP+WS** | client (React) `window.open(url, "oauth")` | host: new `GET /oauth/callback` route; `state` carries `{userId, slug}`; dispatches into per-user `McpService` | host |
| **Browser** | main thread `window.open(url, "oauth", "popup")` (forwarded from Worker via existing event channel) | client: `/oauth/callback` React route in popup, `window.opener.postMessage({code,state})`, then `window.close()`; main thread relays to Worker via existing ACP MessagePort as `_bodhi-pi/mcp/oauth/finish` | host (Worker) |
| **Chrome-ext** | host (new background SW) `chrome.identity.launchWebAuthFlow({url, interactive: true})` returns full redirect URL synchronously | host (SW) parses returned URL | host (SW) |

**CLI redirect_uri** defaults to `http://localhost:7777/callback`. Port collision → `oauth/start` returns `-32603` with `port 7777 in use; pass redirect_uri=… on /mcp add to override`.

**HTTP+WS redirect_uri** = `${publicBaseUrl}/oauth/callback`. `publicBaseUrl` resolved in `test-apps/http/src/host/cli-args.ts` + `server.ts:35-50` with this precedence:
1. `--public-base-url` startup flag (parsed in `cli-args.ts`).
2. `Host` header of the inbound `/acp` request that triggered `oauth/start`.

The route handler in `server.ts:182-213` (`handleRequest`) gets a new branch above the `/acp` branch that decodes `state`, looks up `{userId, slug}`, and calls `_bodhi-pi/mcp/oauth/finish` against the per-user `McpService`. Returns minimal HTML "you can close this window."

**Browser redirect_uri** = `${window.location.origin}/oauth/callback`. The main thread already passes adapter config to the Worker via `InitMessage` (`bootstrap-worker.ts:166-184`); add `clientOrigin: string` to the `InitMessage` type (defined in `@bodhiapp/bodhi-pi-test-app-utils/worker-message-types`) and pass `window.location.origin` from `adapter.ts:74-91`. Add a `/oauth/callback` route to the React app entry (`test-apps/browser/src/client/react/main.tsx` and `App.tsx`).

**Chrome-ext redirect_uri** = `chrome.identity.getRedirectURL()`. Document the constraint that some OAuth providers reject the `chromiumapp.org` scheme.

### Chrome-ext: new MV3 background service worker (net-new architecture)

Today's chrome-ext has no SW — only a Web Worker (`test-apps/chrome-ext/src/host/worker.ts`). For `chrome.identity.launchWebAuthFlow`, add:

1. `test-apps/chrome-ext/manifest.json`: add `"identity"` to a new top-level `"permissions": ["identity"]` array, and register `"background": { "service_worker": "background-sw.js", "type": "module" }`. Update `content_security_policy.extension_pages` if needed.
2. `test-apps/chrome-ext/src/host/background-sw.ts` — new file. Minimal RPC bridge: `chrome.runtime.onMessage` listens for `{kind: "oauth-launch", url}` from the Web Worker, calls `chrome.identity.launchWebAuthFlow({url, interactive: true})`, replies with `{redirectUrl}` or `{error}`.
3. Wire the SW into the build in `test-apps/chrome-ext/vite.config.ts` as a separate rollup input so it lands at `dist/background-sw.js`.
4. Worker-side: in the chrome-ext-specific path inside `bootstrap-worker.ts` (or a chrome-ext-specific resolver injected via Init), the `KvOAuthProvider`'s redirect resolver returns `chrome.identity.getRedirectURL()`; the `oauth/start` handler, after `runAuthFlow` returns the authorize URL, sends `chrome.runtime.sendMessage({kind: "oauth-launch", url})` to the SW, awaits the reply, parses `?code=&state=` from `redirectUrl`, and calls `oauth/finish` in-process.

The Web Worker can call `chrome.runtime.sendMessage` even though it's not an SW context — that's the bridge.

## Fixture OAuth + MCP server

New file `packages/bodhi-pi/e2e/helpers/oauth-mcp-server.ts`, modeled on `e2e/helpers/auth-mcp-server.ts` (same CORS headers, same `/mcp` shape, same `whoami` tool):

- `GET /authorize` — validates `code_challenge`, `client_id`, `state`. For Playwright drives, renders a 1-button HTML "Approve" page that POSTs to `/authorize/approve`. For test harness auto-approval (cli e2e), accepts `?auto=1` query and redirects immediately to `redirect_uri?code=…&state=…`.
- `POST /token` — accepts both `client_secret_basic` (Authorization header) and `client_secret_post` (body). Validates `code_verifier` against the stored challenge. Returns `{access_token, refresh_token, token_type: "Bearer", expires_in}`. Supports a special `?expires_in=1` to issue 1-second tokens (refresh-test fixture, commit 6).
- `POST /mcp` — same as `auth-mcp-server.ts` but rejects without `Authorization: Bearer <access>`. The `whoami` tool returns `"authenticated via bearer"`.

Spawned alongside the existing fixtures in `e2e/global-setup.ts` and `e2e-ui/global-setup.ts` (next free port: e2e uses 33347, e2e-ui uses 33348 — sibling to `auth-mcp-server`'s 33346/33347).

## 6-commit slice plan

Each commit lands green on `main` (`npm run check`, `npm test`). Spec updates land in the same commit that touches the ACP surface, per `packages/bodhi-pi/CLAUDE.md`.

### Commit 1 — types + validation + flow code + fixture server + integration tests

- Extend `McpAuthConfig` union in `mcp-types.ts`; extend parsers/serializers.
- Extend `parseAuthInput` in `mcp-service.ts` (closes A.5).
- Refactor `buildHttpTransport` in `mcp-client.ts` to strategy table (closes A.6); thread `kvStore` through `ConnectOptions`; `oauth-preregistered` attacher reads kv per request.
- Implement `KvOAuthProvider` in `src/mcp/mcp-oauth-provider.ts` (port from `6a3966f4^`, adapt per § Flow code).
- Implement `OAuthStateKv` in `src/mcp/mcp-oauth-state-kv.ts`.
- Implement `runAuthFlow(provider, serverUrl, code?)` driver in same file as provider. **Verify SDK discovery short-circuit path against installed `@modelcontextprotocol/sdk` v1.29+** during this commit.
- New `e2e/helpers/oauth-mcp-server.ts` fixture; wire into `e2e/global-setup.ts` and `e2e-ui/global-setup.ts`.
- Extend `src/client/types.ts` `McpAuthMode` union + `McpAddHttpParams`; extend `src/client/client.ts:296-313` body builder.
- Tests: `packages/bodhi-pi/test/mcp-oauth.test.ts` — `parseAuthInput` happy + every error path, masking (`clientSecret` masked on `/mcp/list`), `KvOAuthProvider` state machine round-trip against fixture server (start → finish → tokens persisted → masked on read → bearer attached on next `connect`), `OAuthStateKv` TTL.
- Spec: update `ai-docs/specs/bodhi-pi/mcp.md` § Auth table with the `oauth-preregistered` row (lines 100-121); add the new persisted shape under line 34.

### Commit 2 — core ACP handlers + lifecycle event

- Add `EXT_MCP_OAUTH_{START,FINISH,CANCEL}` to `src/wire/constants.ts:84-100`.
- Register the three handlers in `mcp-service.ts:76-88` (`McpService.register`).
- Add `mcp_oauth_status_change` emitter to `mcp-connection-lifecycle.ts:136-147` mirroring `emitStatusBroadcast`. Wire it through `src/acp/event-wiring.ts` so it lands as a `LIFECYCLE_EVENT_METHOD` notification.
- Mount `OAuthStateKv` under `mcp/oauth-state/<slug>` kv prefix.
- Tests: `packages/bodhi-pi/test/mcp-oauth-handlers.test.ts` — `oauth/start` returns URL + state, `oauth/finish` exchanges code + emits completed, `oauth/cancel` deletes state + emits cancelled, expired state → `-32602`, `oauth/finish` with mismatched state → `-32602`, concurrent flows per user don't interfere.
- Spec: update `ai-docs/specs/bodhi-pi/acp.md` § MCP table (line 81+) with the three new EXT rows + the `mcp_oauth_status_change` lifecycle notification row.

### Commit 3 — CLI runtime + cli-headless e2e

- Wire the redirect-server lifecycle in `test-apps/cli/src/host/cli.ts` — when `oauth/start` is invoked through the agent's handler, spawn an ephemeral `http.createServer` on `127.0.0.1:7777` (or `cfg.redirectUri`'s port), register a `GET /callback` handler that calls `oauth/finish` in-process and closes the server. Implement as a helper module `test-apps/cli/src/host/oauth-callback-server.ts`.
- Add `/mcp oauth start <slug>` slash branch in `test-apps/cli/src/client/acp/headless.ts:65+` and the parallel REPL handler in `repl.ts`. Slash blocks until `mcp_oauth_status_change{completed|failed}` lifecycle notification arrives, or 5-min timeout.
- Add a `BodhiPiClient.mcpOauthStart` / `mcpOauthFinish` / `mcpOauthCancel` to `src/client/client.ts` mirroring the existing mcp* methods.
- New `packages/bodhi-pi/e2e/cli-headless/mcp-oauth.e2e.ts` drives the full flow against `oauth-mcp-server.ts` with auto-approve (`?auto=1` query on /authorize), modeled on `mcp-auth.e2e.ts:25-58`.

### Commit 4 — HTTP + WS runtime + multi-tenant Playwright

- Add `--public-base-url` flag parsing to `test-apps/http/src/host/cli-args.ts`; thread through `BuildServerOptions` in `server.ts:35-50`.
- New `GET /oauth/callback` branch in `test-apps/http/src/host/server.ts:182-213` (`handleRequest`). Decodes `state` → `{userId, slug}`, dispatches via the per-user `McpService` (which already lives behind `ServerMcpStore` and per-request `wireAgentForRequest`). Returns minimal HTML.
- New `test-apps/http/src/test/integration/oauth-multi-tenant.test.ts` — adds an oauth-preregistered server for user A, runs the flow, verifies user B's `/mcp/list` doesn't see it and user B's `mcp/<slug>` kv read returns `undefined`.
- New `e2e-ui/shared/mcp-oauth.spec.ts` Playwright spec (modeled on `mcp-auth.spec.ts`): `/mcp add` with oauth-preregistered config → `/mcp oauth start <slug>` opens popup → fixture's `/authorize` Approve button → callback lands → `mcp_oauth_status_change{completed}` lifecycle event observed → `/mcp connect <slug>` → `whoami` returns "authenticated via bearer".
- Same Playwright test runs under both http and ws runtimes via the existing fixtures (`e2e-ui/fixtures.ts`).

### Commit 5 — Browser runtime + Playwright

- Extend `InitMessage` type in `@bodhiapp/bodhi-pi-test-app-utils/worker-message-types` with `clientOrigin: string`.
- Pass `window.location.origin` from `test-apps/browser/src/client/runtime/adapter.ts:74-91` (`initPayload`).
- Read `clientOrigin` in `test-apps/browser/src/host/runtime/bootstrap-worker.ts:171-184`; use it when constructing `KvOAuthProvider`'s redirect resolver for this Host.
- Add `/oauth/callback` React route under `test-apps/browser/src/client/react/` (likely a new `OAuthCallback.tsx` component, wired into `App.tsx`). Parses `?code=&state=`, calls `window.opener.postMessage({code, state, kind: "bodhi-pi-oauth-callback"}, window.location.origin)`, then `window.close()`.
- Main-thread handler in `client/runtime/adapter.ts` listens for `"bodhi-pi-oauth-callback"` postMessage; forwards over the existing ACP `ClientSideConnection` as a `_bodhi-pi/mcp/oauth/finish` ext call.
- Worker-side: the SDK provider's `redirectToAuthorization(url)` captures into `pending` (as in the deleted code); when `oauth/start`'s handler returns the URL to the client, the client (main thread) does `window.open(url, "oauth", "popup")` on the user's gesture (the `/mcp oauth start` slash send is a user gesture, satisfying popup-blocker).
- New `e2e-ui/shared/mcp-oauth-browser.spec.ts` Playwright: same flow but driven through the Worker.

### Commit 6 — Chrome-ext runtime + refresh/401 + final spec sweep

- Add `"identity"` permission + `"background": { "service_worker": "background-sw.js", "type": "module" }` to `test-apps/chrome-ext/manifest.json`.
- New `test-apps/chrome-ext/src/host/background-sw.ts`: minimal RPC bridge — listens for `{kind: "bodhi-pi-oauth-launch", url}`, calls `chrome.identity.launchWebAuthFlow({url, interactive: true})`, replies `{redirectUrl}` or `{error}`.
- Update `test-apps/chrome-ext/vite.config.ts` to emit `dist/background-sw.js`.
- Chrome-ext-specific path: in the Web Worker (`test-apps/chrome-ext/src/host/worker.ts` or a chrome-ext-specific Init hook), the OAuth handler sends `chrome.runtime.sendMessage` to the SW, awaits the reply, parses code+state, calls `oauth/finish` locally.
- Refresh: in the `oauth-preregistered` attacher (commit 1's `mcp-client.ts`), check `tokens.expiresAt - 60_000 < Date.now()` on each request → call `runAuthFlow(provider, serverUrl)` to refresh before sending. On 401 from MCP server: call `runAuthFlow` once more, retry; on second 401 emit `mcp_oauth_status_change{status:"failed"}` and require manual `/mcp oauth start` to re-auth.
- Fixture support: `oauth-mcp-server.ts` already supports `?expires_in=1` per commit 1; integration test in `test/mcp-oauth-refresh.test.ts` issues a 1-second token, sleeps 2s, makes a tool call, asserts the fixture saw a new Bearer (via the fixture's request log helper).
- New `e2e-ui/shared/mcp-oauth-chromeext.spec.ts` Playwright. Stub `chrome.identity.launchWebAuthFlow` via a test fixture injection (the e2e-ui chrome-ext context can `evaluate` against the SW to monkey-patch) so the test resolves to the fixture's callback URL directly.
- Final spec sweep:
  - `ai-docs/specs/bodhi-pi/mcp.md` — Auth section gets a worked example for oauth-preregistered.
  - `ai-docs/specs/bodhi-pi/acp.md` — Mode-Of-Operation matrix mentions the lifecycle notification path for OAuth.
  - `packages/bodhi-pi/CONTEXT.md` — glossary entries for: OAuth tokens, PKCE, redirect URI, state parameter, refresh token.

## Critical files

**New**:
- `packages/bodhi-pi/src/mcp/mcp-oauth-provider.ts`
- `packages/bodhi-pi/src/mcp/mcp-oauth-state-kv.ts`
- `packages/bodhi-pi/test/mcp-oauth.test.ts`
- `packages/bodhi-pi/test/mcp-oauth-handlers.test.ts`
- `packages/bodhi-pi/test/mcp-oauth-refresh.test.ts`
- `packages/bodhi-pi/e2e/helpers/oauth-mcp-server.ts`
- `packages/bodhi-pi/e2e/cli-headless/mcp-oauth.e2e.ts`
- `packages/bodhi-pi/e2e-ui/shared/mcp-oauth.spec.ts`
- `packages/bodhi-pi/e2e-ui/shared/mcp-oauth-browser.spec.ts`
- `packages/bodhi-pi/e2e-ui/shared/mcp-oauth-chromeext.spec.ts`
- `packages/bodhi-pi/test-apps/cli/src/host/oauth-callback-server.ts`
- `packages/bodhi-pi/test-apps/chrome-ext/src/host/background-sw.ts`
- `packages/bodhi-pi/test-apps/browser/src/client/react/OAuthCallback.tsx`
- `packages/bodhi-pi/test-apps/http/src/test/integration/oauth-multi-tenant.test.ts`

**Modified**:
- `packages/bodhi-pi/src/mcp/mcp-types.ts` — union extension, parsers/serializers
- `packages/bodhi-pi/src/mcp/mcp-service.ts` — `parseAuthInput`, register 3 oauth handlers
- `packages/bodhi-pi/src/mcp/mcp-client.ts` — strategy-table refactor; thread kvStore through `ConnectOptions`
- `packages/bodhi-pi/src/mcp/mcp-connection-lifecycle.ts` — `mcp_oauth_status_change` emitter
- `packages/bodhi-pi/src/wire/constants.ts` — `EXT_MCP_OAUTH_*`
- `packages/bodhi-pi/src/client/types.ts` — extend `McpAuthMode`, `McpAddHttpParams`
- `packages/bodhi-pi/src/client/client.ts` — `mcpAdd` body builder; new `mcpOauthStart/Finish/Cancel`
- `packages/bodhi-pi/src/index.ts` — export new types
- `packages/bodhi-pi/test-apps/cli/src/host/cli.ts` — wire callback-server lifecycle
- `packages/bodhi-pi/test-apps/cli/src/client/acp/{headless,repl}.ts` — `/mcp oauth start` slash
- `packages/bodhi-pi/test-apps/http/src/host/server.ts` — `/oauth/callback` route
- `packages/bodhi-pi/test-apps/http/src/host/cli-args.ts` — `--public-base-url`
- `packages/bodhi-pi/test-apps/browser/src/host/runtime/bootstrap-worker.ts` — read `clientOrigin`
- `packages/bodhi-pi/test-apps/browser/src/client/runtime/adapter.ts` — pass `clientOrigin`; oauth-callback postMessage relay
- `packages/bodhi-pi/test-apps/browser/src/client/react/App.tsx` (+ `main.tsx`) — `/oauth/callback` route
- `packages/bodhi-pi/test-apps/chrome-ext/manifest.json` — `"identity"` perm, `"background"` SW
- `packages/bodhi-pi/test-apps/chrome-ext/vite.config.ts` — SW build target
- `packages/bodhi-pi/test-apps/chrome-ext/src/host/worker.ts` — OAuth-launch RPC to SW
- `packages/bodhi-pi/e2e/global-setup.ts` + `packages/bodhi-pi/e2e-ui/global-setup.ts` — spawn oauth fixture
- `packages/bodhi-pi/CONTEXT.md` — glossary
- `ai-docs/specs/bodhi-pi/mcp.md` — Auth table + worked example
- `ai-docs/specs/bodhi-pi/acp.md` — EXT methods + lifecycle notification

## Functions to reuse

- `packages/bodhi-pi/src/mcp/mcp-types.ts` — `McpNamedSecret`, `serializeMcpServerEntry`, `parseMcpServerEntry`, the parser/serializer pattern for the new variant
- `packages/bodhi-pi/src/mcp/mcp-service.ts:325-329` — `recordToNamedSecrets` (port for `clientSecret`)
- `packages/bodhi-pi/src/kv/kv-store.ts:20-36` — `maskSecrets` (auto-handles new `secret:true` fields, including nested `tokens.access/refresh`)
- `packages/bodhi-pi/src/mcp/mcp-connection-lifecycle.ts:136-147` — `emitStatusBroadcast` (mirror for `emitOauthStatusBroadcast`)
- `packages/bodhi-pi/e2e/helpers/auth-mcp-server.ts` — copy structure (HTTP server with CORS, MCP `/mcp` route, port wait, close helper)
- `packages/bodhi-pi/src/mcp/in-process-provider.ts` — `connectMcp` integration point for the new attacher
- `@modelcontextprotocol/sdk/client/auth.js` — `OAuthClientProvider` interface + `auth()` driver (wrap, don't re-implement)
- `@modelcontextprotocol/sdk/client/streamableHttp.js` — `StreamableHTTPClientTransport` (already used; OAuth piggybacks via `requestInit` builder)
- Prior shape reference (do not copy verbatim — port): `git show 6a3966f4^:packages/bodhi-pi/src/mcp/mcp-oauth-host-api.ts`

## Verification

Per-commit gate: `npm run check` + `npm test` green. Cross-runtime gate after commits 3-6: `just test-e2e` and `just test-e2e-ui` green.

End-to-end proofs:

1. **Secret masking** (commit 1): `client.mcpList()` returns `auth.clientSecret.value === "***"`, `auth.tokens.access.value === "***"`, `auth.tokens.refresh.value === "***"`; same entry read in-process via `harness.kvStore.get("mcp/<slug>")` returns plaintext.
2. **Validation** (commit 1): `client.mcpAdd({auth: "oauth-preregistered"})` without `authorizeUrl`/`tokenUrl`/`clientId` rejects with `-32602`; with sibling `headers` rejects; with `transport: "stdio"` rejects.
3. **State machine round-trip** (commit 1): integration test against `oauth-mcp-server.ts` with `?auto=1` — `KvOAuthProvider` → `runAuthFlow` returns authorize URL → simulate code arrival → tokens persisted under `auth.tokens` of `McpServerEntry` → next `connect()` attaches `Authorization: Bearer <access>` (asserted via fixture's `whoami` response "authenticated via bearer").
4. **Cancel** (commit 2): start a flow, call `oauth/cancel`, assert state entry deleted, subsequent `oauth/finish{state, code}` returns `-32602`.
5. **Multi-tenant isolation** (commit 4): two users, user A adds + completes OAuth, user B's `/mcp/list` returns no entries and `oauth/finish` with user A's state errors.
6. **CLI flow** (commit 3): cli-headless e2e drives `/mcp add` + `/mcp oauth start <slug>` (with `?auto=1` redirect_uri pointing at the host's ephemeral server) → fixture auto-approves → completed lifecycle event → `/mcp connect` succeeds.
7. **HTTP+WS Playwright** (commit 4): Playwright clicks Approve in the popup, asserts the `mcp_oauth_status_change{completed}` event appears in the events panel, asserts `whoami` returns "authenticated via bearer."
8. **Browser Playwright** (commit 5): same as #7 but the popup is the React route and the postMessage path runs end-to-end.
9. **Chrome-ext Playwright** (commit 6): test injects a `chrome.identity.launchWebAuthFlow` stub via the persistent chromium context, asserts the SW receives the launch message and the flow completes.
10. **Refresh** (commit 6): fixture issues 1-second token; test sleeps 2s, makes a tool call; fixture's request log records a different Bearer than the first call.
11. **401 retry** (commit 6): fixture returns 401 once for a known token; client refreshes, retries, succeeds. On second 401, asserts `mcp_oauth_status_change{failed}` emitted.
12. **Manual smoke** (after commit 6): document one real-MCP-server smoke (e.g., GitHub or a test provider) in commit 6's message, including the `/mcp add` payload.

---

# Extension — `auth = "oauth-dcr"` (RFC 7591 Dynamic Client Registration)

## Context

The pre-registered flow above lands first. This extension adds **DCR (RFC 7591)** so users can connect to OAuth-supporting MCP servers without manually registering a client through the provider's admin UI. The bodhi-pi server runs RFC 9728 (Protected Resource Metadata) → RFC 8414 (Authorization Server Metadata) → RFC 7591 (Dynamic Client Registration) and persists the registered credentials in the same shape that `oauth-preregistered` uses.

**Reference pattern**: `/Users/amir36/Documents/workspace/src/github.com/BodhiSearch/BodhiApp` ts-client exposes `/mcps/oauth/discover-mcp`, `/mcps/oauth/discover-as`, `/mcps/oauth/dynamic-register` as separate fine-grained endpoints. bodhi-pi mirrors this pattern: discovery and registration are individually-callable, AND a combined `/mcp add {auth: "oauth-dcr"}` chains them in one ACP call.

## Locked decisions (carry over from grilling)

1. **Server-side discovery + DCR**, keeping client light. Same per-user kv store; same per-tenant routing for the callback.
2. **Allow overrides** on input — user can short-circuit any step. Required: `url`. Optional: `issuerUrl`, `registrationEndpoint`, `authorizeUrl`, `tokenUrl`, `scopes`, `redirectUri`, `tokenAuthMethod`, `clientName`.
3. **Persisted mode unified to `"oauth"`** — drop the `"oauth-preregistered"` enum value. Both `auth: "oauth-preregistered"` and `auth: "oauth-dcr"` on `/mcp add` persist as `mode: "oauth"`. Distinct input discriminators, single persisted shape. Optional `dcrInfo` field on the entry tracks DCR-specific metadata (issuerUrl, registrationEndpoint, registeredAt, registrationAccessToken) so `/mcp/list` can surface it.

## Persisted shape changes

In `packages/bodhi-pi/src/mcp/mcp-types.ts`:

```ts
export type McpAuthMode = "public" | "http-param" | "oauth";  // was: "oauth-preregistered"

export interface McpDcrInfo {
  issuerUrl: string;                       // authorization server URL discovered via RFC 9728
  registrationEndpoint: string;            // URL used for DCR (RFC 7591)
  registeredAt: number;                    // unix epoch ms when DCR succeeded
  registrationAccessToken?: McpNamedSecret; // RFC 7592 management token (secret:true)
}

export interface McpAuthOAuthConfig {       // renamed from McpAuthOAuthPreregisteredConfig
  mode: "oauth";
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret?: McpNamedSecret;
  scopes?: string[];
  redirectUri?: string;
  tokenAuthMethod?: "basic" | "post";
  tokens?: McpOAuthTokens;
  dcrInfo?: McpDcrInfo;                    // set when entry was created via auth: "oauth-dcr"
}
```

Rename is cross-cutting: serializeAuthConfig, parseAuthConfigStored, every test that asserts `mode: "oauth-preregistered"` (test/mcp-oauth.test.ts, test/mcp-oauth-refresh.test.ts, test-apps/http/.../oauth-multi-tenant.test.ts) becomes `mode: "oauth"`. The wire-input alias `auth: "oauth-preregistered"` on `/mcp add` is kept so client-side callers don't break.

## New ACP wire surface

Two new methods + the existing `oauth/{start,finish,cancel}` stay unchanged:

```text
_bodhi-pi/mcp/oauth/discover  →  RFC 9728 + 8414 in one call
_bodhi-pi/mcp/oauth/register  →  RFC 7591 standalone
```

| Method | Params | Result |
|---|---|---|
| `_bodhi-pi/mcp/oauth/discover` | `{url}` (MCP server URL) | `{authorizationServerUrl, authorizeUrl?, tokenUrl?, registrationEndpoint?, scopesSupported?, resource?}` |
| `_bodhi-pi/mcp/oauth/register` | `{registrationEndpoint, redirectUri, scopes?, clientName?, clientUri?}` | `{clientId, clientSecret?, clientIdIssuedAt?, tokenEndpointAuthMethod?, registrationAccessToken?}` |

Implementation uses SDK helpers directly:
- `discoverOAuthServerInfo` from `@modelcontextprotocol/sdk/client/auth.js` → returns `{authorizationServerUrl, authorizationServerMetadata, resourceMetadata}`. Map fields to the response shape.
- `registerClient` from same module → POSTs to registration_endpoint with `OAuthClientMetadata`, returns `OAuthClientInformationFull`.

These methods are pure operations: they don't touch any `mcp/<slug>` kv entry. They exist for client-side workflows where the UI wants to inspect discovery results before committing to a connection. The combined `/mcp add {auth: "oauth-dcr"}` chains them internally.

## `/mcp add` — input mode `auth: "oauth-dcr"`

New branch in `parseAuthInput`:

```text
/mcp add {
  url: "https://example/mcp",
  auth: "oauth-dcr",
  scopes?: ["read","write"],
  // any of these short-circuit the corresponding discovery/DCR step:
  issuerUrl?, authorizeUrl?, tokenUrl?, registrationEndpoint?,
  redirectUri?, tokenAuthMethod?, clientName?
}
```

Flow inside `handleAdd` when `auth === "oauth-dcr"`:

1. **Discovery** (skip if `authorizeUrl`, `tokenUrl`, `registrationEndpoint` ALL provided):
   - Call `discoverOAuthServerInfo(url)` to get `authorizationServerUrl` + metadata.
   - Extract `authorize_endpoint`, `token_endpoint`, `registration_endpoint` from the metadata.
   - User overrides take precedence over discovered values.
2. **Registration** (skip if `clientId` is provided — fallback to pre-registered):
   - Need `registrationEndpoint` (from input or discovery).
   - Need `redirectUri` (from input, default per-runtime).
   - Call `registerClient(authServerUrl, {clientMetadata, ...})` with our metadata (grant_types: [authorization_code, refresh_token], response_types: [code], scope, redirect_uris).
   - Capture `client_id`, `client_secret`, `registration_access_token`, `token_endpoint_auth_method`.
3. **Persist** as `mode: "oauth"` with `dcrInfo: {issuerUrl, registrationEndpoint, registeredAt: Date.now(), registrationAccessToken?}`.
4. **Return** `{slug}` (same as other add modes).

Validation errors mirror oauth-preregistered:
- `url` (or sufficient overrides) required → `-32602` if missing
- URL must be https (or localhost) → `-32602`
- stdio transport rejects auth → `-32602`
- Persisted `tokens` field forbidden on add → `-32602`

After `/mcp add {auth: "oauth-dcr"}` succeeds, the user runs `/mcp oauth start <slug>` exactly as in the pre-registered case — same runtime code paths, same callback handling, same refresh strategy.

## Fixture extensions (`e2e/helpers/oauth-mcp-server.ts`)

Add three endpoints to make DCR drivable in-process:

- `GET /.well-known/oauth-protected-resource` (RFC 9728) — served on the MCP host (`baseUrl`). Returns `{resource, authorization_servers: [baseUrl]}` so discovery routes back to the same fixture process.
- `GET /.well-known/oauth-authorization-server` (RFC 8414) — returns full metadata: `{issuer, authorization_endpoint, token_endpoint, registration_endpoint, response_types_supported, code_challenge_methods_supported, grant_types_supported, scopes_supported, token_endpoint_auth_methods_supported}`.
- `POST /register` (RFC 7591) — accepts `OAuthClientMetadata` body. Validates `redirect_uris[0]`. Returns `{client_id, client_secret, client_id_issued_at, token_endpoint_auth_method: "client_secret_basic"}`. Stores `{clientId → clientSecret}` so subsequent token-grant calls work.

For test isolation, the existing fixture's `clientId/clientSecret` constants become the DEFAULT only — `POST /register` mints fresh pairs. The `/token` endpoint checks against the running set (existing + DCR-registered).

## Implementation slices (2 commits, depth-first)

### Commit 6 — Mode unification + discover/register handlers + `auth: "oauth-dcr"` add mode + fixture + integration tests

- Rename `McpAuthMode` "oauth-preregistered" → "oauth"; rename `McpAuthOAuthPreregisteredConfig` → `McpAuthOAuthConfig`; add `McpDcrInfo`. Update parsers/serializers. Update src/index.ts exports.
- Update all tests asserting `mode: "oauth-preregistered"` to `mode: "oauth"`.
- Keep `auth: "oauth-preregistered"` accepted on `/mcp add` (input alias for the same persisted shape, no DCR).
- New wire constants `EXT_MCP_OAUTH_DISCOVER`, `EXT_MCP_OAUTH_REGISTER` in `src/wire/constants.ts`.
- Implement `handleOauthDiscover` and `handleOauthRegister` in `mcp-service.ts` (use SDK's `discoverOAuthServerInfo` + `registerClient`).
- Extend `parseAuthInput` with the `oauth-dcr` branch: chains discovery → DCR → returns the `McpAuthOAuthConfig` with `dcrInfo`.
- Extend `BodhiPiClient` with `mcpOauthDiscover` + `mcpOauthRegister` methods.
- Extend fixture `oauth-mcp-server.ts` with the three new endpoints.
- New tests `test/mcp-oauth-dcr.test.ts` covering: discover happy path, register happy path, `/mcp add {auth: "oauth-dcr"}` end-to-end (discovers + registers + persists in one call), validation errors (missing url, stdio rejection, persisted-tokens rejection, override precedence).
- Spec updates: mcp.md § Auth gains the `oauth-dcr` row + a "DCR flow" subsection; acp.md gets `oauth/discover` + `oauth/register` rows; CONTEXT.md glossary entries for DCR + RFC 9728 + RFC 7591.

### Commit 7 — CLI fine-grained slashes + cli-headless e2e

- New `/mcp oauth discover <url>` and `/mcp oauth register <regUrl>` slashes in `test-apps/cli/src/client/acp/headless.ts` for inspection workflows.
- Extend the existing `/mcp add` slash JSON parser already accepts `auth: "oauth-dcr"` (no extra slash work needed — the slash hands the JSON to `mcpAdd`).
- New `e2e/cli-headless/mcp-oauth-dcr.e2e.ts` drives `/mcp add {auth: "oauth-dcr", url: <fixture>}` against the fixture, then `/mcp oauth start <slug> --auto`, then `/mcp connect`. Asserts the full DCR + flow chain works end-to-end via the cli binary.

Browser + chrome-ext runtimes need NO additional work: the DCR path runs entirely server-side (via the Worker for browser/chrome-ext). The slash command for `/mcp add` already accepts JSON — passing `{auth: "oauth-dcr", url: …}` routes to the handler. The existing OAuth chat slash (`/mcp oauth start`) works unchanged on the resulting persisted entry.

## Verification

- `/mcp add {auth: "oauth-dcr", url: <fixture-mcp-url>}` → returns `{slug}` after discovery + DCR completes.
- `client.mcpList()` shows the new entry with `auth.mode === "oauth"`, `auth.dcrInfo.issuerUrl` present, `clientSecret.value === "***"`.
- `/mcp oauth start <slug>` runs the standard flow against the DCR-registered client.
- Cross-tenant: user A's DCR-registered clientId not visible to user B (mirrors commit 2's multi-tenant story).
- Override precedence: if `clientId` is passed on `auth: "oauth-dcr"`, DCR is skipped (pre-registered fallback).
- Discover-only and register-only methods are individually callable for client-side workflows that want inspection.
