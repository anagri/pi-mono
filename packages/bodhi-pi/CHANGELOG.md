# Changelog

## [Unreleased]

### Changed
- M1.2 — bodhi-pi now speaks ACP. Public API replaces `createAgentSession` with `createBodhiPiAgent(config)`, a factory producing the `(conn) => Agent` callback consumed by `@agentclientprotocol/sdk`'s `AgentSideConnection`. `createAgentSession` is no longer exported (kept internal). Tests drive the agent via ACP's `initialize` → `session/new` → `session/prompt` flow over in-process paired `TransformStream`s. Streaming: `pi-agent-core` `text_delta` events are forwarded as `agent_message_chunk` notifications. Subprocess (stdio) transport intentionally deferred to a later milestone.

### Added
- M1.1 — Initial bootstrap. `createAgentSession` wraps `pi-agent-core`'s `Agent` for a single-prompt round-trip with Anthropic and OpenAI providers, with `baseUrl` override to support OpenAI-compatible endpoints (e.g. aimock). Integration tests against aimock; e2e tests against real Haiku and gpt-5-mini under `npm run test:e2e`.
