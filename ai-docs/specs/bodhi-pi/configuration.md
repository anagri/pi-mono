# Configuration

bodhi-pi has **three** configuration surfaces. Together they answer "what model, what settings, what dependencies should this session use?" Each layer reads from a different place; the layers compose deterministically.

```
[1] Application-start config — BodhiPiConfig (in code)
        │
        ▼
[2] Disk hierarchy           — defaults < global < project < host-explicit < session
        │
        ▼
[3] Session-mutable config   — setSessionConfigOption + _bodhi-pi/session/settings/*
```

## Layer 1 — Application-start config (`BodhiPiConfig`)

The dependency bundle the Host passes to `createBodhiPiAgent(config)` (`src/acp/agent.ts:150-158`). Source-of-truth shape lives at `src/acp/agent.ts:67-119`.

**Required** — factory throws at construction if missing:

| Field | Type | Source-of-truth |
|---|---|---|
| `sessionStore` | `SessionStore` | `src/acp/agent.ts:151-153` |
| `filesystem` | `Filesystem` | `src/acp/agent.ts:154-156` |

**Optional** — silent default OR throws at use time (see § Known weaknesses):

| Field | Default | Behaviour on use without the dep |
|---|---|---|
| `kvStore` | none | `_bodhi-pi/kv/*` throws `-32601`; auth + MCP add are unavailable |
| `scriptExecutor` | none | `run_script` built-in tool is not registered |
| `terminal` | none | `bash` built-in tool is not registered |
| `models` | `[]` | merges into pi-ai catalogue; nothing happens if empty |
| `defaultModelId` | first auth-available pi-ai model | model picker picks one for you |
| `getApiKey` | `() => undefined` | provider calls fail with auth error |
| `extensionFactories` | `[]` | no extensions; partial-failure policy is log-and-continue (see [D8 in design-smell follow-up plan](../../plans/2026-05-17-bodhi-pi-design-smell-followup.md)) |
| `mcpConnectionProvider` | `createInProcessMcpConnectionProvider()` | in-process default — dies with the agent instance; **stateless server Hosts MUST inject** (see CLAUDE.md "MCP" section) |
| `supportsMcpStdio` | `true` | wrong value = silent UX bug; jsdoc warning at `src/acp/agent.ts:101-105` |
| `homeDir` | none | global settings layer is silently skipped |
| `globalFilesystem` | `config.filesystem` | global settings file is read through the same FS as project |
| `compaction` | `DEFAULT_COMPACTION_SETTINGS` (`src/sessions/compaction.ts`) | sensible defaults |
| `defaultThinkingLevel` | none | model-default thinking level used |
| `systemPrompt` | composed builtin prompt | **only sanctioned silent default** (per CLAUDE.md "Source code rules") |
| `appendSystemPrompt` | none | nothing appended (or what disk settings say — see § Settings precedence) |
| `eventHandlers` | `{}` | no Host-side observers; event bus still fires |
| `logger` | `console` | non-fatal errors go to stderr |

**Throw-at-construction rule** (`src/acp/agent.ts:150-158`): only `sessionStore` and `filesystem` throw eagerly. Every other "required-for-a-particular-feature" dep throws at the call site of the feature (typically `-32601`). See § Known weaknesses for the design-smell discussion.

## Layer 2 — Disk hierarchy

Settings can live on disk; bodhi-pi reads them at session boot, never again until the next `session/new`/`load`/`resume`.

```
defaults
  └─ overlay: <homeDir>/.bodhi-pi/settings.json    (loadGlobalSettings; Node Hosts only)
       └─ overlay: <cwd>/.bodhi-pi/settings.json   (loadProjectSettings; walks cwd ancestors)
            └─ overlay: BodhiPiConfig fields        (host-explicit, factory-time)
                 └─ overlay: setSessionConfigOption (live mutations — see Layer 3)
```

Resolution lives at `src/sessions/session-bootstrap.ts:70-89`:

```ts
const [projectCommands, skills, contextFiles, projectSettingsResult, globalSettingsResult] = await Promise.all([
  loadProjectCommands(config.filesystem, cwd),
  loadProjectSkills(config.filesystem, cwd),
  loadProjectContextFiles(config.filesystem, cwd),
  loadProjectSettings(config.filesystem, cwd),
  config.homeDir
    ? loadGlobalSettings(config.globalFilesystem ?? config.filesystem, config.homeDir)
    : Promise.resolve(undefined),
]);
const mergedFileSettings = mergeSettings(globalSettingsResult?.settings ?? {}, projectSettingsResult.settings);
```

### File locations

| Layer | Path | Source-of-truth |
|---|---|---|
| Global | `<homeDir>/.bodhi-pi/settings.json` | `src/settings/settings.ts:18` (`GLOBAL_SETTINGS_PATH`) |
| Project | `<cwd>/.bodhi-pi/settings.json` (walked up from `cwd`) | `src/settings/settings.ts:10` (`SETTINGS_PATH`) |

The project walk ascends ancestors using `path.posix.dirname` and terminates at the FS mount root (FSA-rooted browser Hosts) or at `/` for Node.

### Project settings shape (`BodhiPiProjectSettings`)

Source: `src/settings/settings.ts:35-42`.

| Key | Type | Effect |
|---|---|---|
| `defaultModelId` | `string` | Default model id. Canonical name (matches `BodhiPiConfig.defaultModelId`). The legacy `defaultModel` key is still read for back-compat — see § Known weaknesses D6 |
| `defaultThinkingLevel` | `ModelThinkingLevel` | Default thinking budget |
| `appendSystemPrompt` | `string` | Appended after the composed system prompt |
| `compaction` | `Partial<CompactionSettings>` | Compaction thresholds |
| `providerOptions` | `Record<string, ProviderOptionsEntry>` | Per-provider retry/timeout/maxRetryDelay |
| `retry` | `RetrySettings` | Default retry behaviour when no per-provider entry |

### `parseSettingValue` — JSON coercion on `set`

When `_bodhi-pi/session/settings/set` is called with a string `value`, it goes through `parseSettingValue` (`src/settings/settings-writer.ts:58`) which:
- Tries `JSON.parse(value)` first — so `"123"` becomes `123`, `"true"` becomes `true`, `"[1,2,3]"` becomes `[1,2,3]`.
- Falls back to the raw string if JSON.parse throws.

Object/array values passed directly (not as a string) bypass coercion.

## Layer 3 — Session-mutable config

Two distinct mechanisms; pick by whether the key is ACP-blessed or arbitrary.

### `setSessionConfigOption` (native ACP)

`session/setSessionConfigOption` (`src/acp/agent.ts:497-499`). Used for ACP-blessed dynamic config: model selection and thinking level. Backed by `ModelRegistry.setSessionConfigOption` (`src/models/registry.ts`).

| Option ID | Constant | Effect |
|---|---|---|
| `model` | `MODEL_CONFIG_ID` from `src/wire/constants.ts` | Switches `SessionState.runtime.currentModelId`; emits `model_select` event; appends `model_change` SessionEntry |
| `thinking` | `THINKING_CONFIG_ID` | Switches `SessionState.runtime.thinkingLevel`; appends `thinking_change` SessionEntry |

The response shape is the full `configOptions[]` (the user can re-render the picker) — see acp.md.

### `_bodhi-pi/session/settings/*` (extension)

Generic arbitrary-key path. Lives in `src/settings/settings-service.ts`. Keys are dotted paths (e.g. `providerOptions.openai.maxRetries`).

| Method | Behaviour |
|---|---|
| `_bodhi-pi/session/settings/get` | Reads from chosen scope OR effective merged view |
| `_bodhi-pi/session/settings/set` | Writes file (global/project) or in-memory `sessionOverrides` (session); emits `settings_change{reason:"set"}` |
| `_bodhi-pi/session/settings/unset` | Removes the path; emits `settings_change{reason:"unset"}` |
| `_bodhi-pi/session/settings/list` | Defaults to `scope:"effective"` (merged view) |

`scope` parameter is one of `"global" | "project" | "session"`. `"global"` requires Host to have provided `homeDir`; otherwise rejects `-32602`.

See [acp.md § Settings methods](./acp.md#settings-methods) for full per-method reference.

## Persistence boundaries

Where each kind of config actually lives:

| Surface | Lives in | KV namespace |
|---|---|---|
| Provider API keys | `KvStore` | `auth/<provider>` — `AUTH_PREFIX` constant from `src/kv/kv-store.ts` |
| MCP server entries | `KvStore` | `mcp/<slug>` — `MCP_PREFIX` constant from `src/mcp/mcp-types.ts` |
| Project settings | File at `<cwd>/.bodhi-pi/settings.json` via `Filesystem` | — |
| Global settings | File at `<homeDir>/.bodhi-pi/settings.json` via `Filesystem` | — |
| Session overrides | In-memory `SessionState.sessionOverrides` | — |
| Current model / thinking | In-memory `SessionState.runtime.{currentModelId, thinkingLevel}` + persisted `model_change` / `thinking_change` SessionEntry | — |
| MCP inclusion (per session) | Persisted `mcp_inclusion_set` SessionEntry on the active branch | — |

**Secret masking** — values written to KV with `secret: true` are masked to `***` on every ACP read (`_bodhi-pi/kv/get`, `_bodhi-pi/kv/list`) but readable unmasked by internal callers (e.g. `getApiKey`). See [CONTEXT.md § KvStore](../../../packages/bodhi-pi/CONTEXT.md#persistence) and `src/kv/kv-store.ts` (`maskSecrets`, `containsSecret`).

## Wire constants leakage policy

`src/wire/constants.ts` is the leaf protocol module — **no other source file may hardcode an ACP method name or extension method literal**. Domain services import the constants by name (`MODEL_CONFIG_ID`, `EXT_SESSION_SETTINGS_SET`, etc.). This rule has been verified clean across `src/` (zero `_bodhi-pi/` string literals outside `src/wire/`).

## Known weaknesses

These are *descriptive* — they document confusion the current model produces. The redesign is **not** in scope for this spec; flagged for a future ADR. Full details in [`ai-docs/plans/2026-05-17-bodhi-pi-design-smell-followup.md`](../../plans/2026-05-17-bodhi-pi-design-smell-followup.md).

### D6 — Settings fragmentation + parallel key namespaces *(partially resolved)*

**Naming (resolved)**: `BodhiPiProjectSettings.defaultModelId` is now the canonical on-disk name, matching `BodhiPiConfig.defaultModelId` in code. The legacy `defaultModel` key remains readable for back-compat (resolved via `resolveSettingsDefaultModelId()` in `src/settings/settings.ts`); new settings files should write `defaultModelId`. The `affectsPickerKey()` filter in `src/acp/event-wiring.ts` recognises both names.

**Runtime-field layering (deferred)**: `SessionState.runtime.currentModelId` and `SessionState.runtime.thinkingLevel` remain direct fields on the runtime, NOT in `sessionOverrides`. They are intentionally a fast-path cache for the prompt loop — `pi-agent-core` reads `state.modelId`/`state.thinkingLevel` on every turn, and threading those reads through a `sessionOverrides` lookup adds latency without changing semantics. The authoritative record of session-level model/thinking choice lives in the session log (`model_change` entries); runtime fields mirror that.

**Dual write paths (deferred)**: `setSessionConfigOption("model", …)` and `_bodhi-pi/session/settings/set("defaultModelId", …, scope:"session")` still write to different places (runtime cache vs. sessionOverrides). The model-picker UX flows through `setSessionConfigOption`; manual settings edits flow through `_bodhi-pi/session/settings/*`. Hosts that need a serialized view of "current session config" should read both — this is documented but not yet collapsed.

Full unification onto `sessionOverrides` (option A from the design-smell follow-up) is tracked for a future PR; the current spec captures the partial fix.

### D7 — `supportsMcpStdio` silent-default risk

`supportsMcpStdio` defaults to `true` (`src/acp/agent.ts:215`). Hosts that cannot spawn child processes (browser, chrome-ext, stateless HTTP rebuild) MUST explicitly set `false`, otherwise `_bodhi-pi/mcp/add` silently accepts `command=…` entries that subsequent `_bodhi-pi/mcp/connect` calls cannot fulfil. The risk is the default — not the behaviour. A jsdoc warning was added at `src/acp/agent.ts:101-105` (D7 inline-fix).

### D9 — Capability advertisement vs Host-injected reality *(resolved)*

`kvStore`, `terminal`, `scriptExecutor`, `mcpConnectionProvider` are optional on `BodhiPiConfig`. When a feature that needs them is invoked, the agent still throws `-32601` ("capability missing") — at the call site, not at construction time. The `initialize` response now advertises per-namespace availability in `agentCapabilities._meta["bodhi-pi"].available = {kv, mcp, terminal, scriptExecutor, settings}`, computed at agent construction from the injected adapter set. Clients should consult this flag to disable/hide UX surfaces for absent namespaces rather than discovering the gap by call-and-fail.

`mcp` mirrors `kv` because MCP entries persist in the KV store — without one, `/mcp add` and hydration are non-functional even if a connection provider is wired. `settings` is `true` whenever filesystem is injected (which is mandatory), so it is effectively always `true`. See `src/acp/agent.ts` `computeAvailability()`.

## See also

- [architecture.md § Dependency injection contract](./architecture.md#dependency-injection-contract) — the `BodhiPiConfig` table from a wiring perspective.
- [lifecycle.md § Settings layering](./lifecycle.md#settings-layering-touches-every-entry-above) — when in the session lifetime each layer is read.
- [acp.md § Settings methods](./acp.md#settings-methods) — per-method reference for `_bodhi-pi/session/settings/*`.
- [mcp.md § Auth](./mcp.md#auth) — KV layout for MCP server entries.
- `src/sessions/session-bootstrap.ts:70-89` — the parallel I/O block that loads everything.
- `src/settings/settings-writer.ts:58` — `parseSettingValue` JSON coercion.
- `src/wire/constants.ts` — every `_bodhi-pi/*` method name.
