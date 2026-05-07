# Changelog

## [Unreleased]

### Added
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
