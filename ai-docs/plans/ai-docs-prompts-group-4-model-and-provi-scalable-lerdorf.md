# Phase J — Remove early-PoC model/provider scaffolding; align with coding-agent

## Context

bodhi-pi grew up with PoC scaffolding to bootstrap demos: every host reads `*_API_KEY` env vars at startup, every host bakes a model list at that same instant. Phase I added `KvStore` + `/login <provider> <api-key>`, but the model **picker** wasn't rewired — it stays frozen on the boot-time env-derived list, so `/login` writes the key but the new provider's models never appear. Worse, browser hosts (`bodhi-pi-web`, `bodhi-pi-chrome-ext`) inline `VITE_*_API_KEY` at compile-time → any production deploy of static HTML+JS leaks keys.

Concrete observation that prompted this: a user sets two `*_API_KEY` env vars but sees three models. The cause is host-specific (cli filters pi-ai's catalog by env-presence so one Anthropic key surfaces multiple Anthropic models; http+ws-server hardcode one model per provider; web shows OpenAI models regardless of whether the key is set). The fix is to remove the env-var scaffolding entirely from production code and align all hosts on coding-agent's pattern: **build the model list from pi-ai's built-in catalog, filtered by stored auth (`KvStore`)**. Tests load real keys from `.env.test`, drive `/login <provider> <key>` over ACP, and run blackbox.

Outcome: zero env-var reads in production code; `/login` is the only way to authenticate; the model picker reflects stored auth dynamically; test setup uses `.env.test` + ACP `_bodhi-pi/kv/set` (or the `/login` slash) to seed auth before every spec.

## Architecture decisions (locked, user-confirmed)

1. **Browser hosts read zero env vars.** No `VITE_*_API_KEY`, no `PROVIDER_KEY_MAP`. The `apiKeys` payload on `InitMessage` is removed. `getApiKey: () => undefined`. Only kvStore.
2. **bodhi-pi-cli drops `dotenv` entirely.** No `.env` loading. Only kvStore + `--api-key <provider>=<key>` runtime override (lost on restart). No migration helper.
3. **bodhi-pi-http + bodhi-pi-ws-server drop env-var key reading.** Production code never reads `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` etc. Keeps PoC consistency: tests load keys from `.env.test` and call `/login` to populate the server's kvStore.
4. **Model registry moves into the agent core**, sourced from pi-ai's built-in catalog filtered by stored auth. Hosts can still pass `BodhiPiConfig.models` as **additive** entries (for non-pi-ai providers like local Ollama). `defaultModelId` becomes optional; if absent or unavailable, the first auth-available model wins.
5. **Tests are blackbox.** Per-package `e2e/global-setup.ts` validates `.env.test`. Each test/test-suite drives `/login <provider> <key>` over ACP **before sending any prompt**. No `getApiKey: () => "test-key"` silent fallback. Faux-provider unit tests get `getApiKey: () => undefined`.
6. **First-run UX**: an empty model picker is the correct state until `/login` runs. CLI prints "no providers configured — run `/login <provider> <key>`". Browser hosts show the empty state with the same hint via the existing system message channel.

## In scope / out of scope

In scope:
- Remove env-var API-key reading from every production code path (5 hosts + the shared `bodhi-pi-browser` env helper).
- Move the model registry derivation into `BodhiPiAcpAgent` (pi-ai catalog ∪ host-additive ∪ extension-provided, filtered by `resolveProviderApiKey`).
- Make `BodhiPiConfig.models` and `defaultModelId` optional. Re-validate via the resolver, not against a static list.
- Wire `/login` and `/logout` to re-derive the model picker (advertise updated `configOptions` via `sessionUpdate` or surface fresh on next read).
- Clean up `.env` / `.env.example` files: remove key entries from `.env.example`, delete `.env` files (they should never be committed), ensure `.env` and `.env.test` are gitignored.
- Per-package `e2e/global-setup.ts` validates required keys from `.env.test`; tests call `_bodhi-pi/kv/set auth/<provider>` (or the `/login` slash) in `beforeAll` / `beforeEach`.
- Remove `"test-key"` fallback in `createTestHarness` and equivalent helpers.

Out of scope (deferred):
- OAuth (still Phase I deferred).
- `models.json` user-editable catalog file (pi-ai catalog covers the simple case; `models.json` lands with OAuth).
- Server-side env-var fallback for ops convenience — explicitly rejected by user direction; the consistent rule is "no env for keys in production code."

## Sub-features (depth-first per runtime)

### J1 — Dynamic model registry in `BodhiPiAcpAgent`

**Why:** today's `allModels()` is `host-config + extension-provided`. Switch to `pi-ai catalog (filtered by auth) + host-additive + extension-provided`. This is the coding-agent pattern, ported.

Files to modify:
- `packages/bodhi-pi/src/acp/agent.ts:100-123` — `BodhiPiConfig`: make `models?: Model<Api>[]` optional (default `[]`); make `defaultModelId?: string` optional.
- `packages/bodhi-pi/src/acp/agent.ts:225-232` — drop the throw-when-defaultModelId-not-in-models check. The new validator just trims the requested `defaultModelId` to one of the currently auth-available models (or `null` if none).
- `packages/bodhi-pi/src/acp/agent.ts:1173-1184` — rewrite `allModels()` async. Use pi-ai's `getProviders()` + `getModels(provider)` for every provider with a successful `resolveProviderApiKey(provider) !== undefined`. Merge with `config.models ?? []` (host-additive; deduped by id) and extension models.
- `packages/bodhi-pi/src/acp/agent.ts:1185-1218` — `buildModelConfigOption` becomes async; callers (`newSession`/`loadSession`/`resumeSession`/`setSessionConfigOption`) await it. Compute via `allModels()` each call so `/login` is immediately visible.
- `packages/bodhi-pi/src/acp/agent.ts` `setSessionConfigOption` for `MODEL_CONFIG_ID`: validate `value` is in the now-dynamic available set; if not, throw `-32602` with "model not available — provider auth missing".
- Add a private helper `_pickDefaultModelId(): string | null` for sessions whose stored model id is no longer auth-available. Falls back to the first available, then `null` (empty picker).
- New ACP behavior: after `_bodhi-pi/kv/set auth/<provider>` and `_bodhi-pi/kv/remove auth/<provider>`, push an updated `configOptions` snapshot via a `sessionUpdate` of kind `available_commands_update`'s sibling — actually, the cleanest path is to extend the kv handlers to fire a per-session refresh and emit a new `_bodhi-pi/session/config_options/changed` extNotification (see test design below). **Decision**: keep wire-shape simple — make the next call to `setSessionConfigOption`/`session/load`/`_bodhi-pi/session/config` see the freshly-computed list. Tests verify by reading `_bodhi-pi/session/config` after `/login`.

Test (write first): extend `packages/bodhi-pi/test/kv-slash.test.ts` and `packages/bodhi-pi/test/session-config-ext.test.ts`:
- Before `/login`: `_bodhi-pi/session/config` reports no openai models.
- After `/login openai sk-XYZ` (via `_bodhi-pi/kv/set auth/openai`): `_bodhi-pi/session/config` reports pi-ai's openai catalog models.
- `BodhiPiConfig.models` (host-additive) still appears regardless of kvStore (proves it's additive, not replaced).
- `defaultModelId` unset + no keys: `_bodhi-pi/session/config.currentModelId === null`; sending a prompt errors cleanly with "no model — run /login".
- `/logout openai` removes those models; if it was the current model, the agent picks the next available.

Risks: making `allModels()` async ripples into `buildModelConfigOption`, `newSession`, `loadSession`, `resumeSession`, `setSessionConfigOption`. Most are already async; the change is mechanical.

### J2 — Remove env-var key reading from browser hosts

Files to modify:
- `packages/bodhi-pi-browser/src/env/env.ts` — delete `PROVIDER_KEY_MAP`, delete `apiKeys` derivation, delete the conditional Anthropic model registration. `buildResolvedEnv` now returns just the static host-additive model list (which should also drop the literal `gpt-4o-mini`/`gpt-4o` since they'll come from pi-ai catalog + auth filter). Likely shrinks to `{ models: [], defaultModelId: undefined }`. Then evaluate whether `buildResolvedEnv` should exist at all.
- `packages/bodhi-pi-browser/src/runtime/runtime.ts:55-65` — drop `apiKeys` from `InitMessage`. Drop `defaultModelId` from `InitMessage` if it's universally undefined. Drop `models` if always empty.
- `packages/bodhi-pi-browser/src/runtime/types.ts` — narrow `InitMessage` shape.
- `packages/bodhi-pi-browser/src/runtime/bootstrap-worker.ts:123-137` — drop `getApiKey: (provider) => apiKeys[provider]`; replace with `getApiKey: () => undefined`. Drop the `models`/`defaultModelId` props (or pass `models: []`).
- `packages/bodhi-pi-web/src/env.ts` and `packages/bodhi-pi-chrome-ext/src/env.ts` — delete entirely if `buildResolvedEnv` collapses, otherwise simplify to a stub.
- `packages/bodhi-pi-web/.env.example` and `packages/bodhi-pi-chrome-ext/.env.example` — remove API-key entries. If no entries remain, delete the file.
- `packages/bodhi-pi-web/.env` and `packages/bodhi-pi-chrome-ext/.env` — delete (these should not be in the repo at all; verify `.gitignore`).

Host UX: web's home screen and chrome-ext's home screen show "no providers configured — type `/login <provider> <key>`" as a system message until the user logs in. Both already have a system-message channel.

Test: `packages/bodhi-pi-web/e2e/login-flow.spec.ts` — fresh tab → no models → `/login openai $KEY` (from `.env.test`) → openai models visible → prompt → success.

### J3 — Remove env-var key reading from `bodhi-pi-cli`

Files to modify:
- `packages/bodhi-pi-cli/src/cli.ts` — drop `loadEnv()` from `dotenv`. Drop `dotenv` from `package.json` dependencies.
- `packages/bodhi-pi-cli/src/config.ts:52-58` — drop `allModels = getProviders()...filter(... !!getApiKey)`. The host no longer derives a model list — pass `models: undefined` to `createCliAgent`/`createBodhiPiAgent`.
- `packages/bodhi-pi-cli/src/config.ts` `getApiKey` — set to `() => undefined`. Add a new CLI flag parser for `--api-key <provider>=<key>` (repeatable; runtime-only, applied via in-memory kvStore overlay or written to kvStore for the session).
- `packages/bodhi-pi-cli/src/agent.ts:32-65` — `createCliAgent` no longer requires `models` or `defaultModelId`. `getApiKey` defaults to `() => undefined`. The agent's dynamic registry takes over.
- `packages/bodhi-pi-cli/.env` and `packages/bodhi-pi-cli/.env.example` — clean: remove all `*_API_KEY` entries. `.env.example` can keep `BODHI_MODEL` if desired.
- README/DEVELOPMENT.md — update to instruct `bodhi-pi-cli; /login <provider> <key>` flow.

Risks: existing users with `~/.env` will see empty model lists. Acceptable per the user's "no migration helper" decision.

Test: `packages/bodhi-pi-cli/test/agent.test.ts` and `e2e/repl.e2e.ts` — switch to populating kvStore via `extMethod(EXT_KV_SET, ...)` before sending any prompt.

### J4 — Remove env-var key reading from `bodhi-pi-http` + `bodhi-pi-ws-server`

Files to modify:
- `packages/bodhi-pi-http/src/server/models.ts` — delete `resolveModelsFromEnv` entirely. Replace with: `resolveModelsFromConfig(): { models: undefined, defaultModelId: undefined }` (just a stub returning empty, since the agent core derives dynamically). The server no longer reads `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`.
- `packages/bodhi-pi-http/src/server/index.ts:7` — drop `loadEnv()` from `dotenv`. Drop `dotenv` from deps (verify nothing else uses it).
- `packages/bodhi-pi-http/src/server/agent/wire-agent.ts` — `WireAgentOptions.models`/`defaultModelId` become optional / unused; pass `getApiKey: () => undefined`. kvStore (per-user dir already shipped in Phase I) is the only auth path.
- `packages/bodhi-pi-http/.env` and `.env.example` — clean (remove API keys; keep PORT etc.).
- `packages/bodhi-pi-ws-server/src/models.ts` — same as http. Delete.
- `packages/bodhi-pi-ws-server/src/index.ts:7` + `package.json` — drop `dotenv`.
- `packages/bodhi-pi-ws-server/src/agent/wire-agent.ts` — same as http.
- `packages/bodhi-pi-ws-server/.env` + `.env.example` — clean.

Test: integration tests in `packages/bodhi-pi-http/test/integration/` and `packages/bodhi-pi-ws-server/test/` — use faux providers (no key needed) or call `_bodhi-pi/kv/set` first.

### J5 — Test setup: `.env.test` + global-setup + blackbox `/login`

Goal: tests are the only place real keys ever appear. Each test that needs a real LLM:
1. Validates the required key in `e2e/global-setup.ts` (`requireEnv("OPENAI_API_KEY")` etc. — fail fast).
2. In `beforeAll`/`beforeEach` for that suite, calls `clientConn.extMethod(EXT_KV_SET, { key: "auth/openai", value: process.env.OPENAI_API_KEY, secret: true })` against the agent. No whitebox — purely through ACP.
3. Optionally validates the model picker reflects the new auth via `_bodhi-pi/session/config` before sending a prompt.

Files to add/modify:
- `packages/bodhi-pi/test/helpers/env.ts` already exists with `requireEnv`. Keep.
- `packages/bodhi-pi/e2e/global-setup.ts` — new file, mirror of `bodhi-pi-cli/e2e/global-setup.ts`. Validates all required keys for the suite.
- `packages/bodhi-pi-cli/e2e/global-setup.ts` — already exists; refactor to use `requireEnv`.
- `packages/bodhi-pi-http/e2e/playwright/global-setup.ts` — exists; refactor.
- `packages/bodhi-pi-ws-frontend/e2e/global-setup.ts` — exists; refactor.
- `packages/bodhi-pi-web/e2e/global-setup.ts` — new file. Validates env, then in fixtures pre-seeds kvStore via the page's slash dispatcher.
- `packages/bodhi-pi-chrome-ext/e2e/global-setup.ts` — new file. Same.
- `packages/bodhi-pi/test/helpers/harness.ts:53` — drop `?? (() => "test-key")` fallback. `getApiKey` now defaults to `() => undefined` (faux providers don't care about real keys).
- `packages/bodhi-pi-http/test/helpers/test-server.ts:74` — same.
- `packages/bodhi-pi-ws-server/test/helpers/test-server.ts:30` — same.
- All `.env.test.example` files — list each required key, one per line, with empty value placeholders.
- All `.env.test` files — ensure gitignored. Verify `bodhi-pi-cli/e2e/.env.test` is NOT committed (remove from git history if it is via `git rm --cached` + add to .gitignore).

For real-LLM e2e specs that today drive faux providers:
- `bodhi-pi/e2e/chat.e2e.ts` and friends — add a `beforeAll` that calls `EXT_KV_SET` for each provider being tested. Drop the explicit `getApiKey` closure in spec bodies.
- `bodhi-pi-cli/e2e/*.e2e.ts` — same pattern, via `clientConn.extMethod(EXT_KV_SET, ...)` in `beforeAll`.
- `bodhi-pi-web/e2e/*.spec.ts` — type `/login openai sk-...` into the composer in `beforeEach`, or use the `EXT_KV_SET` route via the Playwright runtime fixture. The user explicitly said "configure server for the given keys via the UI, no whitebox" — so for the **browser hosts specifically**, drive the `/login` slash through the composer.

For faux-provider unit/integration tests: faux doesn't need a real key. `getApiKey: () => undefined` is fine. Faux provider records `options.apiKey === undefined` in tests that assert on it (rare; affects only the kv-store flow test which already asserts `"sk-XYZ"`).

### J6 — Clean up scaffolding files + verify gitignore

Files to delete:
- `packages/bodhi-pi-web/.env`
- `packages/bodhi-pi-chrome-ext/.env`
- `packages/bodhi-pi-cli/.env`
- `packages/bodhi-pi-http/.env`
- `packages/bodhi-pi-ws-server/.env`

Files to scrub (remove `*_API_KEY` entries; keep non-secret config like PORT, BODHI_MODEL):
- All `.env.example` files in those packages.
- `packages/bodhi-pi/.env.example` — verify (might be legitimately empty now).

Root `.gitignore` audit: ensure `**/.env` and `**/.env.test` are ignored package-wide.

Verify no leftover env-key checks in production code via:
```
grep -rn "process\.env\..*_API_KEY\|VITE_.*_API_KEY\|import\.meta\.env\..*_API_KEY" \
  packages/bodhi-pi*/src/ packages/bodhi-pi/src/ \
  | grep -v test | grep -v e2e
```
Should return zero matches at the end of J6.

### J7 — PARITY.md update + final commit

- Move the deferred "Dynamic model registry" row to Shipped (with caveat: pi-ai catalog only, no `models.json` yet, no OAuth `modifyModels`).
- Document the new "no production env-var reading" rule.
- Update the "Stale model list on `/login`" note (now resolved).
- Commit: `feat(bodhi-pi): remove env-var scaffolding; align with coding-agent (Phase J)`.

## Cross-cutting

**Surface that survives the cleanup:**
- `BodhiPiConfig.kvStore` (Phase I).
- `BodhiPiConfig.getApiKey` callback — keep but it's typically `() => undefined`. Useful for niche cases (test-only overrides, programmatic embedding).
- `BodhiPiConfig.models` — additive only, for non-pi-ai providers (Ollama, custom).
- `BodhiPiConfig.defaultModelId` — optional override; agent picks best-available when unset.
- `--api-key <provider>=<key>` CLI flag — runtime override (writes to a per-process in-memory layer that wins over kvStore for that run). Optional; can defer if scope is tight.

**Surface that disappears:**
- All `VITE_*_API_KEY` env var references in browser hosts.
- All `OPENAI_API_KEY`/`ANTHROPIC_API_KEY`/`GEMINI_API_KEY`/`OPENROUTER_API_KEY` reads in production code.
- `dotenv` import from production entry points (cli.ts, server/index.ts).
- `resolveModelsFromEnv()` in http + ws-server.
- `buildResolvedEnv`'s API-key half (env helper stays for non-secret config if any).
- `apiKeys` field on browser `InitMessage`.
- `"test-key"` silent fallback in test harnesses.
- `BodhiPiConfig.models` as **required**; becomes optional.

**Test infrastructure pattern (final):**
```ts
// packages/<host>/e2e/global-setup.ts
import "dotenv/config";  // ONLY in test setup
import { requireEnv } from "@bodhiapp/bodhi-pi/test/helpers/env"; // or local copy
export default async function () {
  requireEnv("OPENAI_API_KEY"); // throws if missing in .env.test
}

// in a spec
beforeAll(async () => {
  await clientConn.extMethod("_bodhi-pi/kv/set", {
    key: "auth/openai",
    value: process.env.OPENAI_API_KEY,
    secret: true,
  });
});
```

For browser hosts: `dotenv` loads `.env.test` in the Playwright config / global setup, the test reads `process.env.OPENAI_API_KEY`, and the spec types `/login openai $KEY` into the composer.

## Risks to revisit mid-phase

1. **J1 async refactor depth**: `buildModelConfigOption` → async ripples to `newSession`/`loadSession`/`resumeSession`/`setSessionConfigOption`. All are already `async`; mechanical.
2. **`defaultModelId` becoming optional** breaks `findModel(this.config.defaultModelId)` callers; replace with `_pickDefaultModelId()` helper.
3. **Real-LLM e2e becoming brittle**: every spec now starts from "empty kvStore → seed via ACP → prompt". Increases setup time slightly. Acceptable.
4. **Browser hosts first-run UX**: empty model picker may surprise users. Add a clear system message + docs.
5. **CLI `--api-key` flag**: may or may not ship this phase. If complex, drop it — kvStore + `/login` is enough.

## Verification end-to-end

After Phase J lands:

1. **No env-var leak in browser bundles**: `npm run build` in `bodhi-pi-web`; `grep -r '_API_KEY' dist/` returns zero hits.
2. **Fresh CLI install**: `node packages/bodhi-pi-cli/dist/cli.js` with no `.env` anywhere → starts, shows "no providers configured", `/login openai sk-...` → next prompt succeeds.
3. **Two keys, three models behavior is now consistent**: `/login anthropic $KEY` → `_bodhi-pi/session/config` shows all anthropic models from pi-ai catalog (matches what cli already does). Adding `/login openai $KEY` adds the openai catalog. Number of models = sum across pi-ai's per-provider catalog for the providers with stored auth. cli and servers agree.
4. **`/logout` shrinks the picker**: dynamic both directions.
5. **All tests green**: `just test` at repo root.
6. **`grep -rn "process\.env\..*_API_KEY\|VITE_.*_API_KEY" packages/*/src` returns zero matches** (production code).
7. **`.env.test` paths read correctly** from `e2e/global-setup.ts`; specs no longer have `process.env.X!` top-level bare reads.
8. **`packages/coding-agent`-equivalent flow**: `/login <provider> <key>` → model registry expands → can immediately switch to a new model via `/settings set model <id> --session` (or the ACP `setSessionConfigOption`).

## Critical files

- `packages/bodhi-pi/src/acp/agent.ts` — biggest changes (`allModels` async, `BodhiPiConfig.models` optional, registry move).
- `packages/bodhi-pi-browser/src/env/env.ts` — strip API-key logic; possibly delete file.
- `packages/bodhi-pi-browser/src/runtime/runtime.ts` + `bootstrap-worker.ts` + `types.ts` — drop `apiKeys` from InitMessage.
- `packages/bodhi-pi-web/src/env.ts` + `packages/bodhi-pi-chrome-ext/src/env.ts` — delete or stub.
- `packages/bodhi-pi-cli/src/config.ts` + `cli.ts` + `agent.ts` — drop dotenv + env-derived models.
- `packages/bodhi-pi-http/src/server/models.ts` + `index.ts` — delete env-based registry; drop dotenv.
- `packages/bodhi-pi-ws-server/src/models.ts` + `index.ts` — same.
- `packages/bodhi-pi/test/helpers/harness.ts` — drop `"test-key"` fallback.
- Every package's `e2e/global-setup.ts` + `.env.test.example` — consolidate to one pattern.
- `packages/bodhi-pi/PARITY.md` — move dynamic-registry row to Shipped.

## Single commit

`feat(bodhi-pi): remove env-var scaffolding; align with coding-agent (Phase J)`

Body documents:
- The six sub-features above.
- The shift from "host-supplied static models + env keys" to "agent-derived from pi-ai catalog + kvStore".
- Why production code now reads zero env vars.
- The test pattern: `.env.test` + global-setup + blackbox `/login`.
- Deferred rows: OAuth, `models.json`, `--api-key` CLI flag (optional drop if scope is tight).
