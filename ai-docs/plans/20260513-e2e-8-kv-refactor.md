# KV → JSON values, `/login` key=value, migrate skipped e2e to aimock

## Context

Three coupled subsystems are blocking the e2e/shared "every test runs under every transport" invariant:

1. **KV is rigid.** `KvStore` stores `{value: string, secret: boolean}` per key. A provider config that wants `api_key + base_url + maybe headers` doesn't fit. Stratifying into `auth/openai/api_key` + `auth/openai/base_url` spreads config; a JSON value per key keeps the unit atomic.
2. **`/login` is positional.** `/login <provider> <api-key>` cannot carry a `base_url`. Adding a second arg cleanly forces a key=value grammar.
3. **Faux-provider e2e are in-memory-only.** `cancel.e2e.ts`'s deterministic throttled-stream test calls `registerFauxProvider`, which only works in-process. cli/http/ws skip it. After Stage A's wire-config support lands, an aimock HTTP fixture can replace faux for these tests, giving us blackbox coverage across all four runtimes.

There is no backward-compat requirement (bodhi-pi-* are PoCs). Clean break, no shims, no data migration.

## Decisions (confirmed with user)

| Topic | Decision |
|---|---|
| Secret marker shape | **Strict**: object node `{ value: string, secret: true }` (sibling keys allowed; not mandatory). Recursive at any depth. `{value:"x"}` alone is NOT a secret. `{value:"x", secret:false}` is allowed and treated as non-secret (mask is no-op). On masked read, replace `value` with `"***"` and keep `secret:true`. |
| Keyless provider auth | Resolver returns sentinel **`"mock"`** when only `base_url` is set and `api_key` is absent. pi-ai's providers stay untouched. Documented in resolver. |
| Phase 0 baseline | Run `just test` during planning; quote summary before ExitPlanMode. |
| bodhi-pi-http `/login` | Refactor to route through `client.addProvider` for single source of truth — http's current direct `extMethod(EXT_KV_SET)` call goes away. |

## Phase 0 baseline

`just test 2>&1 | tee /tmp/kv-baseline.log` was started during planning; at ExitPlanMode time it was still running (bodhi-pi-web Playwright phase reached test 8/29; ws-frontend Playwright suite — the known-flaky one — yet to come). The completed per-step summary will be appended to this plan file before any Phase 1 code change. Pre-existing failures (per prompt: `bodhi-pi-ws-frontend test:e2e` 21/35 fail in a recent run; other Playwright surfaces have known flakes) are NOT in scope. Success criterion across all phases is "no NEW red steps vs. this baseline."

**Baseline summary (captured 2026-05-13; `just test` exit 0):**

```
▶ @bodhiapp/bodhi-pi              — test (unit + integration)   349 passed
▶ @bodhiapp/bodhi-pi              — test:e2e                    99 passed | 10 skipped (109 total, 57 files)
▶ @bodhiapp/bodhi-pi-node         — test                        41 passed
▶ @bodhiapp/bodhi-pi-browser      — test                        42 passed
▶ @bodhiapp/bodhi-pi-cli          — test                        22 passed
▶ @bodhiapp/bodhi-pi-web          — test:e2e (playwright)       29 passed (2.2m)
▶ @bodhiapp/bodhi-pi-chrome-ext   — test:e2e (playwright)       29 passed (2.6m)
▶ @bodhiapp/bodhi-pi-ws-server    — test                        36 passed
▶ bodhi-pi-ws-frontend            — build only (e2e dropped from justfile in c6395b99)
✅ All steps passed.
```

The 10 e2e skips break down as in-memory-only runIf carve-outs:
- `chat.e2e.ts`: 1 skipped × 4 transports = 4
- `system-prompt.e2e.ts`: 1 skipped × 3 (cli/http/ws — in-memory runs)
- `cancel.e2e.ts`: 1 skipped × 3 (cli/http/ws — in-memory runs the faux variant)

**Success criterion: strict no new red.** The prompt's "21/35 red in ws-frontend" was based on an earlier state; commit `00ba2834` (Phase 4 of ws port) removed that surface from `just test` so the gate is now clean-green. Stage B target: reduce the 10 skips by migrating cancel + any other aimock-eligible tests.

## Critical-file map

### KV core
- `packages/bodhi-pi/src/kv/kv-store.ts` — interface (29 lines, fully rewritten).
- `packages/bodhi-pi/src/kv/in-memory-kv-store.ts` — in-process impl.
- `packages/bodhi-pi-node/src/kv/node-kv-store.ts` — file-per-key adapter.
- `packages/bodhi-pi-browser/src/kv/dexie-kv-store.ts` — Dexie adapter (two-table split — see below).

### Agent + client
- `packages/bodhi-pi/src/acp/agent.ts:797-863` — `handleKvSet/Get/List/Remove`.
- `packages/bodhi-pi/src/acp/agent.ts:1235-1243` — `resolveProviderApiKey`. New peer: `resolveProviderBaseUrl`.
- Stream invocation site (search where `Model<Api>` is passed to `pi-ai`) — clone model with overridden `baseUrl` when present.
- `packages/bodhi-pi/src/client/client.ts:234-262` — `addProvider/removeProvider/getProvider/listProviders` (signatures change).
- `packages/bodhi-pi/src/events/types.ts:187-192` — `auth_change` event payload (unchanged shape; trigger semantics noted).

### Slash parser + hosts
- New: `packages/bodhi-pi/src/commands/slash-args.ts` — shared `key="value"`/`key=value` parser with one positional leader. Hosts import and reuse.
- `packages/bodhi-pi-cli/src/repl/commands.ts:476-523` — `/login`, `/logout`, `/logins`.
- `packages/bodhi-pi-cli/src/config.ts:152` — help text.
- `packages/bodhi-pi-web/src/ui/commands.ts` — `/login` handler.
- `packages/bodhi-pi-ws-frontend/src/ui/commands.ts` — `/login` handler.
- `packages/bodhi-pi-http/src/frontend/ui/commands.ts` — refactored to use `client.addProvider`.
- `packages/bodhi-pi-chrome-ext/` — verify whether it shares web's slash module; update accordingly. (No /login handler today per exploration — confirm and skip if absent.)

### Tests
- `packages/bodhi-pi/e2e/shared/kv.e2e.ts` — adapted to JSON shape.
- `packages/bodhi-pi/e2e/shared/cancel.e2e.ts:27-65` — faux variant migrated to aimock in Stage B.
- New: `packages/bodhi-pi/e2e/helpers/aimock-fixture.ts` — `withMockedProvider({...})`.
- Reference pattern: `packages/bodhi-pi/test/chat.test.ts:33-43`.

## Recommended approach: Stage A

One commit per phase. Gate between phases.

### Phase 1 — KV interface + adapters

`packages/bodhi-pi/src/kv/kv-store.ts`:
```ts
export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

export interface KvStore {
  set(key: string, value: JsonValue): Promise<void>;
  get(key: string): Promise<JsonValue | undefined>;          // unmasked, in-process
  list(prefix?: string): Promise<Array<{ key: string; value: JsonValue }>>; // unmasked
  remove(key: string): Promise<void>;
}

export const AUTH_PREFIX = "auth/";

/** Pure recursive masker. Replaces value field with "***" inside any { value: string, secret: true } node. */
export function maskSecrets(v: JsonValue): JsonValue { /* ... */ }
```

Notes:
- The `getWithMeta`/`listWithMeta` split goes away — masking moves to a single pure helper invoked only by the ACP handler. In-process consumers (`resolveProviderApiKey/BaseUrl`) call plain `get`.
- `KvStoreSetOptions.secret` is gone; secret is in-band on the value.

Adapters:
- **in-memory**: `Map<string, JsonValue>`.
- **node**: file-per-key under `<dir>/`; on `set`, `chmod 0o600` if `maskSecrets(value) !== value` (i.e. the value tree contains any secret marker), else `0o644`. Keep atomic temp+rename. JSON.stringify on write, JSON.parse on read.
- **dexie**: collapse the two-table ping-pong into a single `kv` table keyed by `key`, value `{ json }`. (The structural-hint table-split argued in the comment is no longer load-bearing once secrets are per-field — drop it.)

Tests: rewrite each adapter's existing unit test for the new shape. Add tests for `maskSecrets` covering nested objects, arrays containing secret nodes, secret nodes with sibling keys, and the `secret:false` no-op case.

**Gate**: `npm --workspace @bodhiapp/bodhi-pi run test` plus `bodhi-pi-node` and `bodhi-pi-browser` unit tests green.

### Phase 2 — ACP handlers + agent resolver

`agent.ts` handlers (replacing 797-863):

```ts
handleKvSet:    { sessionId?, key, value: JsonValue } → { key }
handleKvGet:    { key } → { key, value: JsonValue | null }   // masked
handleKvList:   { prefix? } → { entries: Array<{ key, value: JsonValue }> }   // masked
handleKvRemove: { sessionId?, key } → { key }
```

Validation: `key` required, non-empty string. `value` required for set, any JSON (validate it parses as JsonValue — strings, numbers, objects, arrays, null). Reject `undefined` / functions / cycles (JSON.stringify guards naturally).

`auth_change` event: same payload (`{type, sessionId, provider, action}`); fire on any set/remove under `AUTH_PREFIX`. Action is `"login"` for set, `"logout"` for remove. No "value changed" granularity — the entire `auth/<provider>` blob is one unit.

Resolver changes (replacing 1235-1243):
```ts
resolveProviderApiKey(provider): string | undefined
  // returns auth/<provider>.api_key.value when present (unmasked)
  // fallback chain: kvStore > config.getApiKey > extensionRunner.resolveProviderKey
  // KEYLESS RULE: if kv has auth/<provider> object with base_url but no api_key, return "mock"
  //   (sentinel — pi-ai still emits Bearer mock; aimock/Ollama/llama.cpp ignore it)

resolveProviderBaseUrl(provider): string | undefined  // NEW
  // reads auth/<provider>.base_url; returns undefined when absent
```

At the stream-invocation site, when `resolveProviderBaseUrl(provider)` returns a value, clone the `Model<Api>` with `baseUrl` overridden before handing it to pi-ai. Locate the single site (search for where `getApiKey` is currently called alongside `model` — same place).

**Gate**: `npm --workspace @bodhiapp/bodhi-pi run test` green.

### Phase 3 — Typed client + slash-args parser

`client.ts:234-262` — new signatures (BREAKING):

```ts
export interface ProviderAuth {
  api_key?: { value: string; secret?: true };
  base_url?: string;
}

addProvider(provider: string, config: ProviderAuth, opts?: { sessionId? }): Promise<void>
removeProvider(provider: string, opts?: { sessionId? }): Promise<void>
getProvider(provider: string): Promise<{ provider: string; config: ProviderAuth | null }>  // masked
listProviders(): Promise<Array<{ provider: string; config: ProviderAuth }>>  // masked
```

`addProvider` payload becomes the full JSON object; if caller passes `{api_key: {value: "sk-..."}}`, the client auto-sets `secret: true` on the api_key node before sending (so callers don't have to remember). `base_url` is plain string.

New `packages/bodhi-pi/src/commands/slash-args.ts`:

```ts
parseSlashArgs(rest: string, opts?: { positionals?: number }): {
  positionals: string[];
  kwargs: Record<string, string>;
}
```

Grammar:
- Tokens separated by whitespace.
- A token without `=` is a positional.
- A token `key=value` is a kwarg (value is a single bareword).
- A token `key="..."` is a kwarg with a quoted value (supports embedded spaces; `\"` escape; no other escapes).
- Single quotes treated the same as double quotes for simplicity.
- Unknown shapes → throw with a usable error message.

Unit tests for the parser live next to it.

`/login` semantics:
- `/login <provider> api_key="sk-..." base_url="http://..."` — both kwargs optional.
- Validation:
  - At least one of `api_key` or `base_url` must be present, **unless** the provider has a known default endpoint that needs no key (e.g. ollama). Provide a small registry in slash-args (or alongside hosts) of keyless-default providers; for now this is just `ollama` → `http://localhost:11434/v1`. If `/login ollama` with no args, fill in `{base_url: "http://localhost:11434/v1"}` client-side.
  - Otherwise emit a usage error.
- Implementation flow per host: parse → assemble `ProviderAuth` → `ctx.client.addProvider(provider, config, {sessionId})`.

**Gate**: `npm --workspace @bodhiapp/bodhi-pi run test` green (including parser tests).

### Phase 4 — bodhi-pi shared e2e adaptation (no aimock yet)

Update `e2e/shared/kv.e2e.ts`:
- Replace string-value set/get/list assertions with JSON-value equivalents.
- New cases:
  - Set provider config object `{api_key: {value: "sk-x", secret: true}, base_url: "http://example.test/v1"}` → list returns `{api_key: {value: "***", secret: true}, base_url: "http://example.test/v1"}`.
  - Nested secret marker at a non-auth path masks the same way.
  - In-memory agent resolves `api_key` unmasked at stream time (in-process assertion via test harness, same pattern the file uses today).
- Keep the existing per-test-key suffix to avoid http sharedKv collisions.

Update any other shared e2e referencing `addProvider`/`/login` arg syntax. **Keep all `runIf(isRuntime("in-memory"))` guards in place — Stage B work.**

**Gate**: `cd packages/bodhi-pi && npm run test:e2e -- --project in-memory` green, then `--project cli`, then `--project http`, then `--project ws`, then full `npm run test:e2e` green across all four with the **same skip count as Phase 0 baseline**. Quote totals.

### Phase 5 — Per-host fixup, one host at a time

Per user's standing instruction (memory: depth-first per runtime; skip-blocked-features pattern): one host at a time, one test file at a time, run between each. Commit per host.

Sequence:
1. **`bodhi-pi-cli`** — update `src/repl/commands.ts:476-523` `/login` to use `parseSlashArgs` + `ProviderAuth`; update `/logout` (signature unchanged but error messages); update `/logins` to print the JSON-shape masked (multiline per provider, indented). Update `src/config.ts:152` help text. Walk `test/*.test.ts` and `e2e/*.e2e.ts`.
2. **`bodhi-pi-web`** — `src/ui/commands.ts`. Walk `e2e/*.spec.ts` Playwright specs.
3. **`bodhi-pi-ws-server`** — no `/login` UI but kv-touching `test/*` files. Walk those.
4. **`bodhi-pi-ws-frontend`** — `src/ui/commands.ts`. Walk `e2e/*.spec.ts`. **Pre-existing 21/35 red is not yours to fix**; only ensure no new regressions.
5. **`bodhi-pi-chrome-ext`** — verify whether it shares web's slash module; update if independent. (Exploration suggests no /login here today.)
6. **`bodhi-pi-http`** — `src/frontend/ui/commands.ts` switched to `client.addProvider(provider, ProviderAuth, {sessionId})` (removes the duplicated direct extMethod path). Walk `test/integration/` and `e2e/`.
7. **`packages/bodhi-pi/e2e/test-app-http` + `test-app-cli`** — server-side wiring compiles against new KV API only.

Commit per host once green. Don't bundle hosts.

### Phase 6 — Stage A baseline-regained checkpoint (HARD GATE)

- `just test` end-to-end; quote per-step pass/fail summary.
- Diff against Phase 0 baseline; no new red steps. Same pre-existing ws-frontend failure count and spec names.
- If new red appears, fix before continuing. **Stage B blocked on this gate.**
- Single commit "Stage A complete: baseline regained" (cleanup tweaks if any).

---

## Recommended approach: Stage B

### Phase 7 — aimock helper + migrate skipped tests

`packages/bodhi-pi/e2e/helpers/aimock-fixture.ts`:

```ts
withMockedProvider({
  provider: "openai",
  model: "gpt-4o-mini",           // override existing entry's baseUrl
  baseModelId?: string,
  onMessage: (req) => MockResponse, // matches LLMock's onMessage shape
  llmockOpts?: { tokensPerSecond?, tokenSize? }
}): Promise<{
  url: string;
  providerConfig: ProviderAuth;   // typically { base_url: url } — keyless; api_key omitted
  cleanup(): Promise<void>;
}>
```

Match `packages/bodhi-pi/test/chat.test.ts:33-43`'s LLMock setup shape exactly. Tests call `harness.client.addProvider(provider, providerConfig, {sessionId})` after `newSession`.

Migrate `e2e/shared/cancel.e2e.ts:27-65`:
- Drop `test.runIf(isRuntime("in-memory"))` from the faux variant.
- Replace `registerFauxProvider` with `withMockedProvider` + `addProvider` over the ACP wire.
- Keep the throttled-stream cancel-timing assertion: aimock's `tokensPerSecond`/`tokenSize` options give us deterministic timing.

Audit other `runIf(isRuntime("in-memory"))` and `test.skip`:
- Migrate where aimock cleanly replaces in-process stubbing.
- Leave genuinely whitebox cases (e.g. `systemPrompt` full override) with a one-line comment "aimock can't reach this — spawn-time wiring".

Add an explicit keyless test: `addProvider("openai", {base_url: aimock.url})` with no `api_key`. Asserts the resolver emits a non-empty Authorization (the `"mock"` sentinel) and the call succeeds against aimock.

**Gate**: `cd packages/bodhi-pi && npm run test:e2e` green across all four runtimes. Migrated tests pass under `cli`/`http`/`ws` (not just `in-memory`). Skip count strictly less than Phase 0 baseline by number of migrated tests. Quote totals.

### Phase 8 — Final `just test` regression gate

- `just test` end-to-end; compare against Phase 0 baseline.
- No new red. Newly passing migrated tests = improvement, not regression.
- Commit "Stage B complete".

## Reused code / patterns

- LLMock shape: `packages/bodhi-pi/test/chat.test.ts:33` (port 0, onMessage regex, getModel).
- Test harness pattern: `packages/bodhi-pi/test/helpers/harness.ts`.
- Per-test key suffix to avoid http sharedKv collisions: existing `kv.e2e.ts:46-49`.
- Stage cadence (one commit per phase): `git log --grep "bodhi-pi e2e ws"` 4-commit sequence.

## Conventions reaffirmed

- **One commit per phase**, ending with the gate it claims to have passed.
- **No backward-compat shims.** No `KvV2Adapter`. No `addProviderLegacy`. Old `secret: boolean` option deleted, not deprecated.
- **No new abstractions beyond task scope.** Three similar slash-handler lines beat a premature host-shared helper module beyond `slash-args.ts`.
- **Blackbox e2e contract.** Aimock fixture boots an HTTP server; tests reach the agent only via ACP `addProvider`. No reaching into spawned process internals.
- **Node, not Bun**, throughout.

## Verification

End-to-end:
- `cd packages/bodhi-pi && npm run test` — adapter + handler + resolver + parser unit tests green.
- `cd packages/bodhi-pi-node && npm run test` — Node KV adapter green (incl. chmod assertion).
- `cd packages/bodhi-pi-browser && npm run test` — Dexie KV adapter green.
- `cd packages/bodhi-pi && npm run test:e2e -- --project in-memory|cli|http|ws` — shared e2e green per runtime.
- `cd packages/bodhi-pi-cli && npm run test:e2e` — cli /login path with key=value args.
- `cd packages/bodhi-pi-web && npx playwright test` — browser /login path (real LLM round-trip).
- `cd packages/bodhi-pi-http && npm run test:integration && npm run test:e2e` — http /login (now routed through `client.addProvider`).
- `just test` — full regression vs. Phase 0 baseline, no new red.

Manual smoke (per host, after each host's commit):
- Start dev server. Run `/login openai api_key="sk-..." base_url="http://localhost:..."`. Verify `/logins` shows masked `api_key` and visible `base_url`. Run `/login ollama` (no args). Verify it stores `base_url=http://localhost:11434/v1`, no api_key, and a chat through that provider succeeds (only meaningful if Ollama is running locally — otherwise just assert the KV state).

## Final outcome (post-execution)

`just test` exit 0 — all steps green.

| Step | Baseline | Final | Delta |
|---|---|---|---|
| bodhi-pi unit | 349 passed | 362 passed | +13 (new tests: slash-args parser, maskSecrets, keyless auth) |
| bodhi-pi e2e | 99 passed / 10 skipped | **102 passed / 7 skipped** | **+3 passing, -3 skipped (cancel migrated to aimock)** |
| bodhi-pi-node | 41 passed | 42 passed | +1 |
| bodhi-pi-browser | 42 passed | 42 passed | unchanged |
| bodhi-pi-cli | 22 passed | 22 passed | unchanged |
| bodhi-pi-web Playwright | 29 passed | 29 passed | unchanged |
| chrome-ext Playwright | 29 passed | 29 passed | unchanged |
| ws-server | 36 passed | 36 passed | unchanged |

Stage B target met: `cancel (aimock)` runs blackbox across cli/http/ws (previously only in-memory). Phase 8 hard gate satisfied.

## Implementation notes (post-execution)

**Decision deviation: ws-frontend + http frontend inline parsers.** The plan's "single source of truth via `client.addProvider`" for bodhi-pi-http frontend turned out to conflict with that host's hard "no `@bodhiapp/bodhi-pi` import" rule (per its CLAUDE.md). Same rule applies to bodhi-pi-ws-frontend. Both hosts received a local inlined copy of `parseLoginArgs` / `formatProviderAuth` (~70 LOC each) instead of routing through the typed client. The shared module in `packages/bodhi-pi/src/commands/slash-args.ts` remains the canonical implementation and is used by cli/web/chrome-ext (via bodhi-pi-browser shared commands.ts).

**Stage A + B were committed together.** Phases 1–3 (KV core + agent + client + parser) landed in one commit because the KvStore type change cascades into the agent and client at compile time — keeping them split would have required temporary backward-compat shims, which the plan explicitly forbids. Phase 7 (aimock + cancel migration) was bundled into the same commit since the cancel test couldn't be made deterministic across runtimes without the base_url override that Phase 2 added.

**baseUrl override applies at session bootstrap, not stream time.** The agent's `_resolveSessionModel` runs `allModels()` once at session bootstrap; the resolved `Model<Api>` is cached in `session.runtime.piAgent.state.model`. Therefore `/login <provider> base_url=...` must happen BEFORE `newSession` for the base_url to take effect on prompts in that session. Mid-session `/login` updates the picker (auth_change → config_option_update) but does NOT re-resolve the session's current model. This matches existing semantics for api_key (which IS re-resolved on every stream via `resolveProviderApiKey`); base_url is bootstrap-time because it lives on the Model object passed into pi-agent-core. Documented in cancel.e2e.ts's aimock variant.

## Out of scope (follow-ups if surfaced)

- Removing `registerFauxProvider` from pi-ai.
- Renaming `/login`.
- Restoring `bodhi-pi-ws-frontend test:e2e` to the justfile.
- Adding new providers to pi-ai's catalog (we override base_url on existing entries).
- Server-side validation rejecting `secret:false` on `auth/*` (the exploration flagged this; it's a hardening not a refactor).
