# Changelog

## [Unreleased]

### Added
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
