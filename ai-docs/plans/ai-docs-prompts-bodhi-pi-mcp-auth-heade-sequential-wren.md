# Plan: re-introduce MCP header + query auth (HTTP-streamable)

## Context

`bodhi-pi` currently ships exactly one MCP auth × transport combination: `auth = "public"` × `transport = "http-streamable"`. An earlier attempt landed header, query, OAuth-DCR, OAuth-preregistered, and stdio in one push without per-variant e2e coverage; the resulting drift forced commit `6a3966f4` to delete every non-public variant (see `ai-docs/plans/20260516-cleanup-plan.md`, `ai-docs/reviews/2026-05-16-bodhi-pi-mcp-cleanup.md`).

This plan re-introduces **only** header + query value attachment for the existing HTTP-streamable transport. The agent loop is untouched — auth attachment is a pure Host↔MCP-server concern that lives inside `connectMcp` (`packages/bodhi-pi/src/mcp/mcp-client.ts:25-30`). OAuth and stdio re-introduction are explicitly out of scope (separate prompts).

The plan follows the 7-step TDD gate from `packages/bodhi-pi/CLAUDE.md:61-72`. Every slice ends with a passing `npm test` + `npm run check`, then a commit. Per `feedback_e2e_coverage_keeps_feature`, the variant must end the work with ≥1 of {e2e, cli-headless, Playwright} — slices 2/5/6 provide all three.

## Locked decisions (from prompt + this session)

| # | Decision | Source |
|---|---|---|
| 1 | `/mcp add` takes one JSON object argument. Old `url=…` kv parser is replaced. Public-mode invocations migrate to the same shape. | Prompt § Locked design choices |
| 2 | **`auth` is a top-level string discriminator**: `"public"` or `"http-param"`. Future OAuth modes (`"oauth-dcr"`, `"oauth-preregistered"`) extend the union. Single envelope shape for every auth mode. | User feedback (this session) |
| 3 | When `auth === "http-param"`, sibling fields `headers?: Record<string,string>` and `queries?: Record<string,string>` are accepted at the top level. JSON object form (not array of one-key objects) — duplicate names are not preserved. | User feedback (this session) |
| 4 | Internal storage represents `auth.headers` / `auth.queries` as `McpNamedSecret[]` (`{name, value, secret: true}`) so existing `maskSecrets` walks them uniformly. The parser converts input objects to arrays at the boundary. | This session |
| 5 | Headers and queries can coexist on a single entry; both apply to every request. | Prompt § Headers and queries can coexist |
| 6 | No `api_key=` shorthand. JSON is the only input shape. | Prompt § Drop `api_key=` shorthand |
| 7 | `auth: "http-param"` with no headers AND no queries (or both empty) → `-32602`. `auth: "public"` with sibling headers/queries present → `-32602` (no silent attachment). Unknown `auth` value → `-32602`. | Session Q&A + this session |
| 8 | `_bodhi-pi/mcp/list` exposes the full auth blob (same shape as persisted entry) with secret values masked via existing `maskSecrets` recursion. | Session Q&A |
| 9 | Authenticated e2e targets a local `example-remote-server` fixture spawned alongside the existing `mcp-everything` server (deterministic bearer + query validation). | Session Q&A |

## Critical files

### Core (`packages/bodhi-pi/src/`)
- `mcp/mcp-types.ts` — widen `McpAuthMode`/`McpAuthConfig`; reuse `McpNamedSecret`; rewrite `parseAuthConfig` (`mcp-types.ts:100-105`) and `serializeMcpServerEntry` (`mcp-types.ts:85-98`) for the new shape; add `parseHeaderQueryEntry` (one-key object → `McpNamedSecret`).
- `mcp/mcp-service.ts:handleAdd` (lines 99-128) — replace key=value param shape with a single JSON object. Drop `parseNamedSecretListParam` (lines 234-247) and the `env_<NAME>=` path; the new parser handles headers/queries via the new one-key-object helper. Keep `parseStringArray` only if still needed.
- `mcp/mcp-client.ts:connectMcp` (lines 25-30) — single attachment site. Extract `entry.auth.headers` into a header dict and `entry.auth.queries` into URL search params **before** constructing `new StreamableHTTPClientTransport(url)`. Investigate the SDK's `StreamableHTTPClientTransport` constructor signature during implementation: it likely accepts a `requestInit.headers` second arg; if not, fall back to a per-request modifier. **Decide based on SDK API, not memory.**
- `client/types.ts` (lines 100-126) — widen `McpAuthInput` and `McpAddParams` to the new union.
- `client/client.ts:mcpAdd` (lines 296-308) — pass through the new shape; no body translation.
- `client/mcp-slash.ts:parseMcpAddArgs` (lines 17-43) — replace the key=value regex with a single `JSON.parse(rest.join(" "))`. Return the parsed object; let the server-side parser validate shape.
- `kv/kv-store.ts:maskSecrets` (lines 20-36) — zero code change. Pin behavior with one new unit test asserting nested headers/queries arrays are masked.
- `wire/constants.ts` (lines 83-100) — zero change. `EXT_MCP_ADD` literal unchanged; only param shape changes.

### Reference Hosts (`packages/bodhi-pi/test-apps/`)
- `cli/src/client/acp/headless.ts:tryHandleSlash` (lines 25-119, specifically `/mcp add` at 68-81) — slash routes through `parseMcpAddArgs`; the parser change cascades through. No CLI-specific logic needed.
- `browser/src/client/lib/commands.ts:handleMcpSubcommand` (lines 209-336, `/mcp add` at 249-265) — also routes through `parseMcpAddArgs`. Same cascade applies. chrome-ext consumes this via the subpath import from `browser/package.json:7-18` — no separate worker change.
- `browser/src/host/kv/dexie-kv-store.ts` (lines 13-39) — opaque JSON storage; round-trip the new shape with a unit test.
- `http/src/host/agent/wire-agent-shared.ts:buildAgentFactory` (lines 97-147) — already per-user `kvDir` prefix at line 108-110 and per-user `McpConnectionProvider` at line 111. **Verify** during slice 7 that the auth blob remains isolated per user (load-bearing security gap if not).
- `http/src/host/mcp/server-mcp-store.ts` (lines 15-26) — `ServerMcpStore` keeps per-user providers alive across per-turn rebuild. Auth flows through `entry.auth` without store-level changes.
- `app-utils/host-agent.ts:createBodhiPiHostAgent` (lines 27-36) — no signature change.

### Spec surface (`ai-docs/specs/bodhi-pi/`)
- `mcp.md` — auth section (lines 95-99) currently hardcodes `mode: "public"`. Rewrite to document the new union, the one-key-object entry rule, secret-tagging behavior, and the `-32602` rejection rules.
- `mcp.md` — `McpServerEntry` shape (lines 23-36) — update the `auth` field.
- `acp.md` — `_bodhi-pi/mcp/add` row (line 81) currently lists `{url?, command?, args?, env?, label?}`. Update to the JSON-object shape; document `-32602` cases (multi-key entry, empty `auth`, missing `url`).
- `acp.md` — `_bodhi-pi/mcp/list` row — document that auth values are masked via `maskSecrets`.
- `packages/bodhi-pi/CONTEXT.md` (lines 82-90) — extend the MCP glossary entry to mention header/query auth; reuse `McpNamedSecret` cross-reference.
- `configuration.md` (lines 140-150) — `mcp/<slug>` KV layout still authoritative; add a line noting the new auth blob nesting.

## Approach (7 slices, one commit each)

Per the prompt: commit per slice, full matrix passes between commits. Expensive e2e + e2e-ui run at slice boundaries, not per-edit. If matrix gating proves expensive in practice (`feedback_cleanup_plan_phasing`), slices 3+4 (adapter round-trip tests) and slices 5+6 (cli + Playwright) may be combined — but only after each runs green individually.

### Slice 1 — Core integration tests + impl

`packages/bodhi-pi/test/`:
- `mcp-auth-header.test.ts` — `/mcp add {url, auth:{headers:[{"Authorization":"Bearer X"}]}}` → kv persists with `secret: true` tagging → `EXT_KV_GET` returns `***` for header values → in-process kv read returns plaintext → `EXT_MCP_LIST` returns the entry with masked auth values.
- `mcp-auth-query.test.ts` — same shape, `queries` instead.
- `mcp-auth-mixed.test.ts` — both arrays populated; one case asserting duplicates preserved verbatim; one case asserting multi-key entry → `-32602`; one case asserting empty `auth: {}` → `-32602`.
- `mcp.test.ts` migration — update the public-mode tests (`mcp.test.ts:35-129`) to use `auth: "public"` JSON shape. Remove any case exercising the old `url=…` kv parser.

Impl: widen types (`mcp-types.ts`), rewrite `parseAuthConfig`, rewrite `handleAdd` to accept JSON, replace `parseMcpAddArgs` in `client/mcp-slash.ts` with JSON parse, attach headers + queries inside `connectMcp` (`mcp-client.ts:29`). Add the `maskSecrets` regression test in `kv/kv-store.test.ts` for nested header/query arrays.

### Slice 2 — Core e2e against real authenticated MCP

`packages/bodhi-pi/e2e/`:
- Add `helpers/example-remote-server.ts` — spawn `https://github.com/modelcontextprotocol/example-remote-server` configured with a known bearer + query param, on a new port (`global-setup.ts:101-103` currently uses 33345 for `mcp-everything`; pick 33346 for the new fixture).
- `e2e/shared/mcp-auth-header.e2e.ts` — gpt-4o-mini round-trip: add → connect → tool-call → assert side-effect with `Authorization` header.
- `e2e/shared/mcp-auth-query.e2e.ts` — same with `?api_key=…`.
- `e2e/shared/mcp-public-http.e2e.ts:17-62` — confirm the existing public-mode e2e still passes against `mcp-everything` after the slash JSON migration.

### Slice 3 — Node adapter round-trip

`packages/bodhi-pi/test-apps/node-adapters/`:
- Add a unit test in the kv adapter test file round-tripping a serialized `McpServerEntry` with mixed headers + queries through the SQLite-backed store. Expected: zero adapter code change because the store is opaque JSON.

### Slice 4 — Browser/chrome-ext adapter round-trip

`packages/bodhi-pi/test-apps/browser/src/host/kv/dexie-kv-store.test.ts` (or its sibling spec file):
- Vitest + fake-indexeddb test round-tripping the new entry shape. chrome-ext gets coverage for free via subpath imports.

### Slice 5 — CLI e2e through stdin/stdout

`packages/bodhi-pi/test-apps/cli/e2e/`:
- New e2e file `mcp-auth.e2e.ts` driving `/mcp add {…JSON…}` through `bodhi-pi-cli` stdin. Assert: JSON parses correctly; `/mcps` (via the round-trip through `_bodhi-pi/mcp/list`) shows masked `***` values; tool call against the example-remote-server fixture succeeds.

### Slice 6 — Playwright across browser + chrome-ext

`packages/bodhi-pi/test-apps/browser/e2e/` + `packages/bodhi-pi/test-apps/chrome-ext/e2e/`:
- Extend the existing public-mode spec (`e2e-ui/shared/mcp-public-http.spec.ts:16-85`) or add a sibling spec for header/query auth. The browser test-app's slash input field already accepts arbitrary text — drive a JSON `/mcp add {…}` invocation through it. Use `data-testid` selectors per `playwright` skill conventions.

### Slice 7 — HTTP host integration + cross-turn isolation

`packages/bodhi-pi/test-apps/http/test/integration/`:
- New faux-provider integration test proving: (a) auth shape persists across per-turn agent rebuild; (b) per-user kv prefix at `wire-agent-shared.ts:108-110` isolates two users' auth blobs (user A's `Authorization` header is not readable by user B). The cross-user isolation case is load-bearing security per the prompt.
- Optional `test-apps/http/e2e/mcp-auth.e2e.ts` — cross-turn real-LLM call against the example-remote-server fixture.

## Reuse already in tree

- `McpNamedSecret` (`mcp-types.ts:12-16`) — reuse for header/query entries; no new shape.
- `maskSecrets` (`kv/kv-store.ts:20-36`) — generic recursive walker, already detects `{value, secret:true}` at any nesting. Zero code change.
- `ServerMcpStore` (`test-apps/http/src/host/mcp/server-mcp-store.ts:15-26`) — already keeps per-user providers alive across the per-turn agent rebuild.
- `createBodhiPiHostAgent` (`test-apps/app-utils/host-agent.ts:27-36`) — shared Host bootstrap; no signature change required.
- `e2e/global-setup.ts:101-103` — pattern for spawning a test MCP server; mirror it for the example-remote-server fixture.

## Verification

After each slice:
- `npm test -w @bodhiapp/bodhi-pi` (core unit + integration)
- `npm run check -w @bodhiapp/bodhi-pi` (lint + typecheck)

After slice 2: `npm run e2e -w @bodhiapp/bodhi-pi` (gpt-4o-mini round-trip).

After slice 5: cli-headless e2e (`npm run e2e:cli -w @bodhiapp/bodhi-pi` or equivalent — check `packages/bodhi-pi/test-apps/cli/package.json` for the actual script name).

After slice 6: Playwright (`npm run e2e -w @bodhiapp/bodhi-pi-test-app-browser` and same for chrome-ext).

After slice 7: HTTP integration suite (`npm test -w @bodhiapp/bodhi-pi-test-app-http`).

End-to-end manual smoke (optional, after slice 6):
1. Run a browser Host locally.
2. `/mcp add {"url":"http://localhost:33346/mcp", "auth":{"headers":[{"Authorization":"Bearer test"}]}}`.
3. `/mcp connect <slug>`.
4. `/mcps` — confirm the entry lists with `***` masked header value.
5. Issue a tool call that requires auth; assert the server-side log shows the bearer was sent.

## Open SDK question to resolve in slice 1

`StreamableHTTPClientTransport` constructor signature — verify by reading `node_modules/@modelcontextprotocol/sdk/dist/...` during slice 1 implementation:
- If it accepts `(url, opts)` with `opts.requestInit.headers` → use that path.
- If headers can only be set per-request via a modifier callback → wire that.
- Either way, queries attach by mutating `URL.searchParams` before constructing the transport (the SDK does not need to know about query auth).

Pin the chosen approach with a unit test in `mcp-client.test.ts` asserting both headers + queries reach a stubbed transport.

## Out of scope

- OAuth modes (separate prompts in `ai-docs/prompts/bodhi-pi-mcp-auth-oauth-{dcr,preregistered}.md`).
- Stdio transport reintroduction.
- Per-session header overrides; dynamic header rotation; SSE transport.
