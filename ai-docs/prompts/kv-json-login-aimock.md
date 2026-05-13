# Kickoff: KV → JSON values, `/login` key=value, migrate skipped e2e to aimock

This is a new chat session. Read this prompt end-to-end, explore the codebase, ask clarifying questions, then propose a plan via `ExitPlanMode`. **Do NOT start implementing until the plan is approved.**

## Goal

Refactor three coupled things so the e2e/shared invariant ("every test runs under every transport") finally holds:

1. **`KvStore` value type changes from `string` → arbitrary JSON.** Secrets are marked per-field using the canonical `{value: "<string>", secret?: true}` shape anywhere it appears in the JSON tree, recursively. The all-or-nothing per-entry `secret` boolean is gone.
2. **`auth/<provider>` becomes a JSON object** carrying both the credential and the connection config:
   ```jsonc
   // KV value at key "auth/openai"
   {
     "api_key": { "value": "sk-...", "secret": true },  // optional
     "base_url": "http://localhost:12345/v1"             // optional
     // future: org_id, project_id, headers, etc. — extensible
   }
   ```
   `api_key` is optional so we can configure auth-free providers (Ollama, llama.cpp, local proxies).
3. **`/login` slash takes key=value args**: `/login <provider> api_key="sk-..." base_url="http://..."` — both args optional, if none provided, for known provider configured with base_url not requiring api key (e.g. ollama for http://localhost:11434/v1)
Then **migrate the in-memory-only faux-provider e2e tests to use `aimock`** (already a workspace dep) so they run blackbox across all four runtimes. Drop the `runIf(isRuntime("in-memory"))` guards.

There is **no backward-compat requirement**. bodhi-pi-* are PoCs — make a clean break; no data migration, no v1/v2 shim.

## Why this matters

- **Today's KV is too rigid.** A provider config that needs `api_key + base_url + maybe headers` doesn't fit `{value: string, secret: boolean}`. Stratifying into `auth/openai/api_key` + `auth/openai/base_url` works but spreads config; JSON keeps the unit atomic.
- **Today's blackbox e2e is broken.** Faux providers require in-process JS-object stubbing → cli/http/ws skip the only deterministic cancel/timing tests. After this change, tests boot a real HTTP `aimock` server and configure the agent via `/login` over the ACP wire — fully blackbox.
- **Provider config over the wire enables future hosts.** A bring-your-own-endpoint UI in bodhi-pi-web, an Ollama-via-extension flow, an MCP tool-server pointing at the local agent — all need this.

## Scope

The work splits into two stages. **Stage A must complete and the baseline must be regained before Stage B begins.** Stage A is committed independently.

**Stage A — Refactor (in scope):**
- KV interface (`packages/bodhi-pi/src/kv/kv-store.ts`) and all three adapter impls (in-memory, Node, browser).
- ACP extension methods `_bodhi-pi/kv/set`, `_bodhi-pi/kv/get`, `_bodhi-pi/kv/list`, `_bodhi-pi/kv/remove` payload shapes.
- Recursive secret-masking on read.
- Agent's auth resolver: `BodhiPiAcpAgent.resolveProviderApiKey` plus a new `resolveProviderBaseUrl`; baseUrl applied to the `Model<Api>` at stream time.
- Typed client: `BodhiPiClient.addProvider` / `removeProvider` / `getProvider` / `listProviders` (`packages/bodhi-pi/src/client/client.ts:234`).
- `/login` and `/logout` and `/logins` slash handlers in **every host** (cli, web, ws-frontend, chrome-ext, http). Same args grammar everywhere.
- Fix downstream PoC test breakage caused by the new shape — one host at a time, one test file at a time.
- Regain the Phase 0 baseline (no new red steps in `just test`).

**Stage B — aimock migration (in scope, started ONLY after Stage A is committed):**
- New e2e helper `withMockedProvider({ provider, model, onMessage, ... })` that boots `LLMock` per test.
- Migrate `cancel.e2e.ts`'s faux-only variant to aimock; drop the `runIf` guard.
- Audit other `runIf(isRuntime("in-memory"))` cases and migrate where aimock cleanly replaces the in-process stub.

Out of scope (call out as follow-ups if encountered):
- Removing `registerFauxProvider` from pi-ai. The unit tests under `packages/bodhi-pi/test/` keep using faux because they're integration-tier, not e2e — that's the right tool for them.
- Renaming `/login`. Only the arg syntax changes.
- Restoring the dropped `bodhi-pi-ws-frontend test:e2e` justfile entry. Playwright surface is deferred sitewide.
- Adding new providers to pi-ai's catalog. We test by overriding `base_url` on existing `Model<Api>` entries.

## Required: capture a baseline before any change

`just test` is currently **failing** on `main` — `bodhi-pi-ws-frontend — test:e2e (playwright)` reported 21/35 failed in a recent run, and other Playwright surfaces have known flakes. Before touching code:

1. Run `just test 2>&1 | tee /tmp/kv-baseline.log`. Capture the exit code and the per-step pass/fail summary.
2. Note which steps were already red. Those failures are *not yours to fix* in this PR — flag them as pre-existing and continue. The success criterion at the end is "no regression vs this baseline," not "everything green."

Quote the baseline summary back in your plan so the user can confirm the starting line before approval.

## Investigation checklist before planning

Walk these and put findings in the plan (not the chat):

1. **Does pi-ai require an `api_key`?** Read `packages/ai/src/providers/openai-completions.ts`, `anthropic.ts`, and the registered provider list. If the `Authorization: Bearer <key>` header is unconditional, document the dummy-key workaround (e.g. `api_key: "mock"` when only `base_url` is set). If a provider supports keyless mode (Ollama, llama.cpp), call that out — agent's resolver should not send a phantom Authorization header.
2. **Where is `model.baseUrl` actually consumed?** Confirm it's `Model<Api>.baseUrl` and not a hardcoded constant inside a provider's stream function. Grep results so far point to `model.baseUrl` reads in `openai-completions.ts:508` and anthropic provider lines 821, 843, 866 — verify the full set.
3. **All `addProvider` / `_bodhi-pi/kv/set` callers** (use `grep -rn`). Each needs updating once the shape changes. Note: at minimum these hosts have a `/login` UI — cli (`bodhi-pi-cli/src/repl/commands.ts:476`), web (`bodhi-pi-web/src/ui/commands.ts`), ws-frontend (`bodhi-pi-ws-frontend/src/ui/commands.ts`), chrome-ext (likely shares web's), http (`bodhi-pi-http/src/frontend/ui/commands.ts`).
4. **Existing aimock usage** in `packages/bodhi-pi/test/chat.test.ts:46` is the reference pattern. Read it once before designing the helper.
5. **What does `kv.list` return today vs. after?** Today `KvStore.listWithMeta()` returns `Array<{key} & {value, secret}>`. After: JSON values per entry, with the same recursive masking applied. Plan the masking pass once and reuse.
6. **Secret marker convention**: the JSON shape `{value: "...", secret: true}` carries the marker IN BAND. Decide explicitly: is `{value: "x"}` (no `secret` key) treated as a non-secret string? Is `{value: "x", secret: false}` allowed? Is the shape recognized anywhere in the tree, or only at known paths? Recommendation: recognize **any object with a string `value` key and a boolean `secret` key as a secret container**; on read with masking, replace `value` with `"***"` and keep `secret: true`. Inner consumers (agent's resolver) read unmasked.

## Phasing

Depth-first, one commit per phase, green-gate between phases. Pattern lifted from the WebSocket-runtime port (see `git log --grep "bodhi-pi e2e ws"` for the cadence).

**Two stages, separated by a hard "baseline regained" checkpoint:**

- **Stage A (Phases 0–6)** changes the KV shape and `/login` syntax, then chases the breakage through every host that touches them. The stage ends when `just test` shows **no new red steps vs. the Phase 0 baseline**. Stage A is committed before Stage B begins.
- **Stage B (Phases 7–8)** introduces the aimock fixture and migrates the in-memory-only skipped tests to run blackbox across all four runtimes. Stage B is a pure test-coverage improvement on top of a refactor that already holds the baseline.

This sequence is deliberate. Stage A is a wide refactor that touches many hosts; mixing aimock work into it would conflate "did the refactor regress anything?" with "did the new helper add coverage correctly?" Two separable signals are easier to triage than one combined one.

---

### Stage A — Refactor: KV → JSON, `/login` key=value, restore baseline

#### Phase 0 — Baseline
Capture and quote `just test` output. No code changes. Single commit if a record file is created, otherwise just note in the plan.

#### Phase 1 — KV interface + adapters
- Rewrite `packages/bodhi-pi/src/kv/kv-store.ts` types: `KvStore.set/get/list` take/return `JsonValue` (define `JsonValue` here or import from a shared type). Drop `KvStoreSetOptions.secret`. The secret marker lives in the value tree.
- Define `MaskedJson` (recursive masker) and `UnmaskedJson` (read-through) helper functions in this file. One pure function, well-tested.
- Update `packages/bodhi-pi/src/sessions/in-memory-session-store.ts` or wherever the in-memory KV lives → JSON-backed.
- Update `packages/bodhi-pi-node/src/kv/node-kv-store.ts` (file-per-key under `<dir>/`) → store JSON.stringify; read with JSON.parse.
- Update `packages/bodhi-pi-browser/src/kv/...` (Dexie-backed; JSON columns or stringified blob).
- Rewrite unit tests for each adapter (one file at a time; run after each).

**Gate**: `npm --workspace @bodhiapp/bodhi-pi run test` and the adapter packages' tests green.

#### Phase 2 — ACP handlers + agent resolver
- `BodhiPiAcpAgent.handleKvSet/Get/List` in `packages/bodhi-pi/src/acp/agent.ts:797–863` updated for JSON shape + recursive masking.
- `resolveProviderApiKey(provider)` reads `auth/<provider>.api_key.value` (may legitimately return `undefined` for keyless providers like Ollama).
- New `resolveProviderBaseUrl(provider)` reads `auth/<provider>.base_url`.
- At stream invocation site (find the single place model is passed to pi-ai), clone the model with the overridden baseUrl when present.
- `auth_change` event payload unchanged (`{type, sessionId, provider, action}`); the *trigger* is now "the entire `auth/<provider>` key changed," not "any key under `auth/`".

**Gate**: `npm --workspace @bodhiapp/bodhi-pi run test` green.

#### Phase 3 — Typed client + slash parser
- `BodhiPiClient.addProvider(provider, config: ProviderAuth, opts?)` where `ProviderAuth = { api_key?: {value, secret?: true}, base_url?: string }`. The wire payload at `_bodhi-pi/kv/set` is the JSON object.
- `removeProvider(provider)` unchanged in shape (still keyed on the provider name).
- `listProviders()` returns the JSON object per entry (masked).
- New shared slash-args parser supporting `key="value with spaces"` and `key=value`, plus a leading positional `<provider>`. Put it in a single place reachable by every host (e.g. `packages/bodhi-pi/src/commands/slash-args.ts`). Hosts import and use it for `/login`.
- Old `/login <provider> <api-key>` is dead; new is `/login <provider> api_key="..." base_url="..."`. **Both args optional** — if both are omitted, this is valid only for a known provider whose default `base_url` does not require an api key (e.g. Ollama at `http://localhost:11434/v1`). Otherwise produce a useful error on misuse.

**Gate**: `npm --workspace @bodhiapp/bodhi-pi run test` green (including any new parser tests).

#### Phase 4 — bodhi-pi shared e2e: shape adaptation only (NO aimock yet)
- Update `e2e/shared/kv.e2e.ts` to exercise the new JSON-value KV shape (set provider config, list, recursive-mask check, agent resolves unmasked at stream time). Run across all four runtimes.
- Update any other shared e2e test that touches `/login` / `addProvider` to use the new arg syntax / `ProviderAuth` shape. Do NOT migrate `runIf(isRuntime("in-memory"))` cases yet — those are Stage B work. Leave the guards in place.
- **Do not write the aimock helper in this phase.** Adding it here would conflate refactor with coverage expansion.

**Gate**:
- `cd packages/bodhi-pi && npm run test:e2e -- --project in-memory` green
- then `--project cli` green
- then `--project http` green
- then `--project ws` green
- then full `npm run test:e2e` green across all four projects with **the same skip count as the Phase 0 baseline** (the in-memory-only carve-outs still apply). Quote the totals.

#### Phase 5 — Per-host fixup, one host at a time, one test file at a time

The `/login` arg-syntax change ripples into every host. Per the user's instruction: **fix one host at a time, one test file at a time, running the fixed file before moving to the next.** Sequence:

1. **`bodhi-pi-cli`** — Update `src/repl/commands.ts:476` (/login parser), `src/repl/commands.ts:493` (/logout), `:509` (/logins display now shows the JSON shape masked), `src/config.ts:152` (help text). Then walk `test/*.test.ts` and `e2e/*.e2e.ts` one file at a time. Run each file with `vitest --run path/to/file` before moving on.
2. **`bodhi-pi-web`** — Update `src/ui/commands.ts`. Walk `e2e/*.spec.ts` one Playwright spec at a time. Run with `npx playwright test path/to/file` per file.
3. **`bodhi-pi-ws-server`** — No `/login` UI here, but kv tests under `test/` need updating. One file at a time.
4. **`bodhi-pi-ws-frontend`** — Update `src/ui/commands.ts`. Walk `e2e/*.spec.ts`. **Note: this suite is currently red on `main` (21/35 pre-existing failures).** Your job is not to fix the pre-existing failures; only ensure your changes don't *add* new failures. If a spec was passing pre-change and red after, it's a regression and must be fixed.
5. **`bodhi-pi-chrome-ext`** — Likely shares slash code with web; update `src/ui/commands.ts` (or the shared module). Walk `e2e/*.spec.ts`.
6. **`bodhi-pi-http`** — Update `src/frontend/ui/commands.ts`. Walk `test/integration/` and `e2e/`.
7. **`packages/bodhi-pi/e2e/test-app-http`** + **`test-app-cli`** — these are e2e hosts, not user-facing; only their server-side wiring needs to compile against the new KV API.

For each host: commit when its file set is green. Don't bundle hosts in one commit.

#### Phase 6 — Stage A baseline-regained checkpoint (HARD GATE)
- Run `just test` end-to-end and quote the per-step pass/fail summary.
- Compare against the Phase 0 baseline. The success criterion is **no new red steps**. The ws-frontend Playwright failures may persist; if they do, they were red before — confirm same count and same spec names.
- If anything new is red, fix it before continuing. **Stage B cannot start until this gate is green.**
- Commit a single explicit "Stage A complete: baseline regained" marker (cleanup tweaks if any).

---

### Stage B — aimock migration: unlock blackbox e2e for skipped tests

#### Phase 7 — aimock helper + migrate skipped tests
- New helper `packages/bodhi-pi/e2e/helpers/aimock-fixture.ts` exposing `withMockedProvider({ provider, model, baseModelId, onMessage })` (or similar — design it small and match `chat.test.ts:33`'s shape).
- It boots `new LLMock({ port: 0 })`, returns `{ url, addProviderConfig: ProviderAuth, cleanup }`. Tests then call `harness.client.addProvider(provider, addProviderConfig)` over the ACP wire after `newSession`.
- Migrate `e2e/shared/cancel.e2e.ts` faux variant to aimock; drop `runIf(isRuntime("in-memory"))`. Adjust the test to register the provider via `addProvider` (i.e. the typed equivalent of `/login`) over the ACP wire instead of harness opts.
- Audit other `runIf(isRuntime("in-memory"))` and `test.skip` cases. Move ones that aimock can handle; leave ones that are genuinely whitebox (e.g. `systemPrompt` full override — that's spawn-time wiring, not transport-reachable). Document each kept skip with a one-line "why aimock can't fix this" comment.
- Optionally add an e2e test that exercises the keyless-provider path: `addProvider("openai", {base_url: aimock.url})` with no `api_key` — confirms the agent's resolver doesn't send a phantom Authorization header.

**Gate**: `cd packages/bodhi-pi && npm run test:e2e` green across all four runtimes, **with the migrated tests now passing under `|cli|`, `|http|`, and `|ws|`** (not just `|in-memory|`). Skip count strictly less than the Phase 0 baseline by the number of newly-migrated tests. Quote the totals.

#### Phase 8 — Final `just test` regression gate
- Run `just test` end-to-end.
- Compare against the Phase 0 baseline. Same rule as Phase 6: no new red steps. Newly-passing tests are improvement, not regression.
- Commit Stage B complete.

## Conventions (non-negotiable)

- **Plan mode first.** Write the plan to `ai-docs/plans/<slug>.md`, then `ExitPlanMode`. Do not edit code until the user approves.
- **One commit per phase.** Each commit ends with the gate it claims to have passed.
- **Read existing CLAUDE.md files** before touching a workspace. They carry conventions (no `pi-tui` in cli, no `@bodhiapp/bodhi-pi-*` imports from e2e/, etc.).
- **Don't add new abstractions** beyond what the task requires. Three similar lines beat a premature helper.
- **Don't write backward-compat shims.** Clean change. No `KvV2Adapter`. No `addProviderLegacy`.
- **Match the e2e harness's blackbox contract.** Tests reach the agent only via ACP. The aimock fixture boots an HTTP server; the test uses `client.addProvider(...)` over the wire. No reaching into spawned process internals.
- **For UI changes in frontend hosts**: start the dev server and verify the new `/login` syntax in browser before reporting done. Manual smoke via claude-in-chrome.
- **bodhi-pi-pi uses Node, not Bun.** `npm run`, never `bun run`.

## End state

**After Stage A:**
- `KvStore` stores arbitrary JSON; per-field secret masking via `{value, secret: true}`.
- `auth/<provider>` = `{api_key?: {value, secret?: true}, base_url?: string, ...}`. Both fields optional; provider may be configured keyless when its `base_url` points at an auth-free endpoint (Ollama etc.).
- `/login openai api_key="sk-..." base_url="http://localhost:1234/v1"` parses both args; both optional.
- Every `/login`-touching host has a green test file walk recorded in its phase commit.
- `just test` shows no regressions vs. the Phase 0 baseline. Skip counts unchanged.

**After Stage B (built on top of Stage A):**
- `cancel (faux)` and any other migrated faux-only tests now run on all four runtimes via aimock, blackbox over ACP.
- `cd packages/bodhi-pi && npm run test:e2e` shows four green project labels with **strictly fewer skips** than the Phase 0 baseline.
- `just test` still shows no regressions vs. the Phase 0 baseline.

## References

- Prior port pattern (one commit per phase): `git log --grep "bodhi-pi e2e ws"` — recent 4-commit sequence.
- aimock reference usage: `packages/bodhi-pi/test/chat.test.ts:46`.
- KV interface today: `packages/bodhi-pi/src/kv/kv-store.ts`.
- Agent KV handlers: `packages/bodhi-pi/src/acp/agent.ts:797–863`.
- Auth resolver: `packages/bodhi-pi/src/acp/agent.ts:1235–1243`.
- Typed client: `packages/bodhi-pi/src/client/client.ts:234–262`.
- Cli `/login`: `packages/bodhi-pi-cli/src/repl/commands.ts:476–520`.
- `auth_change` event: `packages/bodhi-pi/src/events/types.ts:187–192`.

## Workflow

1. Read this prompt + the references above.
2. Capture the baseline `just test` output and quote the summary back.
3. Explore the codebase (`Explore` agents are fine; one targeted, not many).
4. Verify the recommended A1 JSON shape is sound for THIS codebase as it stands today. If a blocker surfaces, justify an alternative.
5. Ask clarifying questions where genuinely ambiguous.
6. Write the plan to `ai-docs/plans/<slug>.md` and call `ExitPlanMode`.
7. Implement phase-by-phase with green gates between phases.
