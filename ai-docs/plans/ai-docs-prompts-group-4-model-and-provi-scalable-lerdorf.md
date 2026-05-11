# Phase I — Model & Provider Management (scoped after user decisions)

## Context

bodhi-pi's `BodhiPiConfig` today is a host-supplied, static, opaque blob: `models[]` is fixed at boot, `getApiKey(provider)` is a host callback with no persistence, and `setSessionConfigOption` only knows about `MODEL_CONFIG_ID`. Phase 0 (commit `2030e957`) landed `prepareNextTurn`, but only wired it for compaction; the `{ context?, model?, thinkingLevel? }` return shape sits unused for the model/thinking branches. Phase G (commit `7e87c9e6`) added a per-project `.bodhi-pi/settings.json` but no user-level layer and no slash to read or mutate it at runtime.

Phase I closes the gap: a layered settings system (global + project + ACP-session), a generic host-injected `KvStore` (used by API-key storage and any future per-host KV need), thinking-level support advertised through ACP, per-provider retry/timeout, a generic `/settings get|set|unset|list|cycle` slash, and `/login`/`/logout` for API keys. OAuth, dynamic model registry, and the scoped-models cycle are deferred — they share a single follow-up phase because OAuth's `modifyModels` callback is the registry's primary motivator.

The intended outcome: a user can set a thinking level (per session via ACP, or persistently via `/settings set thinking high --global`), see it reflected on the next turn, paste a new API key with `/login openai` and have it persist across restarts, configure retry/timeout per provider in a settings file, and observe the resolved layered view through `/settings list`. Five hosts (cli, browser-shared web+chrome-ext, ws-frontend, http) ship parity.

## Architecture decisions (locked, user-confirmed)

1. **KvStore is generic with a `secret: boolean` marker.** Auth uses the prefix `auth/<provider>`. Hosts decide what `secret` means at storage time (Node: 0o600 file perms; browser: separate Dexie table). No encryption this phase. **ACP read surfaces mask secret values to `***`**; internal in-process reads (e.g. API-key resolution inside the agent) are unmasked.
2. **Slashes are flat and complete — no prompts, no popups, no host-side UI.** All arguments inline (`/login <provider> <api-key>`, not `/login <provider>` with a key prompt). Translates directly to ACP extension methods. **No per-property convenience slashes** (no `/thinking`, no `/model`, no `/retry`). **No cycle slash** (`/settings cycle` removed) — host UI is responsible for cycle UX via keybindings.
3. **Settings persistence is ACP-pure.** `setSessionConfigOption` and `/settings set ... --session` are session-only. Persistence requires explicit `--global` or `--project`. Default scope for `/settings set` with no flag is `--session`. `--session` is also accepted explicitly. Mirrors `git config --local|--global`.
4. **Global settings layer (`~/.bodhi-pi/settings.json`) is Node-only by design.** Browser/chrome-ext/ws-frontend runtimes have no `~`. `--global` on a host without `homeDir` returns `RequestError -32602` with message `"--global scope not supported on this runtime; use --project or --session"`. The slash itself exists everywhere; only certain scopes work per runtime.
5. **Thinking is advertised via ACP `SessionConfigSelect`.** A second `configOptions` entry (alongside model). Options filtered by `getSupportedThinkingLevels(model)`; the option is **omitted entirely** if the model has no thinking support. Fixes the existing bug where `setSessionConfigOption` returned only the changed option (ACP requires the full list).
6. **`/login`/`/logout`/`/logins` are flat sugar over `_bodhi-pi/kv/*` extension methods.** No core-side prompting. `_bodhi-pi/kv/set` takes value at call-time; `_bodhi-pi/kv/get` and `_bodhi-pi/kv/list` mask `secret:true` entries to `***`. Settings files (`~/.bodhi-pi/settings.json`, `.bodhi-pi/settings.json`) never carry secret markers — they're plain JSON for config only; all secrets live in KvStore.
7. **OAuth, dynamic registry, scoped-models cycle: deferred** to a follow-up phase. Phase I retains static model registry from `BodhiPiConfig.models`.

## In scope / out of scope

In scope (matches §3.3 of `ai-docs/parity-post-extension.md` minus the OAuth-dependent items):
- Layered settings (global + project + session), with merge precedence: defaults < global `~/.bodhi-pi/settings.json` < project `.bodhi-pi/settings.json` < session `setSessionConfigOption` / `--session` writes.
- Thinking levels per session, advertised + filtered + clamped, wired through `prepareNextTurn`.
- Per-provider retry/timeout configurable via settings file.
- Generic host-injected `KvStore` interface with secret hint; Node + browser + chrome-ext adapters.
- Generic `/settings get|set|unset|list` slash + `/login <provider> <api-key>` + `/logout <provider>` + `/logins` in all five hosts.
- Bug fix: `setSessionConfigOption` returns full `configOptions[]` array.

Out of scope (deferred; PARITY.md ⏭ rows added in F6):
- OAuth login flow (Anthropic Claude.ai et al.) and OAuth token refresh.
- Dynamic model registry (`models.json`, `modelOverrides`, OAuth `modifyModels`).
- Scoped-models cycle.
- Cross-provider mid-session retry/timeout mutation (static-per-session is enough for now).
- Browser encrypted-at-rest secret storage (table segregation only).

## Sub-features (depth-first per runtime, TDD)

### F1 — Layered settings (global file + merge)

**Why:** Phase G's project layer is half the story; a thinking-level default or per-provider retry config needs a user-level layer too. ACP has no global-config method, so the layered merge lives in core and surfaces via the existing `_bodhi-pi/session/config` extension method.

Files to add:
- `packages/bodhi-pi/src/core/settings-global.ts` — `loadGlobalSettings(fs, homeDir)` mirroring `loadProjectSettings` but at `${homeDir}/.bodhi-pi/settings.json`.
- `packages/bodhi-pi/src/core/settings-merge.ts` — `mergeSettings(base, overrides)`, ported from `packages/coding-agent/src/core/settings-manager.ts:116-144` (shallow-recursive: nested objects merge one level deep, then primitives win, `undefined` inherits).

Files to modify:
- `packages/bodhi-pi/src/core/settings.ts:7-12` — extend `BodhiPiProjectSettings` with `defaultThinkingLevel?: ModelThinkingLevel`, `providerOptions?: Record<string, ProviderOptionsEntry>`, `retry?: { maxRetries?, baseDelayMs?, maxDelayMs? }`. Export `ProviderOptionsEntry = { maxRetries?, timeoutMs?, maxRetryDelayMs? }`.
- `packages/bodhi-pi/src/acp/agent.ts:100-123` — add `homeDir?: string` to `BodhiPiConfig`.
- `packages/bodhi-pi/src/acp/agent.ts` `_buildSessionState` (~line 1237) — load global if `config.homeDir` set, then `merged = mergeSettings(global, project)`. Thread `merged` everywhere `projectSettings.settings` is read today (compaction precedence ~1256-1260; appendSystemPrompt ~1245). Store both raw layers + `merged` + `parseError` flags on `SessionState` for introspection.
- `EXT_SESSION_CONFIG` handler — return per-layer `layers: { defaults, global, project, sessionOverrides, effective }` map.
- `packages/bodhi-pi/src/index.ts` — re-export `mergeSettings`, `loadGlobalSettings`, `ProviderOptionsEntry`.

Test (write first): extend `packages/bodhi-pi/test/settings.test.ts`:
- `layered settings: project overrides global`
- `layered settings: global only when project absent`
- `layered settings: parse error in global is non-fatal` (surfaced via `_bodhi-pi/session/config.globalSettingsParseError`)

Host rollout: no host UI change yet. `packages/bodhi-pi-cli/src/agent.ts` passes `homeDir = os.homedir()` to `createBodhiPiAgent`. Browser/ws/http hosts omit `homeDir` for Phase I; document that the global layer is Node-only.

Verification: `_bodhi-pi/session/config` returns the per-layer breakdown; later `/settings list --effective` (F5) reads through it.

Risk: browser hosts can't host the global layer naturally. Decision: keep `homeDir` optional; absent = no global layer; PARITY.md notes this.

### F2 — `KvStore` interface + Node + Browser adapters

**Why:** API-key persistence cleanly, plus a primitive for any future host-side KV need. Mirrors `SessionStore` injection.

Files to add (core):
- `packages/bodhi-pi/src/kv/kv-store.ts`:
  ```ts
  export interface KvStoreSetOptions { secret?: boolean }
  export interface KvStoreEntry { value: string; secret: boolean }
  export interface KvStore {
    // Internal in-process reads (UNMASKED). Used by API-key resolution.
    get(key: string): Promise<string | undefined>;
    list(prefix?: string): Promise<string[]>;
    // ACP-facing reads (carry the secret flag so the agent can MASK before responding).
    getWithMeta(key: string): Promise<KvStoreEntry | undefined>;
    listWithMeta(prefix?: string): Promise<Array<{ key: string } & KvStoreEntry>>;
    // Writes
    set(key: string, value: string, opts?: KvStoreSetOptions): Promise<void>;
    remove(key: string): Promise<void>;
  }
  export const AUTH_PREFIX = "auth/";
  ```
  The split between `get/list` (unmasked, internal) and `getWithMeta/listWithMeta` (carries secret flag for ACP masking) keeps the masking decision a core-side concern, not host-side. F5's `_bodhi-pi/kv/get`/`_bodhi-pi/kv/list` handlers use the `*WithMeta` variants and substitute `"***"` for secret values before responding.
- `packages/bodhi-pi/src/kv/in-memory-kv-store.ts` — `createInMemoryKvStore()` test helper.

Files to modify (core):
- `packages/bodhi-pi/src/acp/agent.ts:100-123` — add `kvStore?: KvStore` to `BodhiPiConfig`.
- `packages/bodhi-pi/src/acp/agent.ts` — introduce private `resolveProviderApiKey(provider)`: `kvStore?.get(AUTH_PREFIX + provider)` → `config.getApiKey(provider)` → `extensionRunner.resolveProviderKey(provider)`. Replace both call sites (compaction path ~766-771; ctor wiring ~1271-1276) with this single helper.
- `packages/bodhi-pi/src/index.ts` — re-export `KvStore`, `KvStoreSetOptions`, `AUTH_PREFIX`, `createInMemoryKvStore`.

Files to add (Node adapter):
- `packages/bodhi-pi-node/src/kv/node-kv-store.ts` — `createNodeKvStore({ dir? = path.join(os.homedir(), ".bodhi-pi", "kv") })`. File-per-key, value as plain text. `secret: true` → `chmod 0o600` (parent dir 0o700). Async lock via `proper-lockfile` mirroring `packages/coding-agent/src/core/auth-storage.ts:62-159`. `list(prefix)` reads + decodes filenames. Add `proper-lockfile` to `bodhi-pi-node` deps.
- `packages/bodhi-pi-node/src/kv/key-encoding.ts` — slash and percent encoding for filename safety.
- `packages/bodhi-pi-node/test/node-kv-store.test.ts` — round-trip, prefix filter, 0o600 mode for secret, concurrent writes serialised.

Files to add (Browser adapter):
- `packages/bodhi-pi-browser/src/kv/dexie-kv-store.ts` — `createDexieKvStore({ dbName })`. Two tables: `kv` (non-secret) + `kv_secret` (secret). `get` reads both, secret wins on key conflict. `list(prefix)` scans both. This is the "secret hint" without crypto; documents the segregation seam for future hardening.
- `packages/bodhi-pi-browser/src/kv/dexie-kv-store.test.ts` — fake-indexeddb round-trip; assert secret goes to `kv_secret`.

Test harness:
- `packages/bodhi-pi/test/helpers/harness.ts` — `kvStore?` option; default `createInMemoryKvStore()`.

Test (write first): new `packages/bodhi-pi/test/kv-store.test.ts`. Faux provider records `options.apiKey`; assertions:
- agent reads from `kvStore` when populated (env/getApiKey both empty)
- falls back to `getApiKey` when kvStore lacks the key
- kvStore wins over `getApiKey` when both present
- kvStore omitted → behaviour identical to today

Host rollout:
1. **CLI** (`packages/bodhi-pi-cli/src/agent.ts`): instantiate `createNodeKvStore({ dir: path.join(os.homedir(), ".bodhi-pi-cli", "kv") })`. e2e `packages/bodhi-pi-cli/e2e/auth-kvstore.e2e.ts` — `/login openai sk-...` then prompt with no env key, assert gpt-4o-mini round-trip.
2. **Browser shared** (`bodhi-pi-browser` worker bootstrap): instantiate `createDexieKvStore`. e2e in `bodhi-pi-web` + `bodhi-pi-chrome-ext` seed via existing `window.__bodhiPiWebSeed` analogue.
3. **ws-frontend + ws-server**: `createNodeKvStore` per tenant (`~/.bodhi-pi-ws-server/<tenantId>/kv/`). e2e in ws-frontend.
4. **http**: server-side `createNodeKvStore`; per-turn rebuild reads fresh. Integration test in http; e2e if feasible.

Verification: faux integration; Node adapter test proves 0o600; browser adapter test proves table segregation.

Risks: chrome-ext does not use `chrome.storage.local` this phase (parity with web's Dexie path). Document.

### F3 — Thinking-level ACP advertise + handler + prepareNextTurn + full-list bug fix

**Why:** unblocks reasoning models; closes the existing schema-violation bug in `setSessionConfigOption` response.

Files to modify:
- `packages/bodhi-pi/src/acp/constants.ts` — add `export const THINKING_CONFIG_ID = "thinking";`.
- `packages/bodhi-pi/src/acp/agent.ts`:
  - `BodhiPiConfig` (100-123) — add `defaultThinkingLevel?: ModelThinkingLevel` (host-explicit; precedence over global/project setting).
  - `SessionState` (125-145) — add `thinkingLevel: ModelThinkingLevel` and `pendingThinkingLevelChange: boolean`.
  - `_buildSessionState` — initialise `thinkingLevel` from `merged.defaultThinkingLevel ?? config.defaultThinkingLevel ?? "off"`, then `clampThinkingLevel(model, ...)`.
  - `newSession`/`loadSession`/`resumeSession` response builders (~273-280, ~357-360, ~373-376) — call new `buildAllConfigOptions(session)`.
  - `setSessionConfigOption` (773-807): accept `THINKING_CONFIG_ID`; validate via `getSupportedThinkingLevels(currentModel)`; on success mutate `session.thinkingLevel` + set `pendingThinkingLevelChange`. **Fix bug**: return `buildAllConfigOptions(session)` (full array), not just the changed option.
  - On model-change branch: re-clamp thinking via `clampThinkingLevel(newModel, session.thinkingLevel)`; if clamped, set `pendingThinkingLevelChange = true`.
  - Add `buildThinkingConfigOption(session)` (returns `undefined` if model has only `"off"` supported) and `buildAllConfigOptions(session) = [model, ...(thinking ? [thinking] : [])]`.
  - `prepareNextTurn` (~1319-1321) extends to merge `{ thinkingLevel }` when `pendingThinkingLevelChange`:
    ```ts
    prepareNextTurn: async () => {
      const compactUpdate = await this.maybeProactiveCompact(sessionId);
      const state = this.sessions.get(sessionId);
      if (!state?.pendingThinkingLevelChange) return compactUpdate;
      state.pendingThinkingLevelChange = false;
      return { ...(compactUpdate ?? {}), thinkingLevel: state.thinkingLevel };
    }
    ```
  - Initial pi-`Agent` ctor — pass `initialState: { ..., thinkingLevel }` so the FIRST turn honours the setting without depending on `prepareNextTurn`.
  - `EXT_SESSION_CONFIG` — include `thinkingLevel` in the snapshot.

- `packages/bodhi-pi/src/sessions/entries.ts` — add a `thinking_change` `SessionEntry` variant `{ type: "thinking_change", id, parentId, timestamp, level }`. Append on each successful `setSessionConfigOption("thinking", ...)`.
- `packages/bodhi-pi/src/sessions/build-context.ts` — handle the new variant; track latest thinking on the active branch so resume restores it.
- Audit exhaustive switches: `branch-summary.ts`, `entries.ts` consumers — add fall-through for the new variant.

Test (write first): extend `packages/bodhi-pi/test/session-config-ext.test.ts`:
- advertises thinking option for reasoning model (Anthropic-shaped faux with thinkingLevelMap)
- omits thinking option for non-reasoning model (gpt-4o-mini-shaped faux)
- `setSessionConfigOption thinking returns full configOptions list` (asserts the bug fix)
- flow-through: next prompt's payload has `reasoning: "high"` after `setSessionConfigOption("thinking","high")`
- unsupported level → RequestError (-32602)
- model change preserves supported level; clamps unsupported
- `_bodhi-pi/session/config` returns current `thinkingLevel`
- resume restores `thinkingLevel` from `thinking_change` replay

Real-LLM e2e: gated on `ANTHROPIC_API_KEY` using Claude Haiku 4.5; else skip (per phase prompt § "Test signals"). gpt-4o-mini path asserts thinking option is absent.

Host rollout: identical to F2 — option becomes visible in `/settings list` once F5 lands; until then only ACP-level proof in tests.

Risk: per-turn-rebuild path (http) must rehydrate `thinkingLevel` from persisted `thinking_change` entries. Existing payload-agnostic SQLite store handles new variants without migration (`packages/bodhi-pi-node/src/sessions/sqlite-session-store.ts:25-31`). Test asserts this end-to-end.

### F4 — Per-provider retry/timeout

**Why:** make hosts non-silent about retry/timeout defaults inherited from pi-ai. Settings-file driven; no slash needed.

Files to modify:
- `packages/bodhi-pi/src/acp/agent.ts` `_buildSessionState`: resolve `merged.providerOptions[model.provider] ?? merged.retry`, pass `{ maxRetries, timeoutMs, maxRetryDelayMs }` to `new Agent({...})`. `AgentLoopConfig extends SimpleStreamOptions` (verified: `packages/agent/src/types.ts:127`), so the loop options pass these to each provider stream call.
- Store resolved retry options on `SessionState.retryOptions` for `EXT_SESSION_CONFIG` surfacing.
- Helper: `resolveProviderStreamOptions(provider, mergedSettings)`.

Decision (matches user pref "Settings-file only, no slash"): **static-per-session retry options.** If the user changes model mid-session and the new provider has different retry settings, the change takes effect at the **next session**, not the next turn. This avoids widening `AgentLoopTurnUpdate` upstream. Document in PARITY.md as a deferred-row.

Test (write first): new `packages/bodhi-pi/test/provider-options.test.ts` with faux that records full `options`:
- `providerOptions per provider thread to stream call`
- `defaults from retry block apply when providerOptions omits provider`
- `EXT_SESSION_CONFIG surfaces resolved retry options`

Host rollout: integration tests only (no slash); each host gets a faux-provider integration assertion that `.bodhi-pi/settings.json` with `providerOptions` round-trips into `/config`.

Risks: confirm with user mid-phase that static-per-session is acceptable (vs widening `AgentLoopTurnUpdate` upstream).

### F5 — Flat slashes: `/settings`, `/login`, `/logout`, `/logins`

**Why:** user-facing surface for everything F1-F4 ships. Slashes are flat (all args inline), translate directly to ACP extension methods, no host-side prompting.

Files to add (core):
- `packages/bodhi-pi/src/core/settings-writer.ts` — `writeGlobalSetting(fs, homeDir, key, value)`, `writeProjectSetting(fs, cwd, key, value)`, `unsetGlobalSetting`, `unsetProjectSetting`. Dotted keys parse to nested objects (`compaction.reserveTokens` → `{ compaction: { reserveTokens: ... } }`). Value parser: try `JSON.parse`, fallback to raw string.
- Add to `packages/bodhi-pi/src/acp/constants.ts`:
  - `EXT_SESSION_SETTINGS_GET = "_bodhi-pi/session/settings/get"`
  - `EXT_SESSION_SETTINGS_SET = "_bodhi-pi/session/settings/set"`
  - `EXT_SESSION_SETTINGS_UNSET = "_bodhi-pi/session/settings/unset"`
  - `EXT_SESSION_SETTINGS_LIST = "_bodhi-pi/session/settings/list"`
  - `EXT_KV_SET = "_bodhi-pi/kv/set"` — params `{ key, value, secret?: boolean }`
  - `EXT_KV_GET = "_bodhi-pi/kv/get"` — params `{ key }`, returns `{ value: string | null, secret: boolean }`. **If `secret` is true, `value` returns `"***"` instead of the real string.** Returns `value: null` if the key doesn't exist.
  - `EXT_KV_LIST = "_bodhi-pi/kv/list"` — params `{ prefix?: string }`, returns `{ entries: Array<{ key, value, secret }> }`. **Secret entries have `value === "***"`.**
  - `EXT_KV_REMOVE = "_bodhi-pi/kv/remove"` — params `{ key }`

Files to modify (core):
- `packages/bodhi-pi/src/acp/agent.ts` — register eight new handlers in the existing `EXT_*` dispatch (~line 442):
  - Settings handlers: session-scope writes mutate `SessionState.sessionOverrides: BodhiPiProjectSettings`; effective = `merge(merge(merge(defaults, global), project), sessionOverrides)`. Behaviour reads consult `state.getEffectiveSettings()` helper.
  - `--global` on a settings call when `config.homeDir` is unset → `RequestError -32602` with message `"--global scope not supported on this runtime; use --project or --session"`. Same error for `/settings list --global`, `/settings get --global`, `/settings set --global`, `/settings unset --global`. The slash exists everywhere; only certain scopes work per runtime.
  - KV handlers consult `config.kvStore`. Throw `-32601 method not found` if `kvStore` unset.
  - **KV read masking**: `_bodhi-pi/kv/get` and `_bodhi-pi/kv/list` MUST return `"***"` in the value field when `secret === true`. The `secret` flag is also returned so the client can render `***` distinctly. **Internal API-key resolution** continues to call `kvStore.get(...)` directly (unmasked) — only the ACP-exposed surface masks.

F2 amendment — `KvStore` interface must expose meta:
- `packages/bodhi-pi/src/kv/kv-store.ts`:
  ```ts
  export interface KvStoreEntry { value: string; secret: boolean }
  export interface KvStore {
    get(key: string): Promise<string | undefined>;             // unmasked, internal use
    getWithMeta(key: string): Promise<KvStoreEntry | undefined>; // for ACP read with masking
    set(key: string, value: string, opts?: KvStoreSetOptions): Promise<void>;
    remove(key: string): Promise<void>;
    list(prefix?: string): Promise<string[]>;                  // unmasked, internal use
    listWithMeta(prefix?: string): Promise<Array<{ key: string } & KvStoreEntry>>;
  }
  ```
- `packages/bodhi-pi/src/kv/in-memory-kv-store.ts`, `packages/bodhi-pi-node/src/kv/node-kv-store.ts`, `packages/bodhi-pi-browser/src/kv/dexie-kv-store.ts` — implement meta-bearing methods. Node adapter records `secret` via a sidecar (e.g. `<key>.json` companion with `{secret:true}` next to the value file). Browser adapter: secret bit is implicit from which Dexie table the entry lives in.

Test (write first): new `packages/bodhi-pi/test/settings-slash.test.ts`:
- session scope mutates in-memory only (FS untouched)
- project scope writes `.bodhi-pi/settings.json`
- global scope writes `~/.bodhi-pi/settings.json` when `homeDir` set
- **global scope errors with -32602 when `homeDir` unset** (asserts error message contains `--global scope not supported`)
- unset removes the key (effective falls back to next layer)
- list returns merged effective by default; per-scope on flag
- dotted keys parse to nested
- unknown keys accepted (escape hatch)

Test (write first): new `packages/bodhi-pi/test/kv-slash.test.ts`:
- `_bodhi-pi/kv/set auth/openai sk-XYZ secret:true` → subsequent `_bodhi-pi/kv/get auth/openai` returns `{ value: "***", secret: true }`
- internal API-key resolution still reads the real `sk-XYZ` (asserted via faux provider's recorded `options.apiKey`)
- `_bodhi-pi/kv/list auth/` returns entries with all secret values masked
- non-secret entries return real values on get/list
- remove clears the entry; subsequent get returns `value: null`
- handlers throw -32601 when `config.kvStore` is unset

Per-host slash dispatchers — files to modify (all five must update together; identical `/help` text):
- `packages/bodhi-pi-cli/src/repl/commands.ts`
- `packages/bodhi-pi-browser/src/ui/commands.ts` (web + chrome-ext)
- `packages/bodhi-pi-ws-frontend/src/ui/commands.ts`
- `packages/bodhi-pi-http/src/frontend/ui/commands.ts`

Slash command surface (identical across hosts — flat, no prompts):
- `/settings list [--global|--project|--session|--effective]` → `EXT_SESSION_SETTINGS_LIST` (default `--effective`)
- `/settings get <key> [--scope]` → `EXT_SESSION_SETTINGS_GET`
- `/settings set <key> <value> [--global|--project|--session]` → `EXT_SESSION_SETTINGS_SET` (default `--session`)
- `/settings unset <key> [--scope]` → `EXT_SESSION_SETTINGS_UNSET`
- `/login <provider> <api-key>` → flat sugar for `_bodhi-pi/kv/set` with `key="auth/<provider>"`, `value=<api-key>`, `secret=true`. **No prompting; key is on the command line.**
- `/logout <provider>` → flat sugar for `_bodhi-pi/kv/remove` with `key="auth/<provider>"`.
- `/logins` → `_bodhi-pi/kv/list` with `prefix="auth/"`. Prints `<provider>: ***` rows so the user can confirm which providers have stored keys without leaking the values.

NOT included (per user direction): no `/settings cycle`, no `/thinking`, no `/model`. Host UI is responsible for cycle/keybinding UX via the underlying ACP methods (`setSessionConfigOption` + `_bodhi-pi/session/settings/set`).

Update `/help` text in each host's commands.ts to include the six new commands (`/settings list|get|set|unset`, `/login`, `/logout`, `/logins`). Mirror across all five files; keep word-for-word identical.

Host rollout — order:
1. **CLI**: e2e `packages/bodhi-pi-cli/e2e/settings-slash.e2e.ts` — `/settings set appendSystemPrompt "say UNIQUE_TOKEN" --global`, start new session, assert assistant reply contains the token (gpt-4o-mini). Plus `packages/bodhi-pi-cli/e2e/login-slash.e2e.ts` — `/login openai sk-...`, `/logins` shows `openai: ***`, then prompt with env cleared succeeds.
2. **Browser shared**: e2e in web + chrome-ext via the same dispatcher. Web assertion: `/settings set foo bar --global` returns the `-32602 not supported on this runtime` error inline.
3. **ws-frontend**: server gains `_bodhi-pi/kv/*` handlers + per-tenant kvStore wiring.
4. **http**: per-turn rebuild reads kvStore fresh.

Verification:
- Slash output in each host renders updated settings.
- Subsequent `/settings list` after `/settings set compaction.reserveTokens 9999` (default --session) shows the new value with source `session`.
- `/login openai sk-...` followed by a prompt with no env key succeeds.
- `/logins` shows `openai: ***` — never the real key.
- `/settings set foo bar --global` on a browser host shows a clean error inline.

Risks to revisit mid-phase:
- **Dotted-key parser**: default = nested objects. Confirmed.
- **Split-host `_bodhi-pi/kv/*`** vs host-local REST. Plan picks extension methods (reuses ACP transport).
- **CLI history exposes keys**: `/login openai sk-...` puts the secret in shell history. Phase I accepts this per user direction (flat-and-complete slashes). Document the limitation; a `/login --from-env` variant can be added in a follow-up if needed.

### F6 — PARITY.md update

Files to modify: `packages/bodhi-pi/PARITY.md`.

Shipped rows (move from Deferred or add new):
- Layered settings (global `~/.bodhi-pi/settings.json` + merge) — Node hosts only.
- Thinking levels (`setSessionConfigOption("thinking", ...)`, advertised in `configOptions`, filtered by model capability, wired through `prepareNextTurn`).
- Per-provider retry/timeout (settings-file driven, static-per-session).
- Host-injected `KvStore` + auth credential storage with `secret` hint.
- Full `configOptions[]` returned from `setSessionConfigOption` (schema-conformance fix).
- `/settings get|set|unset|list`, `/login`, `/logout`, `/logins` flat slashes across five hosts.
- KV read masking: `_bodhi-pi/kv/get` and `_bodhi-pi/kv/list` return `***` for secret-marked entries; internal in-process reads remain unmasked.

Deferred rows (new ⏭):
- OAuth login flow (Anthropic Claude.ai et al.) and OAuth token refresh — needs interactive browser auth + per-host plumbing.
- Dynamic model registry (`models.json`, `modelOverrides`, OAuth `modifyModels`) — primary motivator (`modifyModels`) is OAuth-dependent.
- Scoped-models cycle command — depends on dynamic registry.
- Cross-provider mid-session retry/timeout mutation — static-per-session is sufficient for Phase I.
- Browser encrypted-at-rest secret storage — `kv_secret` table is segregation only.
- Global settings layer in browser hosts — `homeDir` is Node-only.

## Cross-cutting

**Test harness** (`packages/bodhi-pi/test/helpers/harness.ts`):
- new optional: `homeDir?`, `kvStore?`, `defaultThinkingLevel?`.

**Faux/mock strategy**:

| Sub-feature | Strategy |
|---|---|
| F1 | In-memory Filesystem; settings round-trip via `EXT_SESSION_CONFIG`. No LLM. |
| F2 | `registerFauxProvider` recording `options.apiKey`. No real network. |
| F3 | `registerFauxProvider` recording `options.reasoning`. Real e2e: Anthropic Haiku 4.5 if `ANTHROPIC_API_KEY`; else faux + assert thinking option absent for gpt-4o-mini. |
| F4 | `registerFauxProvider` recording full `options`. |
| F5 | gpt-4o-mini for the `/settings set appendSystemPrompt --global` round-trip; faux for `/login`/`/logout`/`/logins` (CLI e2e proves real round-trip after `/login openai sk-...`). |

**TDD order per F**: core integration test (faux) → core impl → core green → core real-LLM e2e (where applicable) → adapter unit test → host e2e (CLI → browser shared → ws-frontend → http).

**PR slicing**:
- PR1 = F1
- PR2 = F2 (KvStore + Node + Browser adapters)
- PR3 = F3 (thinking levels + full-list bug fix + `thinking_change` entry)
- PR4 = F4 (per-provider retry/timeout)
- PR5 = F5 (all five hosts together — `/help` parity rule)
- PR6 = F6 (doc-only)

Each PR carries its full host matrix.

## Architecture risks to re-check mid-phase

1. **F3 `thinking_change` `SessionEntry` variant.** Confirm: persisted entry vs ephemeral session-only state. Plan picks persisted so resume restores it. Existing payload-agnostic SQLite/Dexie stores handle the new variant without migration.
2. **F4 static-per-session retry options.** Plan defers cross-provider-on-model-change mutation. Confirm acceptable.
3. **F5 split-host kv proxy** via `_bodhi-pi/kv/*` extension methods (vs host-local REST). Plan picks extension methods.
4. **F5 dotted-key parser** for `/settings set compaction.reserveTokens 4000` → nested. Confirm.
5. **F5 CLI history leak**: `/login openai sk-...` exposes the key to shell history. Per user direction, accepted limitation of flat-slash design; document.

## Verification end-to-end

After Phase I lands, a user can:
1. Edit `~/.bodhi-pi/settings.json` with `{"defaultThinkingLevel":"medium","providerOptions":{"openai":{"maxRetries":5}}}` → `/settings list --effective` shows the merged view sourced from `global` (Node hosts).
2. `/settings set defaultThinkingLevel high --session` → next turn uses `reasoning: "high"` (Anthropic) without persisting. ACP `setSessionConfigOption("thinking", "high")` does the same.
3. `/settings set defaultThinkingLevel high --global` → new sessions default to `"high"` (Node hosts). Browser hosts: error `-32602 --global scope not supported on this runtime`.
4. `/login openai sk-...` → next prompt uses the stored key (no env). `/logins` shows `openai: ***`. `/logout openai` → next prompt falls back to env or `getApiKey`.
5. `setSessionConfigOption("thinking","high")` from any ACP client returns the FULL `configOptions[]` array (both model and thinking entries).
6. Host UI can implement keybinding-cycle of thinking levels by calling `_bodhi-pi/session/settings/list` + `setSessionConfigOption` itself (no `/settings cycle` slash needed).

End-to-end checks at phase boundary:
- `just test` green at repo root.
- `packages/bodhi-pi/PARITY.md` reflects shipped + deferred deltas.
- Pre-commit (`npm run check` — biome + tsgo + browser smoke) passes.
- Restore `packages/ai/src/models.generated.ts` before commit.
- One commit: `feat(bodhi-pi): model & provider management (Phase I)` with body listing the six sub-features + the five deferred items + the static-per-session retry trade-off.

## Critical files

- `packages/bodhi-pi/src/acp/agent.ts` — most changes (BodhiPiConfig, SessionState, all four dispatch sites for configOptions, prepareNextTurn, EXT_* handlers).
- `packages/bodhi-pi/src/acp/constants.ts` — new constants.
- `packages/bodhi-pi/src/core/settings.ts` — extended schema.
- `packages/bodhi-pi/src/core/settings-global.ts`, `settings-merge.ts`, `settings-writer.ts` — new modules.
- `packages/bodhi-pi/src/kv/kv-store.ts`, `in-memory-kv-store.ts` — new modules.
- `packages/bodhi-pi/src/sessions/entries.ts`, `build-context.ts` — new entry variant.
- `packages/bodhi-pi-node/src/kv/node-kv-store.ts` — file-based with proper-lockfile.
- `packages/bodhi-pi-browser/src/kv/dexie-kv-store.ts` — Dexie two-table.
- Five host slash dispatchers (cli, browser-shared, ws-frontend, http frontend) + their `/help` text.
- `packages/bodhi-pi/PARITY.md` — F6.
- `packages/bodhi-pi/test/helpers/harness.ts` — new harness options.
