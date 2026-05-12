# Phase I — Model & provider management

**Read first:** `ai-docs/prompts/process.md` (working rules + retrospective)
AND `ai-docs/prompts/group-0-upstream-alignment.md` (Phase 0 should land
first — `prepareNextTurn` adoption affects how mid-run thinking-level
swaps are wired).
**Reference impl:** `packages/coding-agent/src/core/model-registry.ts`,
`packages/coding-agent/src/core/auth-storage.ts`,
`packages/coding-agent/src/core/settings-manager.ts`.
**Current state:** `packages/bodhi-pi/PARITY.md`.
**Source intent:** `ai-docs/parity-post-extension.md` §3.3.

> **Upstream context (2026-05-11):** pi-agent-core 0.74 added
> `AgentLoopConfig.prepareNextTurn?: (ctx) => { context?, model?,
> thinkingLevel? } | undefined` — fires after each `turn_end` and lets the
> caller swap model/thinking/context for the next turn within the same
> `loop()` call. If Phase 0 adopts it, outcome #1 ("set thinking level
> per session") and #6 ("dynamic registry / mid-run swaps") get a cleaner
> wiring path than mutating `Agent.state` between external `loop()` calls.
> Also note: `KnownProvider` gained `"together"` and
> `AnthropicMessagesCompat` gained `sendSessionAffinityHeaders` +
> `supportsCacheControlOnTools` — additive, no breaking change for this
> phase's design.

---

## Functional outcomes

After this phase a user of any bodhi-pi reference host should observe:

1. **Reasoning models honour a thinking level.** A user can set the active
   session's thinking level to `off / minimal / low / medium / high / xhigh`
   for a reasoning-capable model (Anthropic, certain OpenAI models, etc.).
   The model's response uses the requested reasoning depth; switching to a
   non-reasoning model clamps cleanly.
2. **A slash / RPC verb cycles the thinking level** (mirroring coding-agent's
   keybinding). Hosts surface the current level somewhere observable
   (status bar, `/session` stats, an existing extension method response).
3. **Hosts can configure per-provider retry/timeout** instead of inheriting
   pi-ai defaults silently. A failing request retries up to N times with
   the configured backoff; a too-long request aborts with a sensible
   error.
4. **API keys + OAuth tokens persist somewhere durable**, not just env
   vars. coding-agent uses `~/.claude/auth.json` with file-locking + OAuth
   refresh. Decide for bodhi-pi: host-injected `AuthStore` interface vs
   continuing to punt to env vars (host concern). Either way, the OAuth
   refresh path lands in core so hosts share it.
5. **OAuth login flow** works for at least one provider (start with the
   Anthropic Claude.ai login path). User runs `/login`; bodhi-pi opens
   the auth flow; tokens persist; subsequent sessions reuse them and
   refresh transparently.
6. **Model registry is dynamic** for providers that expose a list endpoint
   (OpenAI, Anthropic, Google). Hosts can opt into "fetch available
   models from the provider on init" instead of hard-coding a static
   `Model[]`.
7. **`/login`, `/logout`, scoped-models cycle** slash commands land in all
   five hosts. `/login <provider>` triggers the flow; `/logout <provider>`
   clears stored creds; scoped-models cycle (the `Ctrl+P`-equivalent
   coding-agent has) iterates filtered subsets in `/model`.

Each is observable through the chat UI / ACP surface. Be smart about
testing: most of these (auth, OAuth, dynamic model fetch) involve external
HTTP calls — design the faux/mock surfaces carefully so per-host e2e
doesn't depend on third-party services.

---

## Rough directional pointers

- **Thinking levels:** pi-ai exports `ThinkingLevel` (`off / minimal / low /
  medium / high / xhigh`) and `Agent.state.thinkingLevel`. bodhi-pi's
  `setSessionConfigOption` (`packages/bodhi-pi/src/acp/agent.ts`) already
  knows about `MODEL_CONFIG_ID`; add a `THINKING_CONFIG_ID` alongside.
  ACP `setSessionConfigOption("thinking", ...)` already supports it on
  the wire.
- **Retry/timeout:** look at pi-ai's `SimpleStreamOptions` and the
  `AgentLoopConfig` shape; settings probably belong in
  `BodhiPiConfig.providerOptions` keyed by provider, with sensible
  defaults.
- **Auth storage:** read `packages/coding-agent/src/core/auth-storage.ts`
  carefully. The big design fork is host-concern vs core-interface. If
  core: define an `AuthStore` interface mirroring `SessionStore`'s shape
  (host-injected, with Node and browser adapters). If host: per-host
  encrypted storage that wraps `getApiKey`.
- **OAuth refresh:** coding-agent has the Anthropic Claude.ai flow
  working; port the refresh logic into a reusable helper. The interactive
  login part is host-specific (open a browser tab, capture redirect).
- **Dynamic model registry:** today `BodhiPiConfig.models` is a static
  array. Add an async resolution path. Look at how
  `setSessionConfigOption("model", ...)` already accepts arbitrary ids;
  the question is which models the `/model` picker shows.
- **Slash commands:** `/login`, `/logout`, `/model` extensions land in
  every host's slash dispatcher. The scoped-models cycle is a `/model
  cycle` or similar; confirm shape with the user.

---

## Test signals to design for

Functional, blackbox. Each test designs for the smallest possible
external dependency surface:

- **Thinking levels:**
  - Core faux test: setSessionConfigOption("thinking", "high"); next
    prompt's payload (captured via faux provider's context-introspection
    lambda) has the right thinking-level flag.
  - Real-LLM core e2e: a reasoning model responds to a math problem; with
    `thinking: "high"` the response includes more reasoning markers than
    `off`. Compare lengths or look for thinking content blocks.
  - Per-host e2e: `/thinking high`, `/session` shows the level, run a
    prompt, verify response. Use `gpt-4o-mini` doesn't have thinking
    levels — pick a model that does (e.g., `claude-haiku-4.5` if
    `ANTHROPIC_API_KEY` available; faux otherwise).
- **Retry/timeout:** faux provider with rigged 500 responses for the
  first N attempts then success; assert the agent retries the configured
  count. Faux provider with rigged 10s delay; assert timeout fires.
- **Auth storage:** faux `AuthStore` impl in tests; assert `getApiKey`
  reads from it before falling back to env. Real e2e tests stay on env
  vars (cheaper, no flakiness).
- **OAuth:** mocked OAuth server (or a faux refresh callback);
  test refresh-on-expiry without touching real OAuth.
- **Dynamic registry:** mocked provider list endpoint; assert `/model`
  output includes the fetched ids.
- **`/login` / `/logout`:** mocked flow callbacks; assert system messages
  reflect success/failure.

Smart-about-testing means: faux/mocked HTTP for everything that would
otherwise hit production OpenAI / Anthropic / Google. Real-LLM only for
the one behaviour you cannot fake (thinking level affecting response
shape).

---

## Open questions to confirm before coding

This phase has more architectural forks than others — likely 3–4 rounds
of `AskUserQuestion`:

- **Auth: host concern vs core `AuthStore`?** Recommend host concern for
  the bulk; share an OAuth refresh helper in core.
- **Thinking levels: a separate `THINKING_CONFIG_ID` or augment the
  existing `MODEL_CONFIG_ID`?** ACP supports many config options;
  separate id is cleaner.
- **OAuth providers to support:** start with one (Anthropic), or build
  the framework for many and stub the rest?
- **Dynamic model fetch:** opt-in per host, or default-on with cache?
- **Scoped-models cycle:** coding-agent's `Ctrl+P` keybinding doesn't map
  cleanly to slash. `/model cycle`, `/model next`, or `/models <filter>`?
- **Slash naming:** `/login <provider>` vs `/auth login <provider>` vs
  letting providers ship the slash.

---

## Boundaries

In scope (all of §3.3):

- Thinking levels per model with validation/clamping
- Cycle-thinking-level keybinding/RPC verb (as a slash command)
- Per-provider retry/timeout settings
- Auth credential storage (API keys + OAuth)
- OAuth refresh + at least one login flow
- Model registry: dynamic per-provider model fetch
- `/login`, `/logout`, scoped-models cycle

Explicitly out of scope:

- New first-class ACP methods for any of the above (everything stays
  inside the `setSessionConfigOption` + `_bodhi-pi/<area>/<verb>` extension
  conventions per `process.md`).
