# Testing

Three layers, each with a distinct stub policy and runtime profile. The same surface (`bodhi-pi` + reference Hosts) is exercised at all three layers — the test pyramid is **wide, not steep**.

## Layer 1 — Integration tests (`packages/bodhi-pi/test/`)

In-process ACP pair. Faux providers (no network). In-memory adapters.

- Runner: `vitest` via `vitest.config.ts`.
- Test files: 35+ specs, one per feature (`chat.test.ts`, `commands.test.ts`, `mcp.test.ts`, `mcp-http-integration.test.ts`, `compaction.test.ts`, …).
- Shared helpers under `test/helpers/`:
  - `harness.ts` — `createTestHarness(opts)` is the **single source of truth** for ACP test wiring. Spins up an in-process pair, returns both `ClientSideConnection` and a `controls` object for advancing time / asserting events.
  - `in-process-connection.ts` — the in-process pair primitive.
  - `extension-fixtures.ts` — common extension factories.
  - `faux-script.ts` — scripted faux provider for deterministic tool-call rounds.
  - `seed-auth.ts` — primes `auth/<provider>` keys via the same ACP flow tests are supposed to validate.
  - `spawn-mcp-everything.ts` — boots a real MCP HTTP/stdio server for end-to-end MCP tests.
  - `event-recorder.ts` — collects events for ordered assertion.
- **Stub strategy**:
  - For tool-call rounds: prefer `registerFauxProvider` over `aimock`. aimock SSE isn't always parsed for tool-call frames (per `CLAUDE.md` test conventions).
  - Filesystem and SessionStore: always in-memory via `createInMemoryFilesystem` / `createInMemorySessionStore` unless the test is asserting an adapter's own behaviour.
- **Conventions** (from `CLAUDE.md`):
  - No `if (cond) { expect(...) }` — use narrowing helpers and `expect(val, "diag").toBe(...)`.
  - No milestone IDs in filenames (`chat.test.ts` not `m2_1_chat.test.ts`).
  - Shared helpers live in `test/helpers/` — never duplicate.

## Layer 2 — Agent e2e with real LLM (`packages/bodhi-pi/e2e/`)

Real `gpt-4o-mini` round-trips through the in-process ACP pair. Real adapters.

- Runner: `vitest` via `vitest.e2e.config.ts` (composes `test.include` directly — does **not** use `mergeConfig`).
- Test files under `e2e/cli-headless/`, plus shared fixtures + setup in `e2e/global-setup.ts`, `e2e/setup/`, `e2e/shared/`.
- Per-feature default model: `gpt-4o-mini` (non-reasoning, cheap). Cross-provider parity lives in `e2e/chat.e2e.ts`.
- API keys: loaded from per-package `e2e/.env.test` and seeded through the same ACP `_bodhi-pi/kv/set auth/<provider>` path tests are supposed to validate (helper: `test/helpers/seed-auth.ts` → `seedAuth(...)`).
- **Assertion style**: side effects + stable substrings, never exact model text.

## Layer 3 — UI end-to-end (`packages/bodhi-pi/e2e-ui/`)

Playwright. Real Chrome + browser host + real LLM.

- Runner: Playwright (`playwright.config.ts`).
- Drives a built browser Host through the worker, exercising the full transport + UI + agent loop.
- Same model + key seeding policy as Layer 2.
- Pages + fixtures under `e2e-ui/pages/`, `e2e-ui/fixtures.ts`, `e2e-ui/global-setup.ts`, `e2e-ui/helpers/`.
- Test results land in `e2e-ui/test-results/` and `e2e-ui/playwright-report/`.

## Per-Host e2e — under each test-app

Each Host has its own `e2e/` directory exercising the Host through its own transport:

| Host | Location | Runner | Notes |
|---|---|---|---|
| cli | `test-apps/cli/e2e/*.e2e.ts` (when present) | vitest | RPC mode + headless mode |
| http | `test-apps/http/e2e/*.e2e.ts` | vitest | Boots the server, talks to it over HTTP+SSE |
| browser | `test-apps/browser/e2e/*.spec.ts` | Playwright | Same shape as agent e2e but driven through Chrome + worker; seeded `window.__bodhiPiWebSeed` workspace |
| chrome-ext | `test-apps/chrome-ext/e2e/*.spec.ts` | Playwright + extension loader | MV3 service worker exercised through extension page |

Cross-host parity is enforced by feature: every shipped feature must reach every Host's e2e. PARITY.md tracks status.

## What runs where

| Scenario | Layer |
|---|---|
| New built-in tool — does it behave under the merge order? | Integration (`test/`) |
| Faux provider returns a malformed tool call — does the loop recover? | Integration |
| Real model end-to-end produces a `tool_result` chain through ACP | Agent e2e (`e2e/`) |
| Browser host loads a session and replays history correctly | UI e2e (`e2e-ui/`) |
| http per-turn rebuild preserves MCP inclusion across requests | Per-Host e2e (`test-apps/http/e2e/`) — server-side via real LLM |
| Chrome extension sandbox script executor runs a skill | Per-Host e2e (`test-apps/chrome-ext/e2e/`) |
| MCP OAuth (pre-registered or DCR) end-to-end against a PKCE-validating server | Integration (`test/mcp-oauth*.test.ts`) + cli-headless e2e (`e2e/cli-headless/mcp-oauth*.e2e.ts`) + UI e2e (`e2e-ui/shared/mcp-oauth.spec.ts`) — fixture lives in `e2e/helpers/oauth-mcp-server.ts`, spawned by both `e2e/global-setup.ts` and `e2e-ui/global-setup.ts` so every layer can drive a deterministic OAuth flow. The fixture serves RFC 9728 + 8414 + 7591 + `/authorize` (with `?auto=1` for headless auto-approval) + `/token` (validates PKCE) + `/mcp` (Bearer-gated). |
| Sub-agent profile discovery + `_bodhi-pi/subagent/list` returns parsed profiles | Integration (`test/subagents-discovery.test.ts`, `test/subagents-list-extmethod.test.ts`) + Agent e2e (`e2e/shared/subagents-list.e2e.ts`) across in-memory/cli/http/ws |
| Sub-agent spawn end-to-end — parent LLM calls `subagent` tool, child runs, returns summary | Integration (`test/subagents-spawn.test.ts`, faux providers for both parent + child) + Agent e2e (`e2e/shared/subagents.e2e.ts`, canonical extractor scenario with real `gpt-4o-mini`) + UI e2e (`e2e-ui/shared/subagents.spec.ts` Playwright across browser/chrome-ext/http/ws) |
| Sub-agent recursion guard rejects spawn at depth > 2 | Integration (`test/subagents-spawn.test.ts`) |
| Sub-agent child filtering — default `session/list` excludes children, `includeSubagentChildren: true` includes them | Integration (`test/sessions-subagent-filter.test.ts`) |

## Adding a new test

The 6-step feature workflow (`packages/bodhi-pi/CLAUDE.md`):

1. Failing **integration test** in `bodhi-pi/test/*.test.ts` (faux provider + in-memory adapters) → make it pass in `src/`.
2. **Agent e2e** in `bodhi-pi/e2e/*.e2e.ts` (real `gpt-4o-mini`).
3. If host-side adapter changes: implement in `test-apps/node-adapters/` + unit tests there.
4. If browser adapter changes: implement in `test-apps/browser/src/ui-lib/` (or chrome-ext extension surface) + tests.
5. **Per-Host e2e** in each `test-apps/{cli,http,browser,chrome-ext}/e2e/`.
6. Update PARITY.md to reflect the new feature across the matrix.

Skipping a step is a regression risk — Node-only or browser-only assumptions creep in fast.

## See also

- [`packages/bodhi-pi/CLAUDE.md`](../../../packages/bodhi-pi/CLAUDE.md) — test conventions + stub strategy (`aimock` vs faux provider) + e2e model selection.
- [`packages/bodhi-pi/PARITY.md`](../../../packages/bodhi-pi/PARITY.md) — per-feature coverage matrix.
- [`packages/bodhi-pi/e2e/CLAUDE.md`](../../../packages/bodhi-pi/e2e/CLAUDE.md) — e2e-specific operational notes.
- [hosts.md](./hosts.md) — what each Host's e2e exercises.
