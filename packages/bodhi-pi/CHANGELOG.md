# Changelog

## [Unreleased]

### Changed
- Internal: `acp/agent.ts` decomposed without API change. The 17-arm
  `extMethod()` if/else dispatch chain becomes a private readonly
  `Map<string, ExtHandler>` (`extHandlers`) keyed on method name; the
  `session/delete` body moves into a sibling `handleSessionDelete()`
  to match the rest. Every handler that takes a `sessionId` param now
  goes through saturated guards — `requireSessionRecord(id)` for
  storage-only lookups, `requireSession(id)` for runtime lookups,
  `validateSessionId(value)` for typed-string narrowing, and
  `optionalSessionId(value)` for "id or undefined" args — so the same
  `unknown session` and `not loaded` error strings come from one place.
  Three call sites that ran a compaction + persisted its entry inline
  (`/compact`, proactive recovery, post-prompt threshold trigger) now
  go through `runAndPersistCompaction()` returning a discriminated
  `{ status: "success" | "skipped" | "error" }` plus a shared
  `makeCompactionEntry()` builder; the `compaction_start`/
  `compaction_end` event ordering is unchanged. The four `agent_end`
  emissions in `prompt()` collapse into one closure-local `finishTurn()`
  helper. The 200-line `_buildSessionState()` orchestrator splits into
  `loadProjectArtifacts()` (commands + skills + extensions reload),
  `composeSystemPrompt()` (skills XML block assembly), and
  `createPiAgent()` (model resolution + tool registration), reducing
  `_buildSessionState` itself to ~30 lines of orchestration. The
  `SessionState` interface splits into `SettingsState` (settings/auth/kv
  serializable view) and `SessionRuntime` (in-memory `piAgent`,
  `currentModelId`, `leafId`, `toolset`, etc.); accesses now read
  `session.settings.X` or `session.runtime.X` consistently. No public
  type or wire change. (Batch 3 of the 2026-05-11 tech-debt review.)
- Internal: dedup `FileOps` tracking, message serialization, and the
  LLM summarization wrapper between `sessions/compaction.ts` and
  `sessions/branch-summary.ts` into a new module-private
  `sessions/_shared.ts` (covers `extractFileOpsFromMessage`,
  `computeFileLists`, `formatFileOperations`, `serializeConversation`,
  `joinTextBlocks`, and `runSummarizationLLM`). `walkPath` now backs
  the chain-walk in `buildSessionContext` and
  `createInMemorySessionStore.forkRecord` instead of two inline
  copies. The three user-message wrappers in `build-context.ts`
  (`compactionSummaryMessage`, `branchSummaryMessage`,
  `customDisplayMessage`) share a single `wrapAsUserMessage` helper.
  branch-summary's tool-result truncation moves from 800 to 2000
  chars and now includes thinking blocks, aligning with compaction
  and upstream coding-agent — observable only in the LLM-facing
  summarization request, not in any persisted entry. Public exports
  unchanged. (Batch 2 of the 2026-05-11 tech-debt review.)

### Changed (BREAKING)
- No hardcoded `gpt-4o-mini` fallback. `pickDefaultModelId()` now
  returns `string | null` and only resolves to a concrete id when at
  least one provider has auth-resolvable credentials AND a configured
  default model id is present in the candidate list (or there is a
  unique candidate the host hasn't ruled out). When neither holds,
  `currentModelId` is `null` for the lifetime of the session until
  the host calls `setSessionConfigOption({ configId: "model" })` (or
  the user issues `/model <id>`). `prompt()` now rejects with
  `RequestError(-32602, ...)` carrying a branched message — the empty-
  models branch hints "configure provider auth with `/login <provider>
  <api-key>`" and the populated-models branch hints "pick one with
  `/model <id>`". `ModelSelectEvent.fromModelId` widens to
  `string | null` so the boot-from-unset transition is observable; the
  `current_value` field of the model `ConfigOption` is now `""` (not
  `"gpt-4o-mini"`) when no model has been chosen — host UIs must
  display the empty/null state instead of pretending a model is
  active. Hosts in this repo (`bodhi-pi-cli` REPL, `bodhi-pi-browser`
  RuntimeProvider, `bodhi-pi-http` frontend, `bodhi-pi-ws-frontend`,
  `bodhi-pi-web`/`-chrome-ext`) surface the same branched hint via a
  system message at boot when `currentModelId === null`. (Batch 3 of
  the 2026-05-11 tech-debt review.)
- ACP-conforming notifications replace ad-hoc `configOptions` response
  fields. The four ext methods `_bodhi-pi/session/settings/{set,unset}`
  and `_bodhi-pi/kv/{set,remove}` no longer carry `configOptions` in
  their response. Hosts subscribe to the spec-stable
  `sessionUpdate: "config_option_update"` notification (SDK shape:
  `{ configOptions }`) instead. `setSessionConfigOption`'s response
  `configOptions` (spec-mandated for that method) is unchanged AND now
  also fires the same notification via the internal `model_select`
  subscriber. `_bodhi-pi/session/setName` newly fires
  `sessionUpdate: "session_info_update"` (`{ title, updatedAt }`).
- `LabelEntry` (unused since introduction) removed from
  `SessionEntry` union and public exports. Sessions stores that ever
  persisted entries with `type: "label"` will surface them as unknown
  types — none exist in the matrix today (PoC stance).

### Added
- Eight new lifecycle events: `auth_change`, `settings_change`,
  `compaction_start`, `compaction_end`, `branch_summary_created`,
  `session_navigate`, `session_fork`, `session_clone`. Extensions
  subscribe via `BodhiPiEventHandlers`. Compaction events carry a
  `reason: "manual" | "proactive" | "recovery"` discriminator;
  `compaction_end` carries `summary`/`firstKeptEntryId`/`tokensBefore`
  on success and `errorMessage` on failure. The agent itself
  registers internal subscribers on `auth_change`/`settings_change`/
  `model_select` to dispatch the `config_option_update` notification —
  same hook surface available to extensions.
- `ScriptExecutor` host interface + `run_script` built-in tool.
  Optional `BodhiPiConfig.scriptExecutor` (no default helper — runtime
  choice belongs to the host). When provided, `run_script` is
  capability-conditionally registered with TypeBox params
  `{ path, args?, timeout? }`. Path resolves against session `cwd`
  (same rule as `read`/`write`); ACP `tool_call.kind` is `"execute"`.
  Output (stdout + stderr + exitCode) is truncated per
  `RUN_SCRIPT_MAX_BYTES` (50KB per stream). Public types
  `ScriptExecutor`, `ScriptExecuteParams`, `ScriptExecuteResult`
  exported. Reference test executor (non-sandboxed `new Function`)
  ships under `test/helpers/script-executor.ts`. End-to-end scripted
  skill (`days-since-birthday`) verifies the full skill+script chain
  via `gpt-4o-mini`.
- Skills (markdown-only). Folder-per-skill bundles under
  `<cwd>/.bodhi-pi/skills/<name>/SKILL.md` are discovered via the
  injected `Filesystem` at session hydration. YAML frontmatter supports
  `name?`, `description` (required), `disable-model-invocation?`, and
  `allowed-tools?` (parsed but not enforced — matches coding-agent v1).
  At session creation the agent appends an `<available_skills>` XML
  block to the host's `systemPrompt`; skills with `disable-model-
  invocation: true` are excluded from the block but still invocable.
  Every skill (including hidden ones) is advertised as
  `skill:<name>` in `available_commands_update`. `/skill:<name> args`
  in a `session/prompt` wraps the SKILL.md body in a `<skill>` element
  and appends args as a separate paragraph (NOT `$1`-substituted —
  different from prompt templates). Unknown names pass through
  verbatim. Sibling files in a skill folder (scripts, references,
  assets) are loadable by the existing `read` tool — script execution
  is a separate milestone.
- Slash commands / prompt templates. Markdown files under
  `<cwd>/.bodhi-pi/commands/*.md` (with optional YAML frontmatter for
  `description` and `argument-hint`) are discovered via the injected
  `Filesystem` at session hydration and advertised via ACP
  `available_commands_update`. `session/prompt` text starting with
  `/<name>` is expanded against the cached templates (supports `$1`/`$2`/…,
  `$@`, `$ARGUMENTS`, `${@:N}`, `${@:N:L}`) before being forwarded to the
  LLM; unknown names pass through verbatim. New runtime dep: `yaml`.
- M3.2 — Health pass + `BodhiPiConfig.systemPrompt`. Five-commit cleanup
  derived from the M3.1 multi-angle health review.
  - **Wire correctness:** `prompt()` now maps pi-agent-core's `stopReason`
    to ACP's enum (`aborted → cancelled`, `length → max_tokens`,
    `stop`/`toolUse → end_turn`, `error → throws RequestError`); `cancel()`
    coordinates with the in-flight prompt to return `stopReason: "cancelled"`;
    `PromptResponse.userMessageId` is echoed from the request;
    `InitializeResponse.agentInfo` is now advertised as
    `{ name: "bodhi-pi", version: <BODHI_PI_VERSION> }`;
    `SessionInfo.updatedAt` is real (bumped on every `SessionStore.append()`,
    sorted desc); `listSessions.nextCursor` is omitted instead of `null`.
  - **Source structure:** dead `src/core/agent-session.ts` wrapper deleted;
    `acp/agent.ts` split into `agent.ts` + `notifications.ts` + `constants.ts`;
    three `subscribe()` calls in `prompt()` consolidated into one;
    structural `as` casts in message helpers replaced with typed
    discrimination on pi-ai's `Message` role union; session-store
    implementation types (`SessionEntry`, `SessionInfo`, `SessionRecord`,
    `ListSessionsRequest`, `ListSessionsResult`) hidden from `src/index.ts`;
    `cursor` parameter dropped from `createInMemorySessionStore.list`
    with a JSDoc clarification on `SessionStore.list` for disk-backed
    impls; class-level JSDoc on `BodhiPiAcpAgent` documents the
    three throw conventions.
  - **Tool DRY:** new `src/tools/_accumulate.ts` with
    `accumulateBounded` + `truncationFooter`; `ls`, `find`, `grep`
    refactored to feed string generators into the helper; truncation
    footer normalised to `[Truncated: showing N of M items; <reason>]`;
    `FIND_MAX_RESULTS` renamed to `FIND_MAX_MATCHES`; JSDoc on
    `tools/limits.ts` clarifies that `_MAX_BYTES` constants cap output.
  - **Test architecture:** seven shared helpers extracted under
    `test/helpers/` (`notifications`, `acp-constants`, `env`,
    `acp-narrow`, `tool-call-asserts`, `faux-script`, `harness`);
    four divergent harness factories collapsed into one
    `createTestHarness({ models, sessionStore?, filesystem?,
    systemPrompt?, getApiKey? })`; `vitest.e2e.config.ts` now
    `mergeConfig`s the base config; brittle e2e assertion at
    `e2e/fs.e2e.ts:86` loosened (substring + structural exists check);
    NUL byte in the binary-skip test seed made explicit via
    `String.fromCharCode(0)`.
  - **Coverage:** four new co-located unit-test files —
    `src/filesystem/in-memory-filesystem.test.ts` (15 cases for the
    full error contract + happy paths), `src/tools/walk.test.ts`
    (7 cases for skip-list, `maxEntries`, `signal.aborted`),
    `src/tools/index.test.ts` (`resolvePath` + `toolKindFor`
    exhaustiveness), `src/acp/notifications.test.ts` (23 cases covering
    `extractText`, `extractToolCalls`, `agentToolContentForAcp`,
    `formatLocationHint`, `mapStopReason`, type guards). Plus 10 new
    integration tests in `test/fs.test.ts` covering `read`
    offset/limit + continuation marker, `read`/`grep`/`ls` byte
    truncation, `grep` line-length truncation, multiple tool calls in
    one prompt, tool-failure replay on `session/load`, and the
    factory-level negative paths.
  - **`BodhiPiConfig.systemPrompt?: string`** — optional config-time
    system prompt threaded into every session's `initialState.systemPrompt`.
    Mirrors coding-agent's pattern: NOT persisted as a session entry; on
    `session/load` and `session/resume` the current config's value is
    reapplied. Hosts that want layered composition compose the string
    client-side and pass the result. Backed by two new integration
    tests verifying threading + reapplication on load.
  - **Docs:** README now has a Usage section showing end-to-end host
    wiring; every `BodhiPiConfig` field's JSDoc consistently calls out
    "Mandatory; no default fallback." (or describes the optional
    semantics for `systemPrompt`).
  - Test count: 27 → 94 integration; e2e unchanged at 6.

- M3.1 — Filesystem interface + 6 built-in FS tools (`read`, `write`, `edit`, `ls`, `find`, `grep`). Adds mandatory host-injected `BodhiPiConfig.filesystem: Filesystem` (no default fallback) and ships `createInMemoryFilesystem()` as a public reference helper. Tools are always registered per session and route every FS call through the injected `Filesystem`. `find` and `grep` are pure-JS (no `fd` / `rg` shell-out) and use `picomatch` for glob matching. Tool execution surfaces over the wire as ACP `tool_call` (start) / `tool_call_update` (completion) `session/update` notifications. `session/load` now replays persisted tool calls inline with user/agent message chunks (resolves the deferred-from-M2.1 tool replay path). New deps: `typebox` (^1.1.24) and `picomatch` (^4.0.4). We deliberately do **not** implement ACP `fs/read_text_file` / `fs/write_text_file` — those are a separate client-mediated FS mechanism, orthogonal to bodhi-pi's host-injected `Filesystem`.
  - 13 new integration tests in `test/fs.test.ts` driven via pi-ai's `registerFauxProvider` (in-process scripted assistant messages with `fauxToolCall`), plus 2 new e2e tests in `e2e/fs.e2e.ts` against real Haiku.

- M2.1 — Basic session persistence (persist · load · resume · list · close) over ACP. Introduces a mandatory host-injected `BodhiPiConfig.sessionStore: SessionStore` (no default fallback). Ships `createInMemorySessionStore()` as a public reference helper. The agent now advertises `loadSession`, `sessionCapabilities.list`, `sessionCapabilities.resume`, `sessionCapabilities.close` capabilities, plus `_meta["bodhi-pi"].sessionDelete: true` for the custom extension.
  - `session/load` performs the full ACP-spec history replay via `user_message_chunk` / `agent_message_chunk` notifications, then returns the active model in `configOptions`.
  - `session/resume` rehydrates the session without replaying history (per ACP).
  - `session/list` filters by cwd and returns ACP-shaped `SessionInfo` entries (`updatedAt` derived from createdAt).
  - `session/close` releases active runtime resources only — drops the live pi-agent-core Agent from the in-process cache while persisted data remains; per the ACP `session/close` RFD a subsequent `session/load(sameId)` re-hydrates and replays.
  - `_bodhi-pi/session/delete` (custom extension method, `_`-prefixed per ACP `extensibility.mdx`) permanently removes a session from the store.
  - `session/prompt` now refuses with a JSON-RPC error if the session is not in the in-process cache, forcing explicit `session/load` after `session/close`.
  - Persistence triggers: each `pi-agent-core` `message_end` event appends a `SessionMessageEntry`; each `setSessionConfigOption(model)` appends a `ModelChangeEntry`. On `session/load`/`session/resume`, the agent restores the latest model from history before rehydrating messages.
  - Tests: `chat.test.ts` extended to 8 integration tests (baseline single-prompt, model switch, persist+load, list+filter, close-keeps-data, model-persists-across-load, resume-without-replay, delete). `chat.e2e.ts` extended to 4 e2e tests with one new multi-turn context-retention test against real Haiku.

- M1.3 — Per-session model switching over ACP. `BodhiPiConfig` now takes `models: Model<Api>[]` plus `defaultModelId: string`. `session/new` advertises the registered models as a `SessionConfigOption` (`id: "model"`, `category: "model"`, `type: "select"`); the host switches the active model via the stable `session/setSessionConfigOption` method. The next prompt routes to the new model automatically (pi-agent-core reads `state.model` per turn). Renamed `simple_chat.{test,e2e}.ts` → `chat.{test,e2e}.ts` and extended both with multi-model coverage.

### Changed
- M1.2 — bodhi-pi now speaks ACP. Public API replaces `createAgentSession` with `createBodhiPiAgent(config)`, a factory producing the `(conn) => Agent` callback consumed by `@agentclientprotocol/sdk`'s `AgentSideConnection`. `createAgentSession` is no longer exported (kept internal). Tests drive the agent via ACP's `initialize` → `session/new` → `session/prompt` flow over in-process paired `TransformStream`s. Streaming: `pi-agent-core` `text_delta` events are forwarded as `agent_message_chunk` notifications. Subprocess (stdio) transport intentionally deferred to a later milestone.

### Added
- M1.1 — Initial bootstrap. `createAgentSession` wraps `pi-agent-core`'s `Agent` for a single-prompt round-trip with Anthropic and OpenAI providers, with `baseUrl` override to support OpenAI-compatible endpoints (e.g. aimock). Integration tests against aimock; e2e tests against real Haiku and gpt-5-mini under `npm run test:e2e`.
