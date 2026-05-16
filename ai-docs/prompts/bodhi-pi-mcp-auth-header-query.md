# bodhi-pi MCP — auth=header + auth=query re-introduction

## Status going in

The first MCP rollout shipped `auth=header` and `auth=query` (static request modifiers — pre-shared API keys passed in either HTTP headers or query parameters) without any e2e or e2e-ui coverage. Only an integration test exercised the secret-masking path. Both were deleted in commit `6a3966f4` (cleanup plan `ai-docs/plans/prepare-clean-up-plan-crispy-moler.md`).

This prompt re-introduces both modes in a single arc — they share the same kv schema, parser shape, and `resolveHttpAuth` dispatch.

## Goal

`auth=header` lets a user attach one or more static headers to every MCP request — typical use case is `Authorization: Bearer <api-key>` against an MCP server that authenticates with a long-lived token instead of OAuth.

`auth=query` does the same for query parameters — some MCP servers (especially webhook-style endpoints) expect `?api_key=…` rather than a header.

Both are conceptually simple. The trap is **secret masking**: header values and query-param values containing tokens MUST be tagged `{ value, secret: true }` so `EXT_KV_GET` / `EXT_MCP_LIST` mask them when ACP clients read them back. The cleanup deleted the secret-masking integration test (`packages/bodhi-pi/test/mcp.test.ts:75` in commit `5ecf3658`); rebuilding it (and exercising it via e2e + e2e-ui) is the core deliverable.

## What still exists

Post-cleanup target shape (`ai-docs/plans/2026-05-16-mcp-target-spec.md`):

- `McpAuthMode = "public"`. You will widen to `"public" | "header" | "query"`.
- `McpAuthConfig = { mode: "public" }`. You will add optional `headers?: McpNamedSecret[]` and `queryParams?: McpNamedSecret[]`. `McpNamedSecret = { name, value, secret: true }` already exists for stdio `env`.
- `resolveHttpAuth` was deleted from `mcp-auth.ts`; reintroduce it (or absorb the logic into `mcp-client.ts:connectMcp` — your call).
- `parseMcpAddArgs` in `packages/bodhi-pi/src/client/mcp-slash.ts` accepts `url`, `command`, `args`, `env_<NAME>`, `label`. You will add `auth=`, `header_<NAME>=`, `query_<NAME>=`, `api_key=` (shorthand for `header_Authorization=Bearer <value>`).
- `BodhiPiClient.mcpAdd` (`packages/bodhi-pi/src/client/client.ts`) stops at public auth; widen its `auth` param + body builder.

## Process — iterative TDD across the matrix

Per `feedback_e2e_coverage_keeps_feature`, you do not declare a variant done without coverage at the e2e or e2e-ui layer.

Suggested order (one commit per slice):

1. **Integration first.** `packages/bodhi-pi/test/mcp-auth-header-query.test.ts` — round-trip `/mcp add` + `/mcp list` + `EXT_KV_GET` for both modes; assert kv masks the secret value to `***` on ACP-side reads but the in-process kv read sees plaintext (per `feedback_bodhi_pi_kvstore_secrets`). Mode-conformance: `mode: "header"` with no headers is allowed (the user can add them later — or reject if you prefer strict). `mode: "query"` with no params, same.
2. **e2e direct-ACP.** `packages/bodhi-pi/e2e/shared/mcp-auth-header.e2e.ts` + `mcp-auth-query.e2e.ts` — pick a real public MCP server that accepts header-based or query-based auth (`@modelcontextprotocol/server-everything` accepts arbitrary headers; you can also stand up a tiny fixture HTTP server in `e2e/helpers/` that validates a specific bearer token). Drive add → connect → tool call. Cross-runtime: in-memory + cli + http + ws.
3. **e2e-ui CLI.** Update `parseMcpAddArgs` + `bodhi-pi-cli`'s slash help. `packages/bodhi-pi/e2e/cli-headless/mcp-auth-header.e2e.ts` drives `/mcp add url=… header_Authorization="Bearer secret"` via stdin/stdout, then `/mcp connect`, then `/mcp tools`.
4. **e2e-ui Playwright.** Browser test-app form takes header/query inputs. Playwright spec drives the form + asserts the toolset.

## Design choices to resolve

- **Schema enforcement vs. permissiveness.** Should `mode: "header"` require at least one header? Or allow an empty `headers: []` (semantically equivalent to `public`)? Recommendation: require ≥1, throw `-32602` on add if empty — keeps the modes meaningful.
- **`api_key=` shorthand.** Convenience — `api_key=foo` becomes `header_Authorization=Bearer foo`. Both the original CLI and browser parsers had it. Keep it, but only one of `api_key=` or `header_Authorization=` should be allowed per `/mcp add` — error otherwise.
- **Query secrets in URLs.** Query params end up in the URL string — kv masking helps on ACP reads, but they may show up in log files / proxy logs at the runtime. Document the risk in the slash help.
- **Header vs query at the same MCP.** Allow both modes to coexist? The original code stored arrays for both fields on a single `McpAuthConfig`. Pick: single-mode (mode determines which array is honoured) vs. multi-mode (`headers` AND `queryParams` both apply regardless of `mode`). Single-mode is cleaner; pick it.
- **kvStore masking guarantee.** The masking lives in `packages/bodhi-pi/src/kv/kv-store.ts:maskSecrets`. Confirm via unit test it masks deeply-nested `{ value, secret: true }` shapes inside arrays. (The cleanup kept the stdio-env masking test as the surviving witness — extend it to cover header/query auth nesting.)

## Gate-check + commit cadence

- Commit per runtime slice; full matrix between commits.
- Final retro: pull duplication between `mcp-auth-header.e2e.ts` and `mcp-auth-query.e2e.ts` into shared helpers if a pattern emerges (likely a `assertAuthedToolCall(url, expectedHeaderName, expectedHeaderValue)` style helper).
- Update `packages/bodhi-pi/CLAUDE.md` MCP section to re-list the supported auth modes.

## References

- Prior bodhi-pi shape (header + query): `git show 6a3966f4 -- packages/bodhi-pi/src/mcp/mcp-types.ts packages/bodhi-pi/src/mcp/mcp-auth.ts packages/bodhi-pi/src/mcp/mcp-service.ts`
- KvStore masking contract: `packages/bodhi-pi/src/kv/kv-store.ts:maskSecrets`
- Secret-handling rule: memory `feedback_bodhi_pi_kvstore_secrets` (ACP reads mask `***`; in-process reads unmasked)
- Surviving public-only types: `packages/bodhi-pi/src/mcp/mcp-types.ts`
- Cleanup review (drift this prompt prevents): `ai-docs/reviews/2026-05-16-bodhi-pi-mcp-cleanup.md`
- Companion OAuth prompts: `ai-docs/prompts/bodhi-pi-mcp-auth-oauth-dcr.md`, `ai-docs/prompts/bodhi-pi-mcp-auth-oauth-preregistered.md`

## Out of scope

- OAuth modes (covered by the dedicated prompts).
- Dynamic header rotation (e.g. derived per-request signatures). If you need this, scope a separate variant.
- Per-session header overrides — the current model has one auth config per slug at the global level.
