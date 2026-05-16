# MCP — current spec (as implemented at HEAD)

**Date:** 2026-05-16
**Companion:** `ai-docs/plans/2026-05-16-mcp-target-spec.md` (post-cleanup target)
**Plan:** `ai-docs/plans/prepare-clean-up-plan-crispy-moler.md`

Snapshot of what `packages/bodhi-pi/` exposes for MCP at commit `5ecf3658` (the head before the cleanup begins). Use this side-by-side with the target spec to see what shrinks, what stays, what moves.

## 1. Public surface

### 1.1 Extension methods (`src/wire/constants.ts:84-104`)

| Method | Handler | Params | Result |
|---|---|---|---|
| `_bodhi-pi/mcp/add` | `mcp-service.ts:147` | `{ url?, command?, args?, env?, auth?, label? }` | `{ slug }` |
| `_bodhi-pi/mcp/remove` | `mcp-service.ts:179` | `{ slug }` | `{ slug }` |
| `_bodhi-pi/mcp/connect` | `mcp-service.ts:188` | `{ slug }` | `{ tools: string[] }` |
| `_bodhi-pi/mcp/disconnect` | `mcp-service.ts:204` | `{ slug }` | `{ slug }` |
| `_bodhi-pi/mcp/reconnect` | `mcp-service.ts:215` | `{ slug }` | `{ tools: string[] }` |
| `_bodhi-pi/mcp/list` | `mcp-service.ts:228` | `{}` | `{ entries: McpListEntry[] }` |
| `_bodhi-pi/mcp/tools` | `mcp-service.ts:250` | `{ slug, sessionId }` | `{ tools: string[] }` |
| `_bodhi-pi/mcp/include` | `mcp-service.ts:256` | `{ slug, sessionId }` | `{ slug, tools: string[] }` |
| `_bodhi-pi/mcp/exclude` | `mcp-service.ts:268` | `{ slug, sessionId }` | `{ slug }` |
| `_bodhi-pi/mcp/oauth/start` | `mcp-service.ts:276` | `{ slug, redirectUri }` | `{ authorized, authorizeUrl? }` |
| `_bodhi-pi/mcp/oauth/finish` | `mcp-service.ts:295` | `{ slug, code, redirectUri }` | `{ tools }` |

### 1.2 Lifecycle notifications (`LIFECYCLE_EVENT_METHOD`)

- `mcp_status_change { sessionId, slug, status: "connected"|"disconnected"|"error", errorMessage? }` — `mcp-service.ts:364-387`. Fabricates `sessionId === ""` when no sessions are loaded.
- `mcp_tools_change { sessionId, slug, toolNames: string[] }` — `mcp-service.ts:389-395`. Same empty-sessionId fabrication.

### 1.3 Session log entries (`src/sessions/entries.ts:37-40`)

- `mcp_inclusion_set { id, parentId, timestamp, slugs: string[] }` — written by `persistInclusion` (`mcp-service.ts:351-362`) on include/exclude/hydrate; read by `buildSessionContext` (`build-context.ts:102-103`) into `SessionContext.mcpInclusion`; threaded to `hydrate` via `agent.ts:427,444`.

### 1.4 Types (`src/mcp/mcp-types.ts`)

- `McpTransport = "http" | "stdio"` (line 5).
- `McpAuthMode = "public" | "header" | "query" | "oauth-dcr" | "oauth-preregistered"` (line 7).
- `McpAuthConfig = { mode, headers?, queryParams?, clientId?, clientSecret?, tokens? }` (lines 33-40).
- `McpServerEntry = { transport, url?, command?, args?, env?, auth, lastKnownStatus, addedAt, label }` (lines 42-52).
- `McpListEntry`, `McpToolInfo`, `SecretValue`, `McpNamedSecret`, `McpOAuthTokens`.
- `MCP_PREFIX = "mcp/"` (line 3).

### 1.5 Config (`BodhiPiConfig`)

- `supportsMcpStdio?: boolean` (default `true`) — `acp/agent.ts:105`. Hosts that cannot spawn pass `false`.
- `mcpConnectionProvider: McpConnectionProvider` (host-injected, single per agent).

### 1.6 Public barrel (`src/index.ts`)

- Values: `createInProcessMcpConnectionProvider`, `MCP_PREFIX`, `parseMcpServerEntry`.
- Types: `McpConnectionProvider`, `McpProviderConnectResult`, `McpServerEntry`, `McpToolInfo`, `McpAddHttpParams`, `McpAddParams`, `McpAddResult`, `McpAddStdioParams`, `McpAuthInput`, `McpAuthMode`, `McpConnectParams`, `McpConnectResult`, `McpDisconnectResult`, `McpExcludeParams`, `McpExcludeResult`, `McpIncludeParams`, `McpIncludeResult`, `McpListItem`, `McpNamedValueInput`, `McpRemoveResult`, `McpStatus`, `McpToolsResult`, `McpTransport`.
- **Not in barrel (drift):** `EXT_MCP_ADD`, `EXT_MCP_REMOVE`, `EXT_MCP_CONNECT`, `EXT_MCP_DISCONNECT`, `EXT_MCP_RECONNECT`, `EXT_MCP_LIST`, `EXT_MCP_TOOLS`, `EXT_MCP_INCLUDE`, `EXT_MCP_EXCLUDE`, `EXT_MCP_OAUTH_START`, `EXT_MCP_OAUTH_FINISH`.

## 2. Capabilities

- **Transports:** `http` (`StreamableHTTPClientTransport`, `mcp-client.ts:29`); `stdio` (`StdioClientTransport` via dynamic import, `mcp-client.ts:36`).
- **Auth modes:** `public`, `header` (named secret headers), `query` (named secret query params), `oauth-dcr` (`KvOAuthProvider`), `oauth-preregistered` (offline `client_id`/`client_secret`).
- **Per-session inclusion:** session-log `mcp_inclusion_set` (above).
- **Global connection state:** `McpConnectionProvider` holds per-slug live `Client` + tool list; host-injected, single per agent. `onChange` fires when the provider's map mutates — `McpRegistry` refreshes `piAgent.state.tools` for every loaded session.
- **Slug derivation:** URLs → meaningful hostname label (`mcp-slug.ts:4-18`); commands → package basename (`mcp-slug.ts:20-28`); collision-resolved by 5-char hex suffix (`resolveUniqueSlug`).
- **Tool namespacing:** `<slug>__<original-tool-name>` (`mcp-tool-adapter.ts:7-15`).
- **Secret handling:** values tagged `{ value, secret: true }`; `kvStore.list` masks secrets to `***` on ACP reads (`maskSecrets` in `kv/kv-store.ts`); in-process reads see plaintext.
- **Hydration semantics (`mcp-service.ts:96-141`):**
  - `ephemeral === undefined` → restore last-known inclusion from session log.
  - `ephemeral === []` → exclude all in this session.
  - `ephemeral === [A, B, …]` → connect+include the named slugs that exist in kv; unknown slugs silently dropped.

## 3. Hosts in scope

| Host | Transport to client | Provider | `supportsMcpStdio` | Notes |
|---|---|---|---|---|
| `bodhi-pi-cli` | stdio (REPL) | in-process per CLI invocation | `true` | `/mcp*` slash via `cli/src/repl/headless.ts` |
| `test-apps/browser` | MessagePort (worker) | per-worker in-process | `false` | Slash via `browser/src/ui-lib/ui/commands.ts`; auto-restore from Dexie on page reload (`bootstrap-worker.ts:236`) |
| `test-apps/http` (HTTP) | streamable HTTP | per-user via `ServerMcpStore` | `false` | Per-request agent rebuild; provider cache survives requests |
| `test-apps/http` (WS) | WebSocket | per-user via shared `ServerMcpStore` | `false` | Per-WS-connection agent; provider shared with HTTP path |

## 4. Test coverage matrix

| Feature | integration | e2e (direct ACP) | e2e-ui CLI | e2e-ui Playwright |
|---|---|---|---|---|
| http-streamable + auth=public — add/remove/connect/disconnect/reconnect/list/tools/include/exclude | yes | `e2e/shared/mcp-public-http.e2e.ts:17` | `e2e/cli-headless/mcp.e2e.ts:109` | `e2e-ui/shared/mcp-public-http.spec.ts:41` |
| LLM tool round-trip (`sum(20,22)=42`) | none | `mcp-public-http.e2e.ts:64`, `mcp-multi.e2e.ts:93`, `mcp-stdio.e2e.ts:51` | none | `mcp-public-http.spec.ts:16` |
| `session/new { mcpServers: [...] }` ACP-native hydration | none | `mcp-public-http.e2e.ts:116` | none | `mcp-multi.spec.ts:29` |
| `session/load`/`session/resume` restoring `mcp_inclusion_set` | `mcp.test.ts:177` | `mcp-session-resume.e2e.ts:20` | none | none |
| Cross-session include/exclude | `mcp.test.ts:148` (single-session) | `mcp-multi.e2e.ts:21` | `mcp-multi-session.e2e.ts:98` (disconnect) | `mcp-multi.spec.ts:29` |
| Multi-MCP coexistence | none | `mcp-multi.e2e.ts:93` | none | `mcp-multi.spec.ts:29` |
| transport=stdio + auth=public | `mcp-stdio-integration.test.ts:34` | `mcp-stdio.e2e.ts:12, :51` | `cli-headless/mcp-stdio.e2e.ts:12` | n/a (stdio unsupported in browser runtimes) |
| auth=header | `mcp.test.ts:75` (secret-mask only) | none | none | none |
| auth=query | none | none | none | none |
| auth=oauth-dcr | none | none | none | none |
| auth=oauth-preregistered | none | none | none | none |

## 5. Known issues going into cleanup

- `McpService` is 476 lines (god-class: kv + lifecycle + hydration + inclusion + oauth + broadcasts).
- `sanitizeSlugForAcp` (`mcp-service.ts:465`) duplicates `sanitize` (`mcp-slug.ts:42`) with subtle behaviour drift.
- `wire-agent.ts` and `wire-agent-ws.ts` ≈ 80% identical.
- `parseMcpAddArgs` defined twice (CLI vs browser) with drift (CLI parses `args=`, browser does not; browser drops `{secret: true}` tag on headers).
- Browser host re-declares all `EXT_MCP_*` constants locally.
- `HeadlessSlashSession` interface + factory defined three times in `cli-headless/*`.
- `mcp-everything` spawn duplicated between unit (`mcp-http-integration.test.ts:24`) and e2e setups (`e2e/global-setup.ts:58`) with two `waitForListening` shapes.
- Dead exports: `maskedEntry` (`mcp-service.ts:474`), `DEFAULT_OAUTH_CLIENT_NAME` (`mcp-oauth-host-api.ts:156`).
- Four variants (oauth-dcr, oauth-preregistered, header, query) shipped with code but zero e2e/e2e-ui — risk that the code rots silently.
