# MCP — target spec (after Commits 1–4 of the cleanup plan)

**Date:** 2026-05-16
**Companion:** `ai-docs/plans/2026-05-16-mcp-current-spec.md` (pre-cleanup snapshot)
**Plan:** `ai-docs/plans/prepare-clean-up-plan-crispy-moler.md`

Diff-style description of what `packages/bodhi-pi/` will expose for MCP after the four cleanup commits land. Anything not mentioned is **unchanged**.

## 1. Public surface — changes vs current spec

### 1.1 Extension methods removed

- `_bodhi-pi/mcp/oauth/start`
- `_bodhi-pi/mcp/oauth/finish`

Remaining 9 methods unchanged in signature.

### 1.2 Types shrunk

- `McpAuthMode = "public"` (was 5 modes).
- `McpAuthConfig = { mode: "public" }` (drop `headers`, `queryParams`, `clientId`, `clientSecret`, `tokens`).
- `McpOAuthTokens` deleted; `SecretValue` deleted if no other consumer survives.
- `McpServerEntry` keeps `{ transport, url?, command?, args?, env?, auth, lastKnownStatus, addedAt, label }`. (`McpNamedSecret` stays for stdio `env`.)
- `McpTransport = "http" | "stdio"` — unchanged.

### 1.3 Client surface trimmed

- `McpAuthInput` keeps only `{ mode: "public" }`.
- `BodhiPiClient` loses `mcpOAuthStart`/`mcpOAuthFinish` (or equivalents).
- `McpAddStdioParams`, `McpAddHttpParams`, `McpAddParams`, `McpConnectParams`, `McpDisconnectResult`, `McpExcludeParams`, `McpExcludeResult`, `McpIncludeParams`, `McpIncludeResult`, `McpListItem`, `McpRemoveResult`, `McpStatus`, `McpToolsResult`, `McpTransport` — kept.

### 1.4 Public barrel added

Values now exported from `src/index.ts`:
- `EXT_MCP_ADD`, `EXT_MCP_REMOVE`, `EXT_MCP_CONNECT`, `EXT_MCP_DISCONNECT`, `EXT_MCP_RECONNECT`, `EXT_MCP_LIST`, `EXT_MCP_TOOLS`, `EXT_MCP_INCLUDE`, `EXT_MCP_EXCLUDE`.
- `parseMcpAddArgs` (new helper in `src/client/mcp-slash.ts`).

### 1.5 Notifications

- Same two payload types (`mcp_status_change`, `mcp_tools_change`).
- `sessionId === ""` sentinel **removed**: when `sessions.size === 0` no broadcast fires.

### 1.6 Session log entries

- `mcp_inclusion_set` — unchanged.

### 1.7 Config (`BodhiPiConfig`)

- `supportsMcpStdio?: boolean` — unchanged.
- `mcpConnectionProvider` — unchanged.

## 2. Capabilities — changes

- **Transports:** unchanged (`http`, `stdio`).
- **Auth modes:** `public` only.
- **`connectMcp` stdio guard:** new — rejects at the stdio branch when `supportsStdio === false` (defence in depth beyond the `handleAdd` chokepoint).
- **Slug sanitisation:** unified `sanitizeSlug(name, fallback)` in `mcp-slug.ts`; per-method drift eliminated.
- **Hydration semantics:** unchanged.
- **Secret handling:** unchanged for stdio `env`; auth-side secret tags gone (no more auth secrets).

## 3. Internal structure

### 3.1 `packages/bodhi-pi/src/mcp/` layout

| File | Role | Approx. LoC |
|---|---|---|
| `in-process-provider.ts` | Default `McpConnectionProvider` implementation | 100 (unchanged) |
| `mcp-client.ts` | `connectMcp` (http + stdio with capability guard) | 70 |
| `mcp-auth.ts` | `resolveStdioEnv` (likely the only survivor; may be inlined) | 20 |
| `mcp-connection-provider.ts` | Interface (unchanged) | 50 |
| `mcp-registry.ts` | Per-session inclusion + tool merging (unchanged) | 80 |
| `mcp-slug.ts` | Slug helpers + unified `sanitizeSlug` | 60 |
| `mcp-store.ts` (new) | KV CRUD for `mcp/<slug>` (`loadPersistedEntries`, `persistStatus`, `persistInclusion`, `requireKv`) | 60 |
| `mcp-connection-lifecycle.ts` (new) | Hydration + connect/disconnect/reconnect + broadcasts | 130 |
| `mcp-service.ts` (slim) | `register()` dispatch + per-method handler facade | 90 |
| `mcp-tool-adapter.ts` | Tool wrapping (unchanged) | 75 |
| `mcp-types.ts` | Shrunk type module | 80 |

### 3.2 Test layout

| File | Role |
|---|---|
| `test/mcp.test.ts` | Integration (in-process): add/remove/list/include/exclude/session-resume — drives `BodhiPiClient` wrapper |
| `test/mcp-http-integration.test.ts` | Real mcp-everything http connect |
| `test/mcp-stdio-integration.test.ts` | Real mcp-everything stdio spawn |
| `test/helpers/spawn-mcp-everything.ts` (new) | Shared `spawnMcpEverythingHttp` + `waitForListening` |
| `e2e/cli-headless/headless-session.ts` (new) | Shared `HeadlessSlashSession` + factory (always exposes `sendChat`) |
| `e2e/cli-headless/{mcp,mcp-stdio,mcp-multi-session}.e2e.ts` | Use shared headless harness |
| `e2e/shared/{mcp-public-http,mcp-stdio,mcp-multi,mcp-session-resume}.e2e.ts` | Direct-ACP cross-runtime |
| `e2e-ui/shared/{mcp-public-http,mcp-multi}.spec.ts` | Playwright DOM-driven |

### 3.3 Host layout

| File | Role |
|---|---|
| `test-apps/http/src/server/agent/wire-agent-shared.ts` (new) | `buildAgentDeps` + `createForwardingEventHandlers` |
| `test-apps/http/src/server/agent/wire-agent.ts` | Per-request shell only |
| `test-apps/http/src/server/agent/wire-agent-ws.ts` | Per-WS shell only |
| `test-apps/http/src/server/mcp/server-mcp-store.ts` | Per-user `McpConnectionProvider` cache (unchanged) |
| `test-apps/browser/src/ui-lib/ui/commands.ts` | Slash dispatch; imports `EXT_MCP_*` + `parseMcpAddArgs` from `@bodhiapp/bodhi-pi` |
| `test-apps/cli/src/repl/headless.ts` | Slash dispatch; imports `parseMcpAddArgs` from `@bodhiapp/bodhi-pi` |

## 4. Behaviour parity statement

All passing tests at the start of Commit 1 must still pass at the end of Commit 4, with these exceptions:
- `test/mcp.test.ts:75-105` (secret-header masking on `auth.headers`) — deleted alongside Commit 1.
- Any test asserting on `auth.headers`, `auth.queryParams`, `clientId`, `clientSecret`, `tokens`, or `_bodhi-pi/mcp/oauth/*` — deleted.

**Public-host smoke** (`/mcp add url=… → connect → tools → /sum-prompt → disconnect → remove`) must behave identically across in-memory, cli, http, ws, browser, chrome-ext.

**CLI stdio smoke** (`/mcp add command=npx args='[…]' → connect → /sum-prompt`) must behave identically in cli + in-memory.

## 5. Re-introduction roadmap (post-cleanup)

Three exploratory prompts in `ai-docs/prompts/` (recommendation-style, not prescriptive). Each demands integration + e2e + e2e-ui coverage from commit 1.

1. `auth=oauth-dcr` — KV provider, runAuthFlow, EXT_MCP_OAUTH_*; per-host callback machinery (cli loopback HTTP, web same-origin + BroadcastChannel, chrome-ext `chrome.identity.launchWebAuthFlow`).
2. `auth=oauth-preregistered` — offline client credentials, share infrastructure with oauth-dcr.
3. `auth=header` + `auth=query` — single prompt (same KV/parser surface; both inject static request modifiers).

No stdio prompt — stdio survives this cleanup.
