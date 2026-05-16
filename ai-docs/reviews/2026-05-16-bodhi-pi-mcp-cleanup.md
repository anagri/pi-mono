# bodhi-pi review — mcp interim cleanup

**Snapshot:** 2026-05-16, range `b180f61~..HEAD` (5 commits: `b180f61` foundation+http, `414d4d7f` slash, `85bae493` stdio, `9621c18f` sum-LLM tests, `726ba676` test commands + arch docs). Scope: `packages/bodhi-pi/` only — `src/` (agent), `test-apps/*/server/` (host), `test-apps/*/ui-lib|repl/` (client), `test/`, `e2e/`, `e2e-ui/`. Variants done: `transport=http-streamable, auth=public`. Remaining: stdio polish, oauth-dcr, oauth-preregistered, header/query auth. Every finding is verified at `HEAD` with a `file:line` cite and is fix-now actionable.

---

## Batch A — `McpService` decomposition (Commit 1)

**A.1** `McpService` is a 476-line god-class: kv persistence + connection lifecycle + ephemeral hydration + per-session inclusion + auth orchestration + status/tool broadcasts + lifecycle-method notifications all live in one file.
- `packages/bodhi-pi/src/mcp/mcp-service.ts:53-427`
- Split into four collaborators that the agent composes: `McpStore` (kv layer: `loadPersistedEntries`, `persistStatus`, `persistInclusion`, requireKv, mask/parse) `+ McpConnectionLifecycle` (`tryProviderConnect`, `tryProviderReconnect`, `hydrate`, `closeSession`) `+ McpInclusionService` (`handleInclude`, `handleExclude`, `handleTools`) `+ McpOAuthCoordinator` (`handleOAuthStart`, `handleOAuthFinish`). `McpService` keeps only the `register()` dispatch table and the constructor wiring. This makes adding oauth-pre + header/query trivial: each new auth mode lives in one file.

**A.2** Module-private `sanitizeSlugForAcp` duplicates `mcp-slug.ts:sanitize` with a different empty-fallback rule, producing two slug-normalisation behaviours.
- `packages/bodhi-pi/src/mcp/mcp-service.ts:465-471` vs `packages/bodhi-pi/src/mcp/mcp-slug.ts:42-47`
- Export `sanitizeSlug(name: string, fallback = "mcp")` from `mcp-slug.ts`; delete the in-service copy; call sites in `slugifyUrl`, `slugifyCommand`, and `hydrate` go through the one helper.

**A.3** `parseAuthParam` (slash-side parsing) and `parseAuthConfig` (kv-side parsing) re-enumerate the same `McpAuthMode` literal union, drifting independently.
- `packages/bodhi-pi/src/mcp/mcp-service.ts:454-456` and `packages/bodhi-pi/src/mcp/mcp-types.ts:124-130`
- Export `isMcpAuthMode(value: unknown): value is McpAuthMode` from `mcp-types.ts`; both parsers narrow through it. Adding a new mode = one edit at `mcp-types.ts:7`.

**A.4** `parseAuthParam` silently coerces unknown auth modes to `"public"` instead of rejecting; this drops misconfigured client requests on the floor and the failure surfaces only as "connect failed" later.
- `packages/bodhi-pi/src/mcp/mcp-service.ts:454-457`
- Throw `RequestError(-32602, "${EXT_MCP_ADD}: unknown auth mode '${mode}'")` when the input is provided and unrecognised. Keep the no-`mode` case defaulting to `"public"`.

**A.5** `handleAdd` accepts `auth.mode === "oauth-preregistered"` without enforcing the pre-registered `clientId` field, so persisted entries fail mysteriously at `/mcp connect` time when the credentials are missing.
- `packages/bodhi-pi/src/mcp/mcp-service.ts:147-177`, schema permits omission at `mcp-types.ts:37,138`
- In `handleAdd`, after `parseAuthParam`, require `auth.clientId` (and validate `clientSecret` shape) when `mode === "oauth-preregistered"`; reject with `-32602`.

**A.6** `resolveHttpAuth` writes `Authorization: Bearer …` only for the two oauth modes; `"header"` and `"query"` modes are effectively "free-form pass-through" with no mode-driven dispatch, masking the contract.
- `packages/bodhi-pi/src/mcp/mcp-auth.ts:8-21`
- Replace the inline `if` with a `Record<McpAuthMode, (auth) => ResolvedHttpAuth>` strategy table — `public` → empty; `header` → headers only; `query` → query only; `oauth-dcr`/`oauth-preregistered` → bearer + extra headers. Each new mode plugs in at one site.

**A.7** `connectMcp` does not guard against stdio paths on stdio-disabled hosts — the only chokepoint is `handleAdd`. A kv entry written before a host capability changed (or by another path) will still attempt `spawn`.
- `packages/bodhi-pi/src/mcp/mcp-client.ts:23-42`
- Thread `supportsStdio` into `ConnectOptions` and throw at line 34 when `transport === "stdio" && !opts.supportsStdio`. Same guard fires at `hydrate` and `handleConnect`.

**A.8** `emitStatusBroadcast` and `emitToolsBroadcast` invent a fake empty-string `sessionId` when no sessions exist so the broadcast still fires once; downstream subscribers must filter the sentinel.
- `packages/bodhi-pi/src/mcp/mcp-service.ts:369, 390`
- Either skip emit when `this.sessions.size === 0` (no listeners need it) or change the event payload to make `sessionId` optional and stop fabricating `""`.

---

## Batch B — Public surface + dead exports (Commit 1)

**B.1** `DEFAULT_OAUTH_CLIENT_NAME` is exported but never imported anywhere.
- `packages/bodhi-pi/src/mcp/mcp-oauth-host-api.ts:156`
- Delete. `clientMetadata` at line 43 already uses an inline default.

**B.2** `maskedEntry` is exported from `mcp-service.ts` but never imported anywhere.
- `packages/bodhi-pi/src/mcp/mcp-service.ts:474-476`
- Delete. Callers use `maskSecrets` from `kv/kv-store.ts` directly.

**B.3** The `src/index.ts` barrel re-exports MCP type aliases (`McpListItem`, `McpAddHttpParams`, etc.) but NOT the `EXT_MCP_*` wire constants — `test-apps/browser/.../commands.ts` then re-declares the constants locally because it cannot import them.
- `packages/bodhi-pi/src/index.ts:187-211` (no `EXT_MCP_*`); cf. `packages/bodhi-pi/test-apps/browser/src/ui-lib/ui/commands.ts:19-27`
- Add `EXT_MCP_ADD, EXT_MCP_REMOVE, EXT_MCP_CONNECT, EXT_MCP_DISCONNECT, EXT_MCP_RECONNECT, EXT_MCP_LIST, EXT_MCP_TOOLS, EXT_MCP_INCLUDE, EXT_MCP_EXCLUDE, EXT_MCP_OAUTH_START, EXT_MCP_OAUTH_FINISH` to the `wire/constants` re-export block at `src/index.ts:187`.

---

## Batch C — Host duplication (Commit 2)

**C.1** `wireAgentForRequest` (HTTP) and `wireAgentForWsConnection` (WS) are 80% identical. The only structural difference is per-connection vs per-request lifetime; everything else (kv dir resolution, sqlite store wiring, NodeFilesystem, extension loader, event-forwarding handlers, MCP provider fetch from `ServerMcpStore`, supportsMcpStdio:false, Proxy-wrap for cwd override) is verbatim.
- `packages/bodhi-pi/test-apps/http/src/server/agent/wire-agent.ts:47-172` vs `packages/bodhi-pi/test-apps/http/src/server/agent/wire-agent-ws.ts:48-151`
- Extract `buildAgentDeps(opts) → { agentFactory, cwd }` in a shared `wire-agent-shared.ts`. The two wrappers retain only their lifetime-specific shells (per-request vs per-connection logging prefix and the Proxy-attach call).

**C.2** Event-forwarding handler block is duplicated verbatim (forwards all 25 BodhiPiEvent types to client via `extNotification`) — only the console log prefix differs (`http` vs `http ws`).
- `wire-agent.ts:47-93` vs `wire-agent-ws.ts:48-87`
- Export `createForwardingEventHandlers(conn, label)` from the shared module; both callers thread their label in.

**C.3** Comment styles diverge for the same code path. The HTTP wire-agent has multi-paragraph rationale on lifecycle events and multi-tenant kv; the WS wire-agent has terser one-liners for the same logic. Per `feedback_no_low_value_comments`, both are noise; the code already names what it does.
- `wire-agent.ts:47-56, 98-109, 122-125, 140-141` and `wire-agent-ws.ts:48-50, 92-95, 108-109, 122`
- Delete the multi-paragraph blocks; keep only `// stdio MCP requires in-memory + cli host` at the `supportsMcpStdio: false` line.

---

## Batch D — Client (test-app) slash-parser unification (Commit 2)

**D.1** `parseMcpAddArgs` is implemented twice with semantic drift: the CLI version accepts `args=` (parses JSON or whitespace-split) and validates the auth mode against the five-mode literal union; the browser version omits `args=` entirely and stores headers without the `secret: true` marker the kv layer requires for masking.
- `packages/bodhi-pi/test-apps/cli/src/repl/headless.ts:34-72` vs `packages/bodhi-pi/test-apps/browser/src/ui-lib/ui/commands.ts:346-372`
- Move the parser to `packages/bodhi-pi/src/client/mcp-slash.ts` (a pure parsing helper, no I/O); export `parseMcpAddArgs`. Both hosts import it and apply the result to their host-specific dispatch. This is *not* a violation of "per-host slashes are by design" — slashes need to live per-host for the OAuth-callback differences; the *argument parser* is pure and shared.

**D.2** Browser `commands.ts` hardcodes the eleven `EXT_MCP_*` method strings as local consts, drifting from the canonical wire definitions.
- `packages/bodhi-pi/test-apps/browser/src/ui-lib/ui/commands.ts:19-27`
- Once Batch B.3 lands, replace with `import { EXT_MCP_ADD, … } from "@bodhiapp/bodhi-pi"`.

**D.3** CLI headless parser accepts `auth=oauth-dcr` and `auth=oauth-preregistered` as valid values (line 55) but `tryHandleSlash` has no `/mcp oauth/start` or `/mcp oauth/finish` subcommand — the validation passes, the user gets a persisted record they cannot drive to "connected" through the CLI.
- `packages/bodhi-pi/test-apps/cli/src/repl/headless.ts:55, 119-130`
- Either gate the parser to currently-driveable modes (`public`, `header`, `query`) until the oauth slashes land, or implement the oauth subcommands (deferred to the dedicated oauth-dcr commit).

---

## Batch E — Test architecture (Commit 3)

**E.1** `mcp-everything` is spawned by two independent helpers with two different `waitForListening` regexes and two different port choices; the unit-test spawn at `mcp-http-integration.test.ts` happens once per file, the e2e spawn at `e2e/global-setup.ts` happens once per run.
- `packages/bodhi-pi/test/mcp-http-integration.test.ts:24-31` (port 33334, regex `/listening on port/`) + `packages/bodhi-pi/e2e/global-setup.ts:58-84` (port 33345, same regex inline)
- Extract `spawnMcpEverythingHttp(port, timeoutMs)` and a generic `waitForListening(child, pattern, timeout)` to `packages/bodhi-pi/test/helpers/spawn-mcp-everything.ts`; reuse from both call sites.

**E.2** `HeadlessSlashSession` interface plus `startHeadlessSlashSession` factory is redefined verbatim in three e2e files, with subtle drift (`mcp.e2e.ts` carries a `sendChat` method; the other two don't).
- `packages/bodhi-pi/e2e/cli-headless/mcp.e2e.ts:12-78`, `packages/bodhi-pi/e2e/cli-headless/mcp-stdio.e2e.ts:12-78`, `packages/bodhi-pi/e2e/cli-headless/mcp-multi-session.e2e.ts:12-78`
- Move to `packages/bodhi-pi/e2e/cli-headless/headless-session.ts`; export one interface plus one factory with `sendChat` always defined. Three files become three imports.

**E.3** The `"42"` substring assertion against gpt-4o-mini output appears in five places without any guard against output drift (e.g., "forty-two", "= 42", or a wrapped markdown response).
- `packages/bodhi-pi/e2e/shared/mcp-multi.e2e.ts:142`, `packages/bodhi-pi/e2e/shared/mcp-public-http.e2e.ts:113`, `packages/bodhi-pi/e2e/shared/mcp-stdio.e2e.ts:90`, `packages/bodhi-pi/e2e/cli-headless/mcp.e2e.ts:162`, `packages/bodhi-pi/e2e-ui/shared/mcp-public-http.spec.ts:37`
- Strengthen by asserting BOTH the `tool_call` session-update (tool name `<slug>__add` or `<slug>__sum` with `{a:20,b:22}` args) AND a numeric substring `/\b42\b/`. The current `toContain("42")` matches "420", "1042", etc. Extract a `assertSumOutcome(updates, expected)` helper to `e2e/helpers/mcp-asserts.ts`.

**E.4** Multi-session include/exclude isolation is not covered. `test/mcp.test.ts:148-175` exercises include/exclude on one session; `e2e/cli-headless/mcp-multi-session.e2e.ts:98-151` exercises multi-session disconnect but never asserts that an exclude in session B leaves session A's tool surface intact.
- `packages/bodhi-pi/e2e/cli-headless/mcp-multi-session.e2e.ts:98-151` (uncovered branch)
- Add a test: connect MCP X in both sessions, `/mcp exclude X` in session B, assert `/mcp tools` in session A still lists X's tools and session B's does not.

**E.5** `e2e/shared/mcp-stdio.e2e.ts:95-113` gates on `isRuntime("http") || isRuntime("ws") || isRuntime("browser") || isRuntime("chrome-ext")` and asserts the rejection path; no comment explains the inverted gate, so a reader has to read the runtime list twice to deduce the intent.
- `packages/bodhi-pi/e2e/shared/mcp-stdio.e2e.ts:95-96`
- Inline a one-liner: `// asserts supportsMcpStdio=false hosts reject /mcp add command=…`. Skip if the assertion description already encodes that — currently it does not.

**E.6** Unit tests in `test/mcp.test.ts` call `extMethod()` directly while every e2e and the spec barrel use `client.mcpAdd()/mcpConnect()/…` wrappers. If the wrapper diverges from the wire surface, unit tests pass while e2e fails (or vice versa).
- `packages/bodhi-pi/test/mcp.test.ts:44, 81, 114, 128, 144, 158, 170, 184, 202` (all direct `extMethod` calls)
- Switch unit tests to the `BodhiPiClient` wrapper. The wrapper is the public contract; unit tests should drive it.

---

## Batch F — Hydration / session-state transition (Commit 3 — sequenced with E)

**F.1** `hydrate` silently drops ephemeral `mcpServers` entries that are not yet persisted in kv — the `if (!entry) continue;` branch at line 128 is the same defect the user already identified at the http-runtime skip. Promoting ephemerals to kv is the planned fix (`ai-docs/plans/20260515-mcp-4-mcp-in-session.md`), but the silent-drop today should at minimum log + emit a `mcp_status_change` of `"error"` so the client knows the include was a no-op.
- `packages/bodhi-pi/src/mcp/mcp-service.ts:122-141`
- Until the mcp-4 plan lands, replace `continue` at line 128 with `this.logger.warn(…); await this.emitStatusBroadcast(slug, "error", "not registered; call /mcp add first");`. Once mcp-4 lands, this whole branch goes away.

**F.2** `persistInclusion` writes a `mcp_inclusion_set` session entry on every include/exclude/hydrate, but `buildSessionContext`/`session-bootstrap` do not currently extract it — the `restoredSlugs` parameter at `hydrate(sessionId, ephemeral, restoredSlugs)` is fed `null` from all current callers. The session-level state therefore round-trips through the entry log but never gets read back.
- `packages/bodhi-pi/src/mcp/mcp-service.ts:104, 351-362` (writer); `packages/bodhi-pi/src/sessions/build-context.ts` (reader missing)
- Add an `mcpInclusionSet?: string[]` field to `SessionContext`; in `buildSessionContext`, walk entries for the most-recent `mcp_inclusion_set`. `session-bootstrap` returns it; the agent passes it to `hydrate(... , restoredSlugs)`. (This is the prerequisite the `mcp-4` plan calls out; flag here so reviewers see the half-wired pipe before they touch related code.)

---

## Suggested commit grouping

Three commits, each independently gate-checkable (matrix tests: bodhi-pi `test`, bodhi-pi `e2e` in-memory project + http project, cli `e2e`).

1. **Commit 1 — Agent core cleanup (`src/mcp/` + `src/index.ts`).** Batches A + B. Decompose `McpService`, unify slug sanitisation, unify auth-mode validation, fix `oauth-preregistered` validation gap, add `connectMcp` stdio guard, replace `resolveHttpAuth` if-chain with strategy table, delete dead exports, surface `EXT_MCP_*` in the barrel. Gate: existing `test/mcp*.test.ts` + `e2e/shared/mcp-public-http.e2e.ts` + `e2e/shared/mcp-stdio.e2e.ts` stay green; no behaviour change beyond the rejected `oauth-preregistered` without `clientId` (add a test for that case).

2. **Commit 2 — Test-app host + client deduplication (`test-apps/`).** Batches C + D. Extract `wire-agent-shared.ts` + `createForwardingEventHandlers`, strip multi-paragraph comments, move `parseMcpAddArgs` to `src/client/mcp-slash.ts`, browser imports `EXT_MCP_*` from the barrel. Gate: `e2e/cli-headless/*`, `e2e/shared/mcp*`, `e2e-ui/shared/mcp*` stay green.

3. **Commit 3 — Test architecture + transition glue (`test/`, `e2e/`, `e2e-ui/`).** Batches E + F. Helpers for spawn + headless-session, strengthen `42` assertions, add multi-session include/exclude e2e, wire the `mcp_inclusion_set` reader through `buildSessionContext`/`session-bootstrap`, log+broadcast on hydrate-drop. Gate: full matrix; the new include/exclude e2e covers what was previously asserted only in the unit harness.
