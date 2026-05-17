# bodhi-pi MCP cleanup — `b180f61~..HEAD`

**Date:** 2026-05-16
**Source review:** `ai-docs/reviews/2026-05-16-bodhi-pi-mcp-cleanup.md`
**Standing reference:** `ai-docs/prompts/bodhi-pi-mcp-global-state-with-per-session-inclusion.md` (`mcp_inclusion_set` design — already correctly wired, not in scope)

This plan contains three parts:
1. The cleanup plan itself (Commits 1–4) plus a follow-up prompt-generation step.
2. **Appendix A — Current MCP spec** (as implemented at `HEAD`).
3. **Appendix B — Target MCP spec** (after Commits 1–4 land).

Appendices A and B will be split out as separate `ai-docs/plans/2026-05-16-mcp-{current,target}-spec.md` files at the start of execution; they live inline here for plan-mode review.

---

## Context

MCP support landed in five commits (`b180f61` foundation+http, `414d4d7f` slash, `85bae493` stdio, `9621c18f` LLM-prompt tests, `726ba676` test commands + arch docs). The work grew "iterative organic": several variants got code without the e2e + e2e-ui coverage the bodhi-pi 6-step workflow requires. Result: a 476-line `McpService` god-class, duplicated wire-agent shells, triple-defined CLI-headless harness, drifted slash parsers, and four variants with zero tests at any level.

**Rule for keep vs delete (from user):** a variant stays if it has **at least one** of `{e2e, e2e-ui CLI (cli-headless), e2e-ui Playwright}`. Anything with only an integration test (vitest in-process) is delete-candidate. Re-introduced variants come back through a fresh feature cycle that mandates e2e + e2e-ui from commit 1.

Coverage matrix (validated against `HEAD`):

| Variant | integration | e2e (direct ACP) | e2e-ui CLI | e2e-ui Playwright | Disposition |
|---|---|---|---|---|---|
| http-streamable + auth=public — add/remove/connect/disconnect/reconnect/list/tools/include/exclude | yes | `e2e/shared/mcp-public-http.e2e.ts:17` | `e2e/cli-headless/mcp.e2e.ts:109` | `e2e-ui/shared/mcp-public-http.spec.ts:41` | **keep** |
| http-streamable + auth=public — LLM tool round-trip (`sum(20,22)=42`) | none | `mcp-public-http.e2e.ts:64`, `mcp-multi.e2e.ts:93`, `mcp-stdio.e2e.ts:51` | none | `mcp-public-http.spec.ts:16` | **keep** |
| `session/new { mcpServers: [...] }` ACP-native hydration | none | `mcp-public-http.e2e.ts:116` | none | `mcp-multi.spec.ts:29` | **keep** |
| `session/load`/`session/resume` restores `mcp_inclusion_set` | `mcp.test.ts:177` | `mcp-session-resume.e2e.ts:20` | none | none | **keep** |
| Cross-session include/exclude isolation | `mcp.test.ts:148` (single-session) | `mcp-multi.e2e.ts:21` | `mcp-multi-session.e2e.ts:98` (disconnect, not include/exclude) | `mcp-multi.spec.ts:29` | **keep** (audit E.4) |
| Multi-MCP coexistence | none | `mcp-multi.e2e.ts:93` | none | `mcp-multi.spec.ts:29` | **keep** |
| **transport=stdio + auth=public** | `mcp-stdio-integration.test.ts:34` | `mcp-stdio.e2e.ts:12, :51` | `cli-headless/mcp-stdio.e2e.ts:12` | n/a (stdio unsupported on browser runtimes) | **keep** |
| auth=header | `mcp.test.ts:75` (secret-mask only) | none | none | none | **delete** |
| auth=query | none | none | none | none | **delete** |
| auth=oauth-dcr | none | none | none | none | **delete** |
| auth=oauth-preregistered | none | none | none | none | **delete** |

Outcome:
- Delete the 4 zero-or-integration-only variants.
- Decompose `McpService` (~476 → ~200 lines after the auth shrink).
- Deduplicate host wire-agent shells, the per-host slash parsers, the triple-defined CLI-headless harness, and the two `mcp-everything` spawn helpers.
- Each deleted variant re-enters via a fresh exploratory prompt — see "Follow-up" below.

4 commits (user accepted matrix-gate cost).

---

## Commit 1 — Delete uncovered auth variants

**Goal:** `McpAuthMode` shrinks to `"public"` only. All OAuth code, secret-header config, and secret-query config gone. `transport=stdio` and `auth=public` survive intact.

**Files deleted:**
- `packages/bodhi-pi/src/mcp/mcp-oauth-host-api.ts` (156 lines — `KvOAuthProvider`, `runAuthFlow`, `DEFAULT_OAUTH_CLIENT_NAME`)
- `packages/bodhi-pi/src/mcp/mcp-oauth-host-api.test.ts`

**Files edited in place:**

- `packages/bodhi-pi/src/wire/constants.ts:102, 104` — drop `EXT_MCP_OAUTH_START`, `EXT_MCP_OAUTH_FINISH`.
- `packages/bodhi-pi/src/mcp/mcp-types.ts`:
  - line 7: `McpAuthMode = "public"`.
  - lines 27-31: drop `McpOAuthTokens`.
  - lines 33-40: `McpAuthConfig = { mode: "public" }` — drop `headers`, `queryParams`, `clientId`, `clientSecret`, `tokens`.
  - lines 21-25: drop `McpNamedSecret` if unused after the shrink (still needed for `env` on stdio entries — keep).
  - lines 120-144: prune `parseAuthConfig` to validate only `mode === "public"`.
  - lines 146-159: prune `serializeAuthConfig` mirror.
  - lines 161-198: drop `parseSecretValue`, `serializeSecretValue`, `parseTokens` if unused.
- `packages/bodhi-pi/src/mcp/mcp-auth.ts:8-21` — `resolveHttpAuth` shrinks to `() => ({ headers: {}, queryParams: {} })`. Drop `applyQueryParams` if unused after the shrink. `resolveStdioEnv` survives.
- `packages/bodhi-pi/src/mcp/mcp-client.ts:27-28` — replace `const { headers, queryParams } = resolveHttpAuth(entry.auth); const url = new URL(applyQueryParams(entry.url, queryParams));` with `const url = new URL(entry.url);` and `headers: {}`.
- `packages/bodhi-pi/src/mcp/mcp-service.ts`:
  - lines 91-92: drop `[EXT_MCP_OAUTH_START, …]`, `[EXT_MCP_OAUTH_FINISH, …]` from `register()`.
  - lines 276-318: delete `handleOAuthStart`, `handleOAuthFinish`.
  - lines 158-160: drop `parseAuthParam` call from `handleAdd`; `auth: { mode: "public" }` is the only persistable value.
  - lines 450-463: delete `parseAuthParam`.
  - lines 435-448: delete `parseNamedSecretListParam` if unused after shrink (likely still used for `env` on stdio — keep).
  - lines 26: drop `KvOAuthProvider`, `runAuthFlow` imports.
- `packages/bodhi-pi/src/client/types.ts` and `client.ts` — drop `McpAuthInput.{headers, queryParams, clientId, clientSecret, tokens}`; shrink `McpAuthMode` re-export; drop oauth client methods (`mcpOAuthStart`, `mcpOAuthFinish` or equivalents). `McpAddStdioParams` stays.
- `packages/bodhi-pi/src/index.ts:23-41` — drop oauth-related type re-exports; keep `McpAddStdioParams`.
- `packages/bodhi-pi/test-apps/browser/src/ui-lib/ui/commands.ts`:
  - lines 19-27: drop `EXT_MCP_OAUTH_START`, `EXT_MCP_OAUTH_FINISH` constants (full barrel re-export comes in Commit 2).
  - `parseMcpAddArgs` (line 346): drop `header_*` / `api_key` / `auth=<non-public>` branches; `command=` and `args=` stay (stdio).
- `packages/bodhi-pi/test-apps/cli/src/repl/headless.ts:34-72`:
  - drop `auth=` branch (only `public` remains, which is the default → no input needed).
  - drop `header_*` and `api_key` branches.
  - `command=`, `args=`, `label=`, `url=` branches stay.

**Tests touched:**
- `packages/bodhi-pi/test/mcp.test.ts:75-105` — the secret-header-masking test loses its subject (no more `auth.headers`). Delete the test; the `env` secret-masking case for stdio entries (if it exists) covers the same masking logic. Audit for any other test asserting on `auth.headers`/`auth.queryParams` and remove.
- `packages/bodhi-pi/e2e/shared/mcp-multi.e2e.ts`, `mcp-session-resume.e2e.ts` — grep for `oauth`, `header`, `query`; should be no hits but confirm.

**Survives unchanged in this commit:** `mcp-stdio-integration.test.ts`, `e2e/shared/mcp-stdio.e2e.ts`, `e2e/cli-headless/mcp-stdio.e2e.ts`, `connectMcp`'s stdio branch, `BodhiPiConfig.supportsMcpStdio`, `mcp-types.ts:McpTransport = "http" | "stdio"`, `McpServerEntry.{command, args, env}`.

**Gate:**
```
npm run -w packages/bodhi-pi test
npm run -w packages/bodhi-pi e2e                    # in-memory + cli + http + ws projects
npm run -w packages/bodhi-pi e2e:ui                 # playwright (browser + chrome-ext + http + ws)
npm run -w packages/bodhi-pi-cli e2e
```

---

## Commit 2 — Agent-core decomposition

**Goal:** the surviving `McpService` (≈200 lines post-deletion) split into focused collaborators. No behaviour change.

1. **Split `mcp-service.ts`:**
   - `packages/bodhi-pi/src/mcp/mcp-store.ts` — `loadPersistedEntries`, `persistStatus`, `persistInclusion`, `requireKv`. No I/O outside `kvStore`.
   - `packages/bodhi-pi/src/mcp/mcp-connection-lifecycle.ts` — `hydrate`, `closeSession`, `tryProviderConnect`, `tryProviderReconnect`, `emitStatusBroadcast`, `emitToolsBroadcast`, `notifyLifecycle`.
   - `packages/bodhi-pi/src/mcp/mcp-service.ts` — slim facade: `register()` dispatch table + constructor wiring of the three collaborators. Per-method handlers (`handleAdd`/`handleRemove`/`handleConnect`/`handleDisconnect`/`handleReconnect`/`handleList`/`handleTools`/`handleInclude`/`handleExclude`) delegate.

2. **Unify slug sanitisation** — `mcp-slug.ts:42-47` `sanitize` and `mcp-service.ts:465-471` `sanitizeSlugForAcp` are duplicates with a fallback-behaviour drift. Export `sanitizeSlug(name, fallback = "mcp")` from `mcp-slug.ts`; delete the in-service copy; all callers go through it.

3. **`connectMcp` stdio guard** — `mcp-client.ts:23-42` currently dispatches transport without a runtime capability check. Thread `supportsStdio: boolean` through `ConnectOptions`; throw at the stdio branch when `supportsStdio === false`. Defence in depth — the chokepoint at `handleAdd` already rejects, but a malformed kv entry shouldn't be able to spawn.

4. **Broadcast empty-sessionId sentinel** — `mcp-service.ts:369, 390` fabricate `""` when `this.sessions.size === 0`. Skip the emit when there are no sessions; drop the sentinel from the event payload shape.

5. **Dead exports:**
   - delete `maskedEntry` at `mcp-service.ts:474-476` (unused anywhere).
   - (`DEFAULT_OAUTH_CLIENT_NAME` already gone with Commit 1.)

6. **Public barrel** — `packages/bodhi-pi/src/index.ts:187-211`, add to the wire-constants re-export:
   ```
   EXT_MCP_ADD, EXT_MCP_REMOVE, EXT_MCP_CONNECT, EXT_MCP_DISCONNECT,
   EXT_MCP_RECONNECT, EXT_MCP_LIST, EXT_MCP_TOOLS,
   EXT_MCP_INCLUDE, EXT_MCP_EXCLUDE
   ```
   Prerequisite for Commit 3.

**Gate:** same set as Commit 1.

---

## Commit 3 — Host + client deduplication

**Goal:** the two HTTP host shells and the two slash parsers stop being copy-paste cousins.

**Host (review Batch C):**
1. Extract `packages/bodhi-pi/test-apps/http/src/server/agent/wire-agent-shared.ts`:
   - `buildAgentDeps(opts)` — kv/sqlite/fs/extensions wiring (currently duplicated at `wire-agent.ts:111-172` and `wire-agent-ws.ts:97-151`).
   - `createForwardingEventHandlers(conn, label)` — the 25-event forwarding block at `wire-agent.ts:47-93` vs `wire-agent-ws.ts:48-87`.
2. `wireAgentForRequest` and `wireAgentForWsConnection` keep only their lifetime shells (per-request log prefix + cwd-override Proxy for HTTP; per-WS lifetime for WS).
3. Strip multi-paragraph comments at `wire-agent.ts:47-56, 98-109, 122-125` and `wire-agent-ws.ts:48-50, 92-95, 108-109` per `feedback_no_low_value_comments`.

**Client (review Batch D, post-shrink):**
1. Extract `packages/bodhi-pi/src/client/mcp-slash.ts` exporting `parseMcpAddArgs(rest: string[])`. Pure parser, public+http and public+stdio shapes only (`url=`, `command=`, `args=`, `label=` — no auth params since `auth=public` is the only value). Re-export from `src/index.ts`.
2. `test-apps/cli/src/repl/headless.ts:34-72` and `test-apps/browser/src/ui-lib/ui/commands.ts:346-372` collapse to `import { parseMcpAddArgs } from "@bodhiapp/bodhi-pi"` + per-host dispatch. Per-host slash dispatch stays — only the argument parser is shared.
3. `test-apps/browser/src/ui-lib/ui/commands.ts:19-27` replaces local `EXT_MCP_*` consts with `import { EXT_MCP_ADD, … } from "@bodhiapp/bodhi-pi"` (commit 2 exposed these).

**Gate:** same as Commit 1.

---

## Commit 4 — Test architecture deduplication

**Goal:** drop the triple-defined CLI-headless harness, the duplicate `mcp-everything` spawn helpers, and close the multi-session-include/exclude assertion gap.

1. **Spawn helper** — extract `packages/bodhi-pi/test/helpers/spawn-mcp-everything.ts`:
   - `spawnMcpEverythingHttp(port, timeoutMs = 30_000)`.
   - `waitForListening(child, pattern: RegExp, timeoutMs)`.
   Current duplication: `test/mcp-http-integration.test.ts:24-31, 77-97` and `e2e/global-setup.ts:24-43, 58-84`. Keep the port choice distinct between unit (33334) and e2e (33345) — pass as args.

2. **CLI-headless harness** — extract `packages/bodhi-pi/e2e/cli-headless/headless-session.ts`:
   - `HeadlessSlashSession` interface (always exposes `sendChat` — the `mcp-stdio` copy currently omits it).
   - `startHeadlessSlashSession({ model, provider })`.
   Replace the triple-defined copies at:
   - `e2e/cli-headless/mcp.e2e.ts:12-78`
   - `e2e/cli-headless/mcp-stdio.e2e.ts:12-78`
   - `e2e/cli-headless/mcp-multi-session.e2e.ts:12-78`

3. **Cross-session include/exclude e2e** — audit `e2e/cli-headless/mcp-multi-session.e2e.ts:98` (currently tests disconnect across sessions, not include/exclude). If include/exclude cross-session isolation is truly not asserted end-to-end (only `e2e/shared/mcp-multi.e2e.ts:21` covers the same-session variant), add a test: include MCP X in two sessions; `/mcp exclude X` in session B; assert `/mcp tools` in session A still lists X-prefixed tools and session B does not.

4. **Unit tests use the wrapper** — `packages/bodhi-pi/test/mcp.test.ts:44, 81, 114, 128, 144, 158, 170, 184, 202` (some lines shift after Commit 1's auth-test deletion) currently call `extMethod(EXT_MCP_…)` directly. Replace with `client.mcpAdd/mcpConnect/…` so the unit suite drives the public contract.

5. **LLM-output assertion strengthening** — out of scope per user (`expect.soft(...).toContain("42")` stays as-is).

**Gate:** full matrix.

---

## Out of scope (explicit)

- `mcp_inclusion_set` session-log model — already correctly wired (`build-context.ts:102-103` → `SessionContext.mcpInclusion` → `agent.ts:427,444`).
- Session graph / fork / clone interactions with MCP — separate work.
- Adapter packages (`bodhi-pi-node`, `bodhi-pi-browser`) — user limited scope to `bodhi-pi`.
- Strengthening `expect.soft(...).toContain("42")` — user opted to keep.

---

## Follow-up — exploratory prompts (post-cleanup)

After Commits 1–4 land, generate three exploratory prompts in `ai-docs/prompts/` (recommendation-style, like `bodhi-pi-mcp-global-state-with-per-session-inclusion.md` and `bodhi-pi-src-cleanup-round-2.md`). Each prompt:

1. Explores deleted code at the predecessor commit SHA + surviving public+http shape as reference.
2. States goals + supported-runtime set.
3. Process: iterative TDD — integration (faux provider) → e2e (direct ACP) → e2e-ui (CLI REPL for cli; Playwright for browser/chrome-ext/http/ws as applicable).
4. Gate-check + commit cadence + refactor retros between runtime slices.

Sequence:
1. `auth=oauth-dcr` — KV provider, runAuthFlow, EXT_MCP_OAUTH_*; per-host callback machinery (cli loopback HTTP, web same-origin + BroadcastChannel, chrome-ext `chrome.identity.launchWebAuthFlow`).
2. `auth=oauth-preregistered` — offline client credentials, share infrastructure with oauth-dcr.
3. `auth=header` + `auth=query` — single prompt (same KV/parser surface, both inject static request modifiers).

No stdio prompt — stdio survives this cleanup.

---

## Critical files (index)

Agent core:
- `packages/bodhi-pi/src/mcp/mcp-service.ts` (476 → ~150 lines after Commits 1+2)
- `packages/bodhi-pi/src/mcp/mcp-client.ts`, `mcp-auth.ts`, `mcp-types.ts`, `mcp-slug.ts`
- `packages/bodhi-pi/src/mcp/in-process-provider.ts` (untouched)
- `packages/bodhi-pi/src/mcp/{mcp-store,mcp-connection-lifecycle}.ts` (new in Commit 2)
- `packages/bodhi-pi/src/wire/constants.ts`, `src/index.ts`
- `packages/bodhi-pi/src/client/{client,types}.ts`, `src/client/mcp-slash.ts` (new in Commit 3)
- `packages/bodhi-pi/src/acp/agent.ts` (no change — `supportsMcpStdio` stays)

Host:
- `packages/bodhi-pi/test-apps/http/src/server/agent/{wire-agent,wire-agent-ws,wire-agent-shared}.ts`
- `packages/bodhi-pi/test-apps/http/src/server/mcp/server-mcp-store.ts` (untouched)
- `packages/bodhi-pi/test-apps/browser/src/ui-lib/runtime/bootstrap-worker.ts`

Client:
- `packages/bodhi-pi/test-apps/cli/src/repl/headless.ts`
- `packages/bodhi-pi/test-apps/browser/src/ui-lib/ui/commands.ts`

Tests:
- `packages/bodhi-pi/test/{mcp,mcp-http-integration,mcp-stdio-integration}.test.ts`
- `packages/bodhi-pi/test/helpers/spawn-mcp-everything.ts` (new in Commit 4)
- `packages/bodhi-pi/e2e/global-setup.ts`
- `packages/bodhi-pi/e2e/cli-headless/{mcp,mcp-stdio,mcp-multi-session,headless-session}.e2e.ts`
- `packages/bodhi-pi/e2e/shared/{mcp-public-http,mcp-stdio,mcp-multi,mcp-session-resume}.e2e.ts`
- `packages/bodhi-pi/e2e-ui/shared/{mcp-public-http,mcp-multi}.spec.ts`

---

## Verification

```
npm run -w packages/bodhi-pi test
npm run -w packages/bodhi-pi e2e                    # all 6 vitest projects
npm run -w packages/bodhi-pi e2e:ui                 # playwright
npm run -w packages/bodhi-pi-cli e2e
```

End-to-end smoke (manual):
1. `npm run -w packages/bodhi-pi/test-apps/http dev`; open browser client.
2. `/mcp add url=http://localhost:33345/mcp label=demo`.
3. `/mcp connect demo`; expect tool list.
4. Chat prompt: "Using the demo MCP, find the sum of 20 and 22". Expect `42` in the reply and a `tool_call` session update for the namespaced tool.
5. `/mcp disconnect demo`; `/mcp remove demo`; expect status notifications.
6. CLI stdio smoke: `bodhi-pi-cli`, `/mcp add command=npx args='["--yes","@modelcontextprotocol/server-everything","stdio"]' label=local`; `/mcp connect local`; tool list shows `local__add`, `local__get-tiny-image`, etc.

---

## Appendix A — Current MCP spec (as-implemented at `HEAD`)

### A.1 Public surface

**Extension methods** (`src/wire/constants.ts:84-104`):

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

**Lifecycle notifications** (`LIFECYCLE_EVENT_METHOD` payloads):
- `mcp_status_change { sessionId, slug, status: "connected"|"disconnected"|"error", errorMessage? }` — `mcp-service.ts:364-387`.
- `mcp_tools_change { sessionId, slug, toolNames: string[] }` — `mcp-service.ts:389-395`.

**Session log entries** (`src/sessions/entries.ts:37-40`):
- `mcp_inclusion_set { id, parentId, timestamp, slugs: string[] }` — written by `persistInclusion` (`mcp-service.ts:351-362`) on `include`/`exclude`/`hydrate`; read by `buildSessionContext` (`build-context.ts:102-103`) into `SessionContext.mcpInclusion`; threaded to `hydrate` via `agent.ts:427,444`.

**Types** (`src/mcp/mcp-types.ts`):
- `McpTransport = "http" | "stdio"` (line 5).
- `McpAuthMode = "public" | "header" | "query" | "oauth-dcr" | "oauth-preregistered"` (line 7).
- `McpAuthConfig = { mode, headers?, queryParams?, clientId?, clientSecret?, tokens? }` (lines 33-40).
- `McpServerEntry = { transport, url?, command?, args?, env?, auth, lastKnownStatus, addedAt, label }` (lines 42-52).
- `McpListEntry`, `McpToolInfo`, `SecretValue`, `McpNamedSecret`, `McpOAuthTokens`.
- `MCP_PREFIX = "mcp/"` (line 3).

**Config (`BodhiPiConfig`):**
- `supportsMcpStdio?: boolean` (default `true`) — `acp/agent.ts:105`. Rejecting hosts must pass `false`.
- `mcpConnectionProvider: McpConnectionProvider` (host-injected, single per agent).

**Public barrel (`src/index.ts`):**
- `createInProcessMcpConnectionProvider`, `McpConnectionProvider`, `McpProviderConnectResult`, `McpServerEntry`, `McpToolInfo`, `MCP_PREFIX`, `parseMcpServerEntry`.
- Types: `McpAddHttpParams`, `McpAddParams`, `McpAddResult`, `McpAddStdioParams`, `McpAuthInput`, `McpAuthMode`, `McpConnectParams`, `McpConnectResult`, `McpDisconnectResult`, `McpExcludeParams`, `McpExcludeResult`, `McpIncludeParams`, `McpIncludeResult`, `McpListItem`, `McpNamedValueInput`, `McpRemoveResult`, `McpStatus`, `McpToolsResult`, `McpTransport`.
- `EXT_MCP_*` constants: **not currently in the barrel** (drift target).

### A.2 Capabilities

- **Transports:** `http` (`StreamableHTTPClientTransport`, `mcp-client.ts:29`); `stdio` (`StdioClientTransport` via dynamic import, `mcp-client.ts:36`).
- **Auth modes:** `public` (no extra request shape), `header` (named secret headers), `query` (named secret query params), `oauth-dcr` (Dynamic Client Registration via `KvOAuthProvider`), `oauth-preregistered` (offline `client_id`/`client_secret`).
- **Per-session inclusion:** session-log `mcp_inclusion_set` (above).
- **Global connection state:** `McpConnectionProvider` holds the per-slug live `Client` + tool list; host-injected, single per agent. `onChange` fires when the provider's connection map mutates — `McpRegistry` refreshes `piAgent.state.tools` for every loaded session.
- **Slug derivation:** URLs → meaningful hostname label (`mcp-slug.ts:4-18`); commands → package basename (`mcp-slug.ts:20-28`); collision-resolved by 5-char hex suffix (`resolveUniqueSlug`).
- **Tool namespacing:** `<slug>__<original-tool-name>` (`mcp-tool-adapter.ts:7-15`).
- **Secret handling:** values tagged `{ value, secret: true }`; `kvStore.list` masks secrets to `***` on ACP reads (`maskSecrets` in `kv/kv-store.ts`), unmasked on in-process reads.
- **Hydration semantics (`mcp-service.ts:96-141`):**
  - `ephemeral === undefined` → restore last-known inclusion from session log.
  - `ephemeral === []` → exclude all in this session.
  - `ephemeral === [A, B, …]` → connect+include the named slugs that already exist in kv; unknown slugs silently dropped.

### A.3 Hosts in scope

| Host | Transport to client | Provider | `supportsMcpStdio` | Notes |
|---|---|---|---|---|
| `bodhi-pi-cli` | stdio (REPL) | in-process per CLI invocation | `true` | `/mcp*` slash via `cli/src/repl/headless.ts` |
| `test-apps/browser` | MessagePort (worker) | per-worker in-process | `false` | Slash via `browser/src/ui-lib/ui/commands.ts`; auto-restore from Dexie on page reload (`bootstrap-worker.ts:236`) |
| `test-apps/http` (HTTP) | streamable HTTP | per-user via `ServerMcpStore` | `false` | Per-request agent rebuild; provider cache survives requests |
| `test-apps/http` (WS) | WebSocket | per-user via shared `ServerMcpStore` | `false` | Per-WS-connection agent; provider shared with HTTP path |

### A.4 Test coverage (matrix above)

### A.5 Known issues going into cleanup

- `McpService` is 476 lines (god-class).
- `sanitizeSlugForAcp` (mcp-service.ts:465) duplicates `sanitize` (mcp-slug.ts:42) with subtle behaviour drift.
- `wire-agent.ts` and `wire-agent-ws.ts` ≈ 80% identical.
- `parseMcpAddArgs` defined twice (CLI vs browser) with drift.
- Browser host re-declares all `EXT_MCP_*` constants locally.
- `HeadlessSlashSession` interface + factory defined three times in `cli-headless/*`.
- `mcp-everything` spawn duplicated between unit and e2e setups with two `waitForListening` shapes.
- Dead exports: `maskedEntry` (`mcp-service.ts:474`), `DEFAULT_OAUTH_CLIENT_NAME` (`mcp-oauth-host-api.ts:156`).
- Four variants (oauth-dcr, oauth-preregistered, header, query) shipped with code but zero e2e/e2e-ui.

---

## Appendix B — Target MCP spec (after Commits 1–4)

### B.1 Public surface — changes vs Appendix A

**Extension methods removed:**
- `_bodhi-pi/mcp/oauth/start`, `_bodhi-pi/mcp/oauth/finish`. Remaining 9 methods unchanged in signature.

**Types shrunk:**
- `McpAuthMode = "public"`.
- `McpAuthConfig = { mode: "public" }`.
- `McpOAuthTokens`, `SecretValue` (if no other use), `clientId`, `clientSecret`, `tokens`, `headers`, `queryParams` fields gone.
- `McpServerEntry` keeps `{ transport, url?, command?, args?, env?, auth, lastKnownStatus, addedAt, label }`. (`McpNamedSecret` stays for stdio `env`.)
- `McpTransport = "http" | "stdio"` — unchanged.

**Types removed from client barrel:**
- `McpAuthInput` fields trimmed (`headers`, `queryParams`, `clientId`, `clientSecret`, `tokens` gone).
- Oauth client methods removed from `BodhiPiClient`.
- `McpAddStdioParams`, `McpAddHttpParams`, `McpAddParams`, `McpConnectParams`, … — kept.

**Public barrel — added:**
- `EXT_MCP_ADD`, `EXT_MCP_REMOVE`, `EXT_MCP_CONNECT`, `EXT_MCP_DISCONNECT`, `EXT_MCP_RECONNECT`, `EXT_MCP_LIST`, `EXT_MCP_TOOLS`, `EXT_MCP_INCLUDE`, `EXT_MCP_EXCLUDE`.
- `parseMcpAddArgs` (new helper) from `src/client/mcp-slash.ts`.

**Lifecycle notifications:**
- Same two payload types. `sessionId === ""` sentinel removed: when `sessions.size === 0` no broadcast fires.

**Session log entries:**
- `mcp_inclusion_set` — unchanged.

**Config (`BodhiPiConfig`):**
- `supportsMcpStdio?: boolean` — unchanged.
- `mcpConnectionProvider` — unchanged.

### B.2 Capabilities — changes

- **Transports:** unchanged (`http`, `stdio`).
- **Auth modes:** `public` only.
- **`connectMcp` stdio guard:** rejects at the stdio branch when `supportsStdio === false` (defence in depth beyond the `handleAdd` chokepoint).
- **Slug sanitisation:** single `sanitizeSlug(name, fallback)` in `mcp-slug.ts`; per-method slug normalisation drift eliminated.
- **Hydration semantics:** unchanged.
- **Secret handling:** unchanged for stdio `env`; auth-side secret tags gone (no more auth secrets).

### B.3 Internal structure

`packages/bodhi-pi/src/mcp/` shape:

| File | Role | Approx. LoC |
|---|---|---|
| `in-process-provider.ts` | Default `McpConnectionProvider` implementation | 100 (unchanged) |
| `mcp-client.ts` | `connectMcp` (http + stdio with capability guard) | 70 |
| `mcp-auth.ts` | `resolveStdioEnv` (likely the only survivor) | 20 |
| `mcp-connection-provider.ts` | Interface (unchanged) | 50 |
| `mcp-registry.ts` | Per-session inclusion + tool merging (unchanged) | 80 |
| `mcp-slug.ts` | Slug helpers + unified `sanitizeSlug` | 60 |
| `mcp-store.ts` (new) | KV CRUD for `mcp/<slug>` | 60 |
| `mcp-connection-lifecycle.ts` (new) | Hydration + connect/disconnect/reconnect + broadcasts | 130 |
| `mcp-service.ts` (slim) | `register()` dispatch + handler facade | 90 |
| `mcp-tool-adapter.ts` | Tool wrapping (unchanged) | 75 |
| `mcp-types.ts` | Shrunk type module | 80 |

Test layout:

| File | Role |
|---|---|
| `test/mcp.test.ts` | Integration: add/remove/list/include/exclude/session-resume — uses `BodhiPiClient` wrapper |
| `test/mcp-http-integration.test.ts` | Real mcp-everything http connect |
| `test/mcp-stdio-integration.test.ts` | Real mcp-everything stdio spawn |
| `test/helpers/spawn-mcp-everything.ts` (new) | Shared spawn + waitForListening |
| `e2e/cli-headless/headless-session.ts` (new) | Shared `HeadlessSlashSession` + factory |
| `e2e/cli-headless/{mcp,mcp-stdio,mcp-multi-session}.e2e.ts` | Use shared headless harness |
| `e2e/shared/{mcp-public-http,mcp-stdio,mcp-multi,mcp-session-resume}.e2e.ts` | Direct-ACP cross-runtime |
| `e2e-ui/shared/{mcp-public-http,mcp-multi}.spec.ts` | Playwright DOM-driven |

Host layout:

| File | Role |
|---|---|
| `test-apps/http/src/server/agent/wire-agent-shared.ts` (new) | `buildAgentDeps` + `createForwardingEventHandlers` |
| `test-apps/http/src/server/agent/wire-agent.ts` | Per-request shell |
| `test-apps/http/src/server/agent/wire-agent-ws.ts` | Per-WS shell |
| `test-apps/http/src/server/mcp/server-mcp-store.ts` | Per-user `McpConnectionProvider` cache (unchanged) |
| `test-apps/browser/src/ui-lib/ui/commands.ts` | Slash dispatch, imports `EXT_MCP_*` + `parseMcpAddArgs` from barrel |
| `test-apps/cli/src/repl/headless.ts` | Slash dispatch, imports `parseMcpAddArgs` from barrel |

### B.4 Behaviour parity statement

All passing tests at the start of Commit 1 must still pass at the end of Commit 4, with these exceptions:
- `test/mcp.test.ts:75-105` (secret-header masking) — deleted alongside Commit 1.
- Any test asserting on `auth.headers`, `auth.queryParams`, `clientId`, `clientSecret`, `tokens`, or `_bodhi-pi/mcp/oauth/*` — deleted.

Public-host smoke (`/mcp add url=… → connect → tools → /sum-prompt → disconnect → remove`) must behave identically across in-memory, cli, http, ws, browser, chrome-ext.

CLI stdio smoke (`/mcp add command=npx args='[…]' → connect → /sum-prompt`) must behave identically in cli + in-memory.
