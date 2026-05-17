# bodhi-pi MCP — auth header+query (HTTP-streamable transport) re-introduction

## Status going in

`bodhi-pi` currently ships **one** MCP auth × transport combination:

- `auth = "public"` × `transport = "http-streamable"`

An earlier attempt shipped `auth=header`, `auth=query`, OAuth-DCR, OAuth-preregistered, and stdio transport in one go without per-variant e2e or e2e-ui coverage. The drift made it impossible to confidently rip out broken pieces in isolation; the cleanup commit (`6a3966f4`, plan `ai-docs/plans/prepare-clean-up-plan-crispy-moler.md`) removed every non-public variant. **Do not repeat that mistake.** This prompt scopes to exactly **one** new auth surface — header + query value attachment for the existing HTTP-streamable transport — landed iteratively per the bodhi-pi 7-step TDD gate.

OAuth re-introduction is tracked separately under `ai-docs/prompts/bodhi-pi-mcp-auth-oauth-*.md`. Stdio transport reintroduction has no current prompt. Both are explicitly out of scope here.

## What "header + query auth" means

The user provides one or more static **HTTP headers** and/or **query parameters** that the MCP client attaches to every outbound request against a remote HTTP-streamable MCP server. Typical use cases:

- `Authorization: Bearer <api-key>` against a server that authenticates via long-lived token.
- `?api_key=<key>` against a webhook-style endpoint that reads the key from the URL.

The agent loop is **oblivious**: it receives `AgentTool`s from `McpRegistry` and calls them like any other tool. Auth attachment is a pure Host↔MCP-server concern that lives inside the connection layer (currently `McpConnectionProvider` + whatever http-streamable client it constructs). No changes to the agent loop or to `pi-agent-core` types.

## Locked design choices (do not re-litigate)

These were resolved before kickoff; treat them as fixed inputs.

### Slash command shape — single JSON object argument

`/mcp add` takes **one** argument: a JSON object. The public-mode invocation is migrated to the same shape, so there is exactly one parser surface for any auth mode.

```text
/mcp add {"url": "https://example-server.modelcontextprotocol.io/mcp", "auth": "public"}
/mcp add {"url": "https://example-server.modelcontextprotocol.io/mcp", "auth": {"headers": [{"Authorization": "Bearer X"}]}}
/mcp add {"url": "https://example-server.modelcontextprotocol.io/mcp", "auth": {"queries": [{"api_key": "k1"}]}}
/mcp add {"url": "https://example-server.modelcontextprotocol.io/mcp", "auth": {"headers": [{"Authorization": "Bearer X"}], "queries": [{"api_key": "k1"}]}}
```

`auth` is either the literal string `"public"` OR an object with `headers?: Array<…>` and/or `queries?: Array<…>`. Presence-based — there is no separate `mode` enum.

The old positional/key=value parser (`url=`, `command=`, `args=`, `env_<NAME>=`, `label=`) is **removed in the same slice** that introduces the JSON shape. There is no back-compat parser layer; the on-disk `McpServerEntry` shape stays the same so existing kv entries keep working — only the slash UX changes.

### Header / query entry shape — one-key objects

Each headers/queries entry is a single-key JSON object that mirrors the HTTP literal, allowing duplicate keys to flow through as separate array entries:

```json
{
  "headers": [
    {"Authorization": "Bearer primary"},
    {"X-Trace": "abc"},
    {"Authorization": "Bearer fallback"}
  ],
  "queries": [
    {"api_key": "k1"}
  ]
}
```

Parser rule: each object MUST contain exactly one key. Multi-key objects are rejected with `-32602`. Duplicate header/query names across separate entries are preserved verbatim — HTTP allows duplicates and some servers care.

Internal storage and KV-layer secret masking still uses `McpNamedSecret = {name, value, secret: true}` shape (already in `packages/bodhi-pi/src/mcp/mcp-types.ts` for stdio `env`). The parser is the conversion point: it lifts each one-key object into a `McpNamedSecret` with `secret: true` set automatically — every header/query value is treated as a secret. Reads through `EXT_KV_GET` / `EXT_MCP_LIST` mask values to `***`; in-process reads (the MCP connection client) see plaintext. This matches `feedback_bodhi_pi_kvstore_secrets`.

### Drop `api_key=` shorthand

The old prompt proposed `api_key=foo` as syntactic sugar for `header_Authorization=Bearer foo`. Dropped — JSON is the only input. Less magic, simpler parser, no shorthand to maintain across runtimes.

### Headers and queries can coexist

A single MCP entry may carry both `headers` and `queries`. Both apply to every request. (The old prompt left this as a fork — it's now resolved: multi-mode.)

## Architecture pointers

Paths reflect the post-host/client-split layout (commits `cb14de30` and ancestors).

### Core (`packages/bodhi-pi/src/`)

- `mcp/mcp-types.ts` — `McpAuthMode`, `McpAuthConfig`, `McpServerEntry`, `McpNamedSecret`, `parseMcpServerEntry`/`serializeMcpServerEntry`. Widen `McpAuthMode` and `McpAuthConfig`; reuse `McpNamedSecret` for header/query entries.
- `mcp/mcp-service.ts:handleAdd` — currently parses `url`/`command`/`args`/`env` from key/value params. Replace its param-shape with the unified JSON object. Also touches `handleAdd`'s sibling helpers that build entries from kv reads.
- `mcp/mcp-connection-lifecycle.ts` — already wires `connect`/`reconnect`/`hydrate`. Auth attachment happens inside `provider.connect`/`reconnect`, which the lifecycle calls. Confirm the auth blob is threaded through `McpServerEntry` into the provider.
- `mcp/in-process-provider.ts` — the default single-tenant provider. Wherever it constructs the http-streamable client, surface a `requestModifier` (headers + url query params) derived from `entry.auth`.
- `client/client.ts:mcpAdd` + `client/mcp-slash.ts:parseMcpAddArgs` — the Client-side helpers Hosts use to call `_bodhi-pi/mcp/add`. Both flip to single-JSON-object input.
- `kv/kv-store.ts:maskSecrets` — already masks deeply-nested `{value, secret:true}` shapes for stdio `env`. Confirm it covers the new header/query nesting (likely zero-change; add a unit test pinning the contract).
- `wire/constants.ts` — `EXT_MCP_ADD` literal. No change to the method name; only param shape changes.

### Reference Hosts (`packages/bodhi-pi/test-apps/`)

Per runtime-Host parity rule (CLAUDE.md): every user-visible feature must land in all four reference Hosts. For this feature the "user-visible" surface is:

- The `/mcp add` slash UX (each Host that exposes a chat surface).
- The `_bodhi-pi/mcp/add` ACP method (every Host).
- The new auth blob is persisted in the Host's `KvStore` adapter — verify single-tenant SQLite (`test-apps/node-adapters/.../kv`), Dexie (`test-apps/browser/src/host/kv/dexie-kv-store.ts`), and the per-user `kv` wiring in `test-apps/http` all round-trip the shape unchanged.

The `createBodhiPiHostAgent` helper added in D12 (`test-apps/app-utils/host-agent.ts`) is the assembly point — no Host-side adapter changes are expected.

### Spec surface (`ai-docs/specs/bodhi-pi/`)

Update in lock-step with code (CLAUDE.md "Stale specs are a regression by default"):

- `mcp.md` — auth modes table; `_bodhi-pi/mcp/add` param shape; secret-handling note.
- `acp.md` — `_bodhi-pi/mcp/add` row in the extension-methods table.
- `configuration.md` — `BodhiPiConfig` is unchanged; only mention if auth flag is added.
- `CONTEXT.md` (bodhi-pi root) — add `McpNamedSecret`, `auth` to the glossary if missing.

## Iterative slices — bodhi-pi 7-step TDD gate

Per CLAUDE.md, every feature lands in this order. **Do not skip any step.** Per `feedback_e2e_coverage_keeps_feature`, a variant without ≥1 of {e2e, cli-headless, Playwright} coverage doesn't survive a cleanup pass.

Commit per slice; full matrix passes (`npm test`, `npm run check`) between commits. Expensive e2e + e2e-ui runs at slice boundaries, not per-edit.

1. **Core integration** (`packages/bodhi-pi/test/`) — failing-then-passing integration tests against an in-process ACP pair:
   - `mcp-auth-header.test.ts` — `/mcp add` with `{auth: {headers: [...]}}` → kv persists with `secret: true` tagging → `EXT_KV_GET` returns `***` for header values but the in-process kv read returns plaintext → `EXT_MCP_LIST` returns the entry with auth presence flag but masked values.
   - `mcp-auth-query.test.ts` — same shape, queries instead.
   - `mcp-auth-mixed.test.ts` — both arrays populated; one test asserting duplicates are preserved verbatim.
   - **Public-mode migration test** — the existing `/mcp add {auth: "public"}` flow round-trips through the new JSON shape (the old key=value parser is gone). Update or replace any existing `mcp.test.ts` cases that exercise the old shape.

2. **Core e2e** (`packages/bodhi-pi/e2e/`) — real LLM (gpt-4o-mini, per memory `feedback_bodhi_pi_e2e_strategy`) against a real authenticated MCP server:
   - Use `https://example-server.modelcontextprotocol.io/mcp` (no auth required — keep one round-trip there proving public still works after the slash migration).
   - For authenticated cases, prefer the local fixture: `https://github.com/modelcontextprotocol/example-remote-server` spun up in a helper under `packages/bodhi-pi/e2e/helpers/<runtime-neutral>/` that validates a configured bearer token and a configured query param. Perplexity MCP is acceptable as a smoke test but is not deterministic enough for assertion-driven e2e.
   - Each test drives `add → connect → tool-call → assert side-effect` and asserts the LLM completed the tool round.

3. **Node adapters** (`packages/bodhi-pi/test-apps/node-adapters/`) — if the auth blob requires any adapter-side shape change (e.g. SQLite column for the kv value blob), implement + unit-test here. Expected: zero adapter change because kv stores opaque JSON.

4. **Browser host** (`packages/bodhi-pi/test-apps/browser/src/host/`) — Dexie kv adapter round-trips the new shape. Vitest + fake-indexeddb unit test that round-trips a serialized `McpServerEntry` carrying mixed headers + queries. chrome-ext flows from the same Host-side code per subpath imports — no separate worker.

5. **CLI e2e** (`packages/bodhi-pi/test-apps/cli/e2e/`) — drive the new slash through `bodhi-pi-cli`'s stdin/stdout. Assert the JSON parser surface; assert the round-trip through `_bodhi-pi/mcp/list` shows masked values via `***`. Use the local example-remote-server fixture.

6. **Playwright** — `packages/bodhi-pi/test-apps/browser/e2e/` + `packages/bodhi-pi/test-apps/chrome-ext/e2e/`. The browser test-app's MCP add form needs to either:
   - Accept the raw JSON blob, OR
   - Build the JSON from a structured form (URL field + headers list + queries list) and submit it.
   Either is fine; if the form already exists for public mode, extend it minimally. Drive add → connect → assert toolset via Playwright `data-testid` selectors.

7. **HTTP integration** (`packages/bodhi-pi/test-apps/http/test/integration/`) — faux-provider test proving the new auth shape survives the per-turn agent rebuild. The multi-tenant kv store (`test-apps/http/src/host/kv/`) round-trips the entry; the per-user `McpConnectionProvider` re-establishes connections with the auth applied. Optional cross-turn e2e (`test-apps/http/e2e/`) for a tool call across rebuilds.

## Open design questions (decide during execution)

These are genuine forks the kickoff should resolve before the final commit lands; document the choice in `mcp.md`.

- **Empty auth objects** — is `{"auth": {"headers": []}}` valid or rejected with `-32602`? Recommend rejecting at `_bodhi-pi/mcp/add` (and `parseMcpServerEntry`) — an empty array is indistinguishable from `"public"` and silently equating them invites confusion.
- **Where auth attaches in the in-process provider** — does the provider construct a fresh http client per `connect()` carrying the auth, or does it pass a per-request modifier into a shared client? Whichever fits the underlying MCP SDK client cleanest; pick the option that survives a connection-pool refactor.
- **Query value URL encoding** — assume the MCP SDK client URL-encodes query values when building the request. Add a unit test that pins this (a value containing `&` should not break the URL).
- **`McpListEntry` shape on `_bodhi-pi/mcp/list`** — does the list response expose `hasAuth: boolean` (presence flag), or a full sanitized `auth` object with `***` masks, or nothing at all? Cleanest: expose a small `auth: {headers: [{name}], queries: [{name}]}` (names only, no values) so a UI can show "uses Authorization + X-API-Key" without seeing secrets.
- **Multi-tenant http isolation** — confirm that `test-apps/http`'s per-user kv prefix already isolates auth blobs; if not, this is a load-bearing security gap that lands in slice 7.

## Reference MCP servers for testing

| Server | URL / repo | Auth supported | Use for |
|---|---|---|---|
| MCP example server (no-auth) | `https://example-server.modelcontextprotocol.io/mcp` | none | Public-mode regression + post-migration smoke |
| MCP example remote server (local) | `https://github.com/modelcontextprotocol/example-remote-server` | configurable bearer + query | Deterministic e2e assertions in helpers/ |
| `@modelcontextprotocol/server-everything` | npm pkg | accepts arbitrary headers passively | Useful for header pass-through smoke; doesn't validate auth |
| Perplexity MCP | (third-party) | requires API key | Acceptable smoke; non-deterministic for assertions |

Prefer the local example-remote-server fixture — deterministic, no rate limits, can be configured with the test's expected token.

## Out of scope (file separately if needed)

- OAuth modes (DCR, preregistered) — see `ai-docs/prompts/bodhi-pi-mcp-auth-oauth-dcr.md`, `ai-docs/prompts/bodhi-pi-mcp-auth-oauth-preregistered.md`.
- Stdio transport — no current prompt; spin one up before resurrecting.
- Per-session header overrides — current model is one auth blob per slug at the Host level.
- Dynamic header rotation (per-request signatures) — separate variant; this prompt is static-secrets only.
- SSE transport — deferred indefinitely; HTTP-streamable is the only http transport.

## References

- Prior bodhi-pi shape (the version that was ripped out): `git show 6a3966f4 -- packages/bodhi-pi/src/mcp/mcp-types.ts packages/bodhi-pi/src/mcp/mcp-auth.ts packages/bodhi-pi/src/mcp/mcp-service.ts`
- KvStore masking contract: `packages/bodhi-pi/src/kv/kv-store.ts` → `maskSecrets`
- Secret-handling rule: memory `feedback_bodhi_pi_kvstore_secrets` (ACP reads mask `***`; in-process reads unmasked)
- MCP architecture: `ai-docs/specs/bodhi-pi/mcp.md`
- 7-step TDD gate: `packages/bodhi-pi/CLAUDE.md` § Feature workflow
- e2e strategy: memory `feedback_bodhi_pi_e2e_strategy` (gpt-4o-mini, single cheap model per feature)
- e2e layout: memory `feedback_bodhi_pi_e2e_layout` (per-runtime helpers, category code folds into umbrella)
- Cleanup review (drift this prompt prevents): `ai-docs/reviews/2026-05-16-bodhi-pi-mcp-cleanup.md`
- Companion auth prompts: `ai-docs/prompts/bodhi-pi-mcp-auth-oauth-dcr.md`, `ai-docs/prompts/bodhi-pi-mcp-auth-oauth-preregistered.md`
- Recent design-smell follow-up (relevant: D5 surfaces unknown slugs, D9 advertises kv/mcp availability, D10 unifies wire events): `ai-docs/plans/ai-docs-plans-2026-05-17-bodhi-pi-desig-delegated-haven.md`
