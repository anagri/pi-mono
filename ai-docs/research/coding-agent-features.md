# bodhi-pi — Feature Port Plan from coding-agent

**Status:** Plan, ready for review
**Date:** 2026-05-07
**Goal:** Reach **functional parity** with `packages/coding-agent` for the features that make sense in an embeddable, host-mediated, ACP-speaking agent. Ship iteratively under TDD with both unit tests and ACP-driven e2e tests.

Companion documents:
- [`embeddable-agent-design.md`](./embeddable-agent-design.md) — architecture / interfaces / public API
- [`../plans/deferred.md`](../plans/deferred.md) — items revisited later
- [`../plans/skipped.md`](../plans/skipped.md) — items deliberately out of scope

---

## 1. Guiding principles

1. **Functional parity, not technical similarity.** A feature ports if its *user-visible value* survives the architectural shift. We are not transplanting code; we are re-implementing intent.
2. **The agent owns reasoning. The host owns I/O and UX.** Anything that touches a TTY, renders a widget, owns a keybinding, or paints colour belongs to the host. bodhi-pi never does any of these.
3. **Every feature lands behind a passing test pair: a unit test and an ACP-driven e2e test.** Tests are written first; implementation derives from them.
4. **e2e tests use the real model** (Haiku via `pi-ai`) — not a mock — so we catch real LLM behaviour. Tests assert side-effects and event shapes that are stable across runs, not exact text.
5. **Tests must run concurrently.** Each test owns an isolated bodhi-pi process, an isolated filesystem root, an isolated session store, and isolated auth state. No global state, no shared sockets.
6. **v1 = parity for portable features.** Sub-agents, plan mode, and first-party MCP are explicitly **v1.1** — they are *new* features, not ports, and gate on functional parity first.

---

## 2. Feature port matrix

The catalogue from coding-agent contains ~150 distinct features. Each is tagged with a disposition:

- 🟢 **v1 port** — must ship in v1
- 🟡 **v1.1** — ships after parity, often as a new first-party capability
- 🔵 **host** — out of agent core; host implements per its UI
- 🔴 **skip** — TUI-coupled or tightly bound to coding-agent's terminal model; not relevant to bodhi-pi

### A. Core agent loop

| Feature                               | Port | Notes                                                                       |
| ------------------------------------- | ---- | --------------------------------------------------------------------------- |
| Prompt submission                     | 🟢 v1 | ACP `session/prompt`. Foundational.                                         |
| Steering messages (queue mid-turn)    | 🟢 v1 | ACP-friendly. Implement as queued prompt with `streamingBehavior: "steer"`. |
| Follow-up messages (queue post-turn)  | 🟢 v1 | Same plumbing as steer with different semantics.                            |
| Agent abort / cancel                  | 🟢 v1 | ACP `session/cancel`.                                                       |
| Auto-retry on transient errors        | 🟢 v1 | Network-layer feature; emits ACP `session/update` retry events.             |
| Configurable retry attempts / backoff | 🟢 v1 | Settings-driven.                                                            |

### B. Built-in tools

| Feature                | Port | Notes                                                                     |
| ---------------------- | ---- | ------------------------------------------------------------------------- |
| `read`                 | 🟢 v1 | Routes through injected `Filesystem.readTextFile`.                        |
| `write`                | 🟢 v1 | Routes through `Filesystem.writeTextFile`.                                |
| `edit`                 | 🟢 v1 | Diff-based; uses `readTextFile` + `writeTextFile`.                        |
| `bash`                 | 🟢 v1 | Routes through injected `Terminal`. Registered only if Terminal injected. |
| `grep`                 | 🟢 v1 | Pure FS via `list` + `readTextFile`.                                      |
| `find`                 | 🟢 v1 | Pure FS via `list` + `stat`.                                              |
| `ls`                   | 🟢 v1 | Pure FS via `list`.                                                       |
| Tool result streaming  | 🟢 v1 | ACP `session/update` chunks.                                              |
| Tool result truncation | 🟢 v1 | Configurable cap; full result available via separate fetch.               |
| Shell command prefix   | 🟢 v1 | Config option, applied inside bash tool.                                  |

### C. Sessions

| Feature                                  | Port   | Notes                                                                                   |
| ---------------------------------------- | ------ | --------------------------------------------------------------------------------------- |
| Auto-save sessions                       | 🟢 v1   | Via injected `SessionStore`.                                                            |
| Session continuation (most recent)       | 🟢 v1   | `SessionStore.list` + `loadSession`.                                                    |
| Session list / picker support            | 🟢 v1   | Agent exposes `sessionStore.list(...)` over ACP `session/list`; host renders.           |
| Ephemeral mode (no persistence)          | 🟢 v1   | In-memory `SessionStore` impl.                                                          |
| Fork session from prior message          | 🟢 v1   | `SessionStore.fork`. ACP method via `session/new` with `parentSessionId`+`fromEntryId`. |
| Clone session (active branch)            | 🟢 v1   | `SessionStore.clone`.                                                                   |
| Session naming / labels                  | 🟢 v1   | `SessionStore` metadata.                                                                |
| Session info (stats: tokens, cost, msgs) | 🟢 v1   | Computed from store; surfaced as ACP capability.                                        |
| Session tree visualisation               | 🔵 host | Tree data exposed via API; rendering is host's job.                                     |
| Tree filter modes                        | 🔵 host | Pure UI concern.                                                                        |
| Tree branch labelling                    | 🟢 v1   | Data layer (label entries); UI is host.                                                 |
| Branch summarisation on switch           | 🟢 v1   | Compaction-adjacent feature; same engine.                                               |

### D. Models & providers

| Feature                                                                           | Port   | Notes                                                                                                   |
| --------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------- |
| Built-in provider list (Anthropic, OpenAI, Google, DeepSeek, Mistral, Groq, etc.) | 🟢 v1   | Inherited from `pi-ai`.                                                                                 |
| OAuth login / logout                                                              | 🟢 v1   | Surfaced as ACP `authenticate` flow. Host handles browser/redirect; agent stores token via `ModelAuth`. |
| API-key auth (env var, file)                                                      | 🟢 v1   | Default `ModelAuth` writes to `~/.bodhi-pi/auth.json` (0600). Host can override.                        |
| Model selection / switching                                                       | 🟢 v1   | Per-session setting; ACP `session/set_config_option`.                                                   |
| Model cycling shortcut                                                            | 🔵 host | Host owns keybindings. Agent exposes `cycleModel()`.                                                    |
| Custom model registry                                                             | 🟢 v1   | `~/.bodhi-pi/models.json` discovery via `ResourceLoader`.                                               |
| Thinking-level control                                                            | 🟢 v1   | Per-session config; ACP option.                                                                         |
| Thinking budget limits                                                            | 🟢 v1   | Settings-driven.                                                                                        |
| Provider compat overrides                                                         | 🟢 v1   | Same JSON shape coding-agent uses.                                                                      |
| Custom provider via extension                                                     | 🟢 v1   | Extension API: `ext.registerProvider(...)`. Pure JS.                                                    |
| Anthropic extra-usage warning                                                     | 🟢 v1   | Permission interface — agent emits a permission request; host renders.                                  |

### E. Skills & resource loading

| Feature                                       | Port   | Notes                                                   |
| --------------------------------------------- | ------ | ------------------------------------------------------- |
| Skill discovery (global + project + packages) | 🟢 v1   | `ResourceLoader` over injected `Filesystem`.            |
| Skill invocation `/skill:name`                | 🟢 v1   | Slash-command resolution exposed as a built-in command. |
| Skill arguments                               | 🟢 v1   | Same parsing rules as coding-agent.                     |
| `SKILL.md` format                             | 🟢 v1   | Verbatim — no breaking changes for skill authors.       |
| Skill front-matter in system prompt           | 🟢 v1   | Same expansion logic.                                   |
| Context files (AGENTS.md / CLAUDE.md walk)    | 🟢 v1   | FS-driven; uses injected `Filesystem`.                  |
| `SYSTEM.md` system-prompt override            | 🟢 v1   | Project-level discovery.                                |
| `APPEND_SYSTEM.md` append                     | 🟢 v1   | Same.                                                   |
| Prompt templates (`/command` files)           | 🟢 v1   | `~/.bodhi-pi/prompts/` and `.bodhi-pi/prompts/`.        |
| Template arguments (`$1`, `$@`, slices)       | 🟢 v1   | Same substitution grammar.                              |
| Theme selection                               | 🔵 host | Theme is rendering. Host owns.                          |

### F. Extensions

| Feature                                                      | Port   | Notes                                                                                                        |
| ------------------------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------ |
| Extension loading                                            | 🟢 v1   | **Standalone JS only**, dynamic `import()` per host runtime. No jiti, no TS at runtime.                      |
| Event subscription (`ext.on(...)`)                           | 🟢 v1   | Same event names where they exist agent-side.                                                                |
| Tool registration (`ext.registerTool`)                       | 🟢 v1   | Extension tools route through injected interfaces too.                                                       |
| Command registration (`ext.registerCommand`)                 | 🟢 v1   | Slash-command system.                                                                                        |
| UI dialog (`ctx.ui.select` / `confirm` / `input` / `editor`) | 🟢 v1   | Mapped to ACP `session/request_permission` and a generic `session/request_input` notification. Host renders. |
| Notify / fire-and-forget                                     | 🟢 v1   | ACP `session/update` event with kind "notify".                                                               |
| Status bar setter                                            | 🔵 host | Host concern.                                                                                                |
| Widget display                                               | 🔵 host | Host concern.                                                                                                |
| Tool-call interception                                       | 🟢 v1   | Pre-execution hook.                                                                                          |
| Async factory init                                           | 🟢 v1   | Same lifecycle.                                                                                              |
| Custom provider registration                                 | 🟢 v1   | (See section D.)                                                                                             |
| Session persistence from extension                           | 🟢 v1   | `SessionStore.appendCustomEntry`.                                                                            |
| Inter-extension event bus                                    | 🟢 v1   | In-process pub/sub.                                                                                          |

### G. Modes

| Feature                      | Port   | Notes                                            |
| ---------------------------- | ------ | ------------------------------------------------ |
| Interactive TUI mode         | 🔴 skip | Hosts implement their own interactive UI.        |
| Print mode (one-shot)        | 🔵 host | Trivial host wrapper around `agent.prompt(...)`. |
| RPC mode (JSON over stdio)   | 🟢 v1   | Replaced by ACP wire adapter.                    |
| JSON event-stream mode       | 🔵 host | Host streams `onSessionUpdate` events to stdout. |
| Piped stdin into prompt      | 🔵 host | Host concern.                                    |
| Mode selection via CLI flags | 🔵 host | Host CLI parsing.                                |

### H. Configuration & settings

| Feature                                                              | Port   | Notes                                                |
| -------------------------------------------------------------------- | ------ | ---------------------------------------------------- |
| Global settings (`~/.bodhi-pi/settings.json`)                        | 🟢 v1   | Loaded via `ResourceLoader` + injected `Filesystem`. |
| Project settings (`.bodhi-pi/settings.json`)                         | 🟢 v1   | Same merge semantics as coding-agent.                |
| Settings UI                                                          | 🔵 host | Host renders; agent exposes get/set.                 |
| Thinking-budget config                                               | 🟢 v1   | (See D.)                                             |
| Compaction settings (reserve / keep-recent)                          | 🟢 v1   | (See I.)                                             |
| Retry settings                                                       | 🟢 v1   | (See A.)                                             |
| Model-cycling list                                                   | 🟢 v1   | Data; cycling shortcut is host concern.              |
| Shell path override                                                  | 🟢 v1   | Bash-tool config.                                    |
| Bash command prefix                                                  | 🟢 v1   | Bash-tool config.                                    |
| NPM command override                                                 | 🟢 v1   | Bash-tool config.                                    |
| Session directory override                                           | 🟢 v1   | Default `SessionStore` impl honours it.              |
| Quiet startup / editor padding / autocomplete size / hardware cursor | 🔴 skip | TUI-only.                                            |

### I. Compaction & token management

| Feature                                                   | Port | Notes                                     |
| --------------------------------------------------------- | ---- | ----------------------------------------- |
| Auto-compaction on threshold                              | 🟢 v1 | Triggered inside agent loop.              |
| Manual `/compact [instructions]`                          | 🟢 v1 | ACP method or built-in slash command.     |
| Reserve / keep-recent budgets                             | 🟢 v1 | Settings.                                 |
| Split-turn handling                                       | 🟢 v1 | Port logic from `compaction.md`.          |
| `CompactionEntry` format                                  | 🟢 v1 | Same shape; persisted via `SessionStore`. |
| File-operation tracking across compactions                | 🟢 v1 | Cumulative metadata.                      |
| Branch summarisation on switch                            | 🟢 v1 | (See C.)                                  |
| Extension `session_before_compact` hook                   | 🟢 v1 | Same hook surface.                        |
| Message serialisation rules (truncate tool results to 2k) | 🟢 v1 | Verbatim.                                 |

### J. Permissions & safety

| Feature                              | Port | Notes                                                |
| ------------------------------------ | ---- | ---------------------------------------------------- |
| Tool-call interception               | 🟢 v1 | (See F.)                                             |
| Confirmation prompts (write / shell) | 🟢 v1 | ACP `session/request_permission`.                    |
| Diff preview before write            | 🟢 v1 | Agent emits diff in permission detail; host renders. |
| Anthropic extra-usage warning        | 🟢 v1 | (See D.)                                             |

### K. Streaming & observability

| Feature                                                                                      | Port | Notes                                                                                 |
| -------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------- |
| Event streaming (`agent_start`, `message_update`, `tool_execution_*`, `turn_*`, `agent_end`) | 🟢 v1 | All flow through ACP `session/update` notifications. Event payload shapes documented. |
| Text streaming (`text_delta`)                                                                | 🟢 v1 | Same.                                                                                 |
| Thinking streaming (`thinking_delta`)                                                        | 🟢 v1 | Same, when thinking enabled.                                                          |
| Tool execution streaming                                                                     | 🟢 v1 | Same.                                                                                 |
| Turn / agent lifecycle events                                                                | 🟢 v1 | Same.                                                                                 |
| Queue update events                                                                          | 🟢 v1 | When steer/follow-up queue changes.                                                   |
| Compaction events                                                                            | 🟢 v1 | Same.                                                                                 |
| Auto-retry events                                                                            | 🟢 v1 | Same.                                                                                 |
| Token-usage / cost / context-window data                                                     | 🟢 v1 | Available via session info; rendering is host.                                        |

### L. Image / multimodal input

| Feature                              | Port   | Notes                       |
| ------------------------------------ | ------ | --------------------------- |
| Image input                          | 🟡 v1.1 | Deferred per `deferred.md`. |
| Auto-resize / blocking               | 🟡 v1.1 | Same.                       |
| Inline display in terminal           | 🔴 skip | TUI-only.                   |
| Attachment metadata (id, mime, size) | 🟡 v1.1 | When images arrive.         |

### M. MCP support

| Feature                                       | Port   | Notes                                    |
| --------------------------------------------- | ------ | ---------------------------------------- |
| MCP **client** (attach external tool servers) | 🟡 v1.1 | First-party in v1.1, per user direction. |
| MCP server (expose bodhi-pi as MCP)           | 🟡 v1.1 | Stretch. Not committed.                  |

### N. Misc / quality-of-life

| Feature                                                                                                                                                                             | Port                | Notes                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File reference `@`, path completion (Tab), multi-line input, external editor (Ctrl+G), shell shorthand `!cmd`                                                                       | 🔴 skip              | Host UI concerns.                                                                                                                                                                                                                                                       |
| Slash commands                                                                                                                                                                      | 🟢 v1                | Built-in commands list + extension-registered commands; resolution is agent-side, presentation is host.                                                                                                                                                                 |
| Built-in slash command set (`/login`, `/logout`, `/model`, `/resume`, `/new`, `/name`, `/session`, `/fork`, `/clone`, `/compact`, `/copy`, `/export`, `/share`, `/reload`, `/quit`) | partial — see notes | 🟢 v1: `/login`, `/logout`, `/model`, `/resume`, `/new`, `/name`, `/session`, `/fork`, `/clone`, `/compact`, `/reload`, `/export`. 🔵 host: `/copy`, `/quit`, `/hotkeys`, `/changelog`, `/settings`, `/tree`, `/share` (host implements; some agent endpoints back them). |
| Version check / `PI_SKIP_VERSION_CHECK`                                                                                                                                             | 🔵 host              | Host CLI concern. Bodhi-pi has no startup banner.                                                                                                                                                                                                                       |
| Cache retention env var                                                                                                                                                             | 🟢 v1                | Honour `BODHI_CACHE_RETENTION=long`.                                                                                                                                                                                                                                    |
| Export to HTML                                                                                                                                                                      | 🟢 v1                | Pure transform of session data; lives in agent SDK as `exportToHtml(sessionId)`.                                                                                                                                                                                        |
| Share to GitHub gist                                                                                                                                                                | 🔵 host              | Network egress + auth handled by host.                                                                                                                                                                                                                                  |
| Startup banner                                                                                                                                                                      | 🔴 skip              | Host.                                                                                                                                                                                                                                                                   |
| Editor border / bash mode / cursor / cwd display                                                                                                                                    | 🔴 skip              | TUI-only.                                                                                                                                                                                                                                                               |

### O. Headless / SDK surface

| Feature                                                        | Port   | Notes                                        |
| -------------------------------------------------------------- | ------ | -------------------------------------------- |
| `createBodhiPiAgent()` factory (replaces `createAgentSession`) | 🟢 v1   | Public entry.                                |
| `BodhiPiAgent` interface                                       | 🟢 v1   | (See design doc.)                            |
| Runtime / fork / switch APIs                                   | 🟢 v1   | Same shape as `AgentSessionRuntime`.         |
| Model registry SDK                                             | 🟢 v1   | Same surface.                                |
| Auth storage SDK                                               | 🟢 v1   | Same surface; default impl + override.       |
| Custom tools SDK                                               | 🟢 v1   | Same TypeBox-based schema.                   |
| `DefaultResourceLoader`                                        | 🟢 v1   | Filesystem-backed via injected `Filesystem`. |
| Settings manager                                               | 🟢 v1   | Same get/set/listen surface.                 |
| Session manager                                                | 🟢 v1   | Renamed `SessionStore`.                      |
| Extension API                                                  | 🟢 v1   | (See F.)                                     |
| `InteractiveMode` class                                        | 🔴 skip | TUI.                                         |
| `runPrintMode` / `runRpcMode`                                  | 🔵 host | Host wrappers.                               |
| Event subscription (`session.subscribe`)                       | 🟢 v1   | `agent.onSessionUpdate(...)`.                |

### v1.1 — new first-party features (not in coding-agent)

These are explicitly *additions* in bodhi-pi, gated on functional parity:

- **Sub-agents** — agent-spawned child sessions for delegation. New `SubAgent` interface; ACP method `session/spawn_subagent`.
- **Plan mode** — agent commits to a plan before tool execution; user/host approves/edits. New event kinds and a planning loop variant.
- **First-party MCP client** — attach external MCP servers via config; their tools merged with built-ins.

These ride on top of v1 architecture; they do not require structural changes to core if v1 lands cleanly.

---

## 3. Test architecture

### 3.1 Layers

| Layer                     | Runner               | Speed        | Purpose                                                                                                                                                                                                                                      |
| ------------------------- | -------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Unit**                  | vitest               | <50 ms each  | Pure logic: parsers, slash-command resolution, compaction-prep, settings merge, schema validation. No I/O, no model, no LLM.                                                                                                                 |
| **Conformance**           | vitest, parametrised | <500 ms each | One suite per interface (introduced as features demand them), run against every concrete impl. No LLM.                                                                                                                                       |
| **Integration (aimock)**  | vitest               | 1–3 s each   | bodhi-pi core wired against in-memory hosts; LLM provider points at a per-test [aimock](https://github.com/CopilotKit/aimock) instance with scripted fixtures (text, tool calls, multi-turn). Validates orchestration, fast & deterministic. |
| **e2e (ACP, real model)** | vitest               | 5–30 s each  | Full bodhi-pi process spawned per test, driven via `@agentclientprotocol/sdk` client. Uses real **Haiku** or **openai-mini** family models via `pi-ai`. Asserts side-effects (file content, event ordering, tool-call structure).            |

### 3.2 Test isolation primitives

To run e2e tests concurrently, every test gets:

```ts
// pseudocode — actual implementation in bodhi-pi/test/harness/
interface TestEnv {
  tmpRoot: string;                    // unique temp dir per test
  fs: Filesystem;                     // node-fs rooted at tmpRoot
  terminal?: Terminal;                // node-terminal cwd-pinned to tmpRoot
  sessionStore: SessionStore;         // in-memory or file-backed under tmpRoot/sessions
  modelAuth: ModelAuth;               // pre-loaded with HAIKU_API_KEY only
  permission: Permissioner;           // auto-allow or scripted-policy stub
  agent: BodhiPiAgent;                // in-process binding
  acpClient?: AcpClient;              // optional: spawn process + connect over stdio
}

function withTestEnv(opts: { useAcp?: boolean }): Promise<TestEnv>;
```

**Concurrency invariants:**
- Every `tmpRoot` is unique (`os.tmpdir() + nanoid()`).
- No global mutation of `process.env` after harness boot — all env access in agent goes through injected `host.env`.
- Default `ModelAuth` impl writes to `tmpRoot/.bodhi-pi/auth.json`, not `~/.bodhi-pi/auth.json`, when in test mode (signalled via constructor).
- Each ACP-mode test spawns its own child process — no shared sockets, no shared stdio.
- vitest `concurrent: true` per file; pool size limited by `BODHI_TEST_CONCURRENCY` env.

### 3.3 e2e test recipe (canonical example)

```ts
test.concurrent("write tool persists file via ACP", async () => {
  const env = await withTestEnv({ useAcp: true });

  const sessionId = await env.acpClient.send("session/new", { cwd: env.tmpRoot });
  await env.acpClient.send("session/prompt", {
    sessionId,
    prompt: "Create a file at /hello.txt with the exact content: Hello, world!"
  });

  // Wait for agent_end event
  await env.acpClient.waitFor("agent_end", { sessionId });

  // Side-effect assertion (not text-content assertion — model may phrase differently)
  expect(await env.fs.readTextFile("/hello.txt")).toBe("Hello, world!");

  // Event-shape assertion
  const events = env.acpClient.eventsFor(sessionId);
  expect(events).toContainEventOfKind("tool_execution_start", { tool: "write" });
  expect(events).toContainEventOfKind("tool_execution_end", { tool: "write", success: true });

  await env.dispose();
});
```

**Stability rules for e2e prompts:**
- Always frame the task as a concrete observable: "create file X", "list files containing Y", "replace string A with B in file C".
- Assert **side-effects** (`fs` state, tool-call sequence, terminal exit codes), not exact assistant text.
- Avoid open-ended prompts; the model will improvise text but reliably perform structured actions.
- Tag flaky tests `@flaky` and run them in a smaller pool with retry budget; do not let them gate CI on first run.

### 3.4 Cost / network controls

- e2e suite tagged `online`. Local `pnpm test` runs unit + conformance + integration (aimock) only; `pnpm test:online` adds e2e.
- CI runs `online` on a nightly schedule and on PRs that touch core; regular PRs run unit + conformance + integration.
- API keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) provided by CI secrets; tests injected via `ModelAuth` host binding.
- Default e2e models: `claude-haiku-4-5` and `gpt-5-mini` (or current cheapest). `BODHI_TEST_MAX_TOKENS=1024`, hard kill at 30 s.
- Estimate: ~$0.005 per e2e test × ~200 tests = ~$1 per full nightly run.

### 3.5 Integration testing with aimock

Integration tests use [`@copilotkit/aimock`](https://github.com/CopilotKit/aimock) — a zero-dep mock server that mimics OpenAI, Anthropic, Gemini, and other LLM provider APIs. It supports streaming, tool-call rounds, multi-turn conversations, and record-and-replay against real APIs.

**Pattern per integration test:**

```ts
import { LLMock } from "@copilotkit/aimock";

const mock = new LLMock({ port: 0 });        // pick free port — concurrent-safe
await mock.start();

mock.fixtures.openai.chat([
  { role: "assistant", content: "tuesday" }    // first turn
]);

const env = await withTestEnv({
  llm: { provider: "openai", baseUrl: `${mock.url}/v1`, apiKey: "test-key", model: "gpt-mini" }
});

await env.agent.prompt(sessionId, "Answer in one word: what day comes after Monday?");
expect(env.eventsFor(sessionId).lastTextDelta()).toContain("tuesday");

await mock.stop();
```

**For tool tests, aimock returns scripted tool-call rounds:**

```ts
mock.fixtures.openai.chat([
  // Turn 1: model decides to call `read`
  { role: "assistant", tool_calls: [{ name: "read", arguments: { path: "/notes.txt" } }] },
  // Turn 2: after tool result, model produces final answer
  { role: "assistant", content: "The file contains 42 lines." }
]);
```

Integration tests verify that bodhi-pi's orchestration is correct: tool dispatched, result fed back, next stubbed turn delivered as the assistant message.

**Recording new fixtures:** when adding a new feature, run aimock in `--record` mode against the real provider once, capture the trace, commit the fixture file, switch to replay. Fixtures live under `test/fixtures/aimock/`.

### 3.6 ACP wire compatibility tests

Independent of feature tests:

- Validate every emitted ACP message against the upstream `agent-client-protocol` `schema.json`.
- Round-trip every documented method through `@agentclientprotocol/sdk` as a black-box client.
- These run on every PR (no model required).

---

## 4. Evolutionary milestone plan

We do **no upfront design**. Interfaces, types, and host bindings are introduced **only when a test demands them**. Each milestone is a thin vertical slice: a single user-visible behaviour, written as failing tests first, then made to pass with the smallest possible code, then committed.

### 4.1 Per-milestone rhythm

Every milestone follows the same loop:

1. **Write failing tests** (integration + e2e). The tests are the spec.
2. **Introduce only the types/code needed** to make them compile and pass. New interfaces appear here, not earlier.
3. **Run gate-checks** — full suite green, lint clean, typecheck clean.
4. **Commit** with a message that names the milestone.
5. **Move on.** Refactor opportunistically in the next milestone if the next test demands it.

A milestone produces *one commit*. If a milestone needs more than one commit, split it.

### 4.2 Milestone naming

`M<phase>.<step>` — phases group related capability (1 = bring-up, 2 = sessions, 3 = filesystem, 4 = tools, 5 = skills/extensions, 6 = compaction, 7 = ACP wire, 8 = web/browser hosts, etc.). Steps are the vertical slices inside a phase.

### 4.3 Detailed milestones (first batch)

These are committed below in detail. Subsequent milestones are outlined and refined as we land each batch.

---

#### **M1.1 — First prompt, first response**

**Goal:** prove the agent can be embedded in a test host, accept a prompt, and return a response.

- **Integration test (aimock):**
  - Start an `LLMock` instance on a free port.
  - Configure aimock to return `"tuesday"` as the assistant text for a single OpenAI chat completion.
  - Embed bodhi-pi in test code, point provider at `${mock.url}/v1` with a fake key, hard-code the model.
  - Call `agent.prompt("Answer in one word: what day comes after Monday?")`.
  - Assert: agent's emitted assistant text equals `"tuesday"` (round-tripped from the stub).
- **e2e test (real LLM):**
  - Provider = `anthropic`, model = `claude-haiku-4-5`, key from `ANTHROPIC_API_KEY`.
  - Same prompt.
  - Assert: assistant text contains `"tuesday"` (case-insensitive).

**What this milestone introduces:** `BodhiPiAgent` factory, single-shot prompt method, basic provider config (provider name + base URL + key + model), one event the test waits on (`agent_end`).
**What it does *not* introduce:** sessions, tools, filesystem, terminal, ACP wire, settings, skills.

**Gate, commit.**

---

#### **M1.2 — Switch models across providers**

**Goal:** the host can route consecutive prompts to different providers/models on the same agent instance.

- **Integration test (aimock):**
  - Start two aimock fixtures (or one aimock with two routes): one returning `"Anthropic"`, the other `"OpenAI"`.
  - Configure two model entries: `claude-stub` → aimock-1, `gpt-stub` → aimock-2.
  - Set active model to `claude-stub`; prompt; assert response = `"Anthropic"`.
  - Switch active model to `gpt-stub`; prompt; assert response = `"OpenAI"`.
- **e2e test (real LLMs):**
  - Configure `claude-haiku-4-5` (Anthropic) and `gpt-5-mini` (OpenAI).
  - Prompt: *"In one word, name the company that trained you."*
  - With Anthropic active, assert response contains `"Anthropic"` (case-insensitive).
  - Switch to OpenAI; same prompt; assert response contains `"OpenAI"`.

**What this milestone introduces:** model registry (just enough to hold multiple model definitions), `agent.setModel(modelId)` method, provider dispatch.
**What it does *not* introduce:** persistence of model choice, model-cycling shortcut, custom provider config — those come later if a test needs them.

**Gate, commit.**

---

#### **M2.1 — Sessions persist turns in memory**

**Goal:** a session retains its turns so a follow-up prompt has access to prior context.

- **Integration test (aimock):**
  - Stub aimock to return turn 1 = `"hi"`, turn 2 = `"42"` (regardless of input).
  - Create session. Prompt 1 = `"say hi"`. Prompt 2 = `"what is the answer?"`.
  - After both, fetch session record from `SessionStore`.
  - Assert: store contains 2 user messages and 2 assistant messages, in correct order.
- **e2e test (real LLM):**
  - Create session. Prompt 1 = `"My favourite number is 42. Reply 'noted'."`. Prompt 2 = `"What is my favourite number? Reply with just the number."`.
  - Assert: turn-2 response contains `"42"`. Verifies in-memory persistence is feeding context back into requests.

**What this milestone introduces:** `SessionStore` interface (minimal: `create`, `append`, `load`), in-memory implementation, session id wiring through prompt API. The interface is born here, not before.

**Gate, commit.**

---

#### **M2.2 — List sessions**

**Goal:** the host can enumerate sessions managed by the store.

- **Integration test:** create 3 sessions in one test; call `store.list()`; assert 3 metadata records returned (id + createdAt). Order by createdAt desc.
- **e2e test:** same shape, real LLM doing one prompt per session.

**Introduces:** `SessionStore.list()` method, `SessionMeta` shape, basic ordering.
**Does not introduce:** filtering by cwd / name / labels — added when a test needs them (M2.5+ or later).

**Gate, commit.**

---

#### **M3.1 — Filesystem interface + read tool**

**Goal:** the agent can read a file via a built-in tool, routing through an injected filesystem.

- **Test setup choice:** adopt [`@zenfs/core`](https://github.com/zen-fs/core) for the in-memory filesystem (drop-in Node `fs` API; LGPL-3.0). Wrap it behind a thin bodhi-pi `Filesystem` interface (we expose only the minimal methods; ZenFS is an *implementation*, not a public API).
- **Integration test (aimock):**
  - Mount in-memory ZenFS, write `/notes.txt` containing `"the cake is a lie"`.
  - Stub aimock turns:
    1. Assistant returns `tool_call: read({path: "/notes.txt"})`.
    2. After tool result, assistant returns `"the cake is a lie"`.
  - Prompt: `"Read /notes.txt and return its contents verbatim."`.
  - Assert: agent dispatched the tool; tool received the right path; aimock's turn-2 reply was emitted unchanged.
- **e2e test (real LLM):**
  - Same FS setup. Prompt: `"Read /notes.txt and reply with its exact contents."`.
  - Assert: response contains `"the cake is a lie"`.

**Introduces:** `Filesystem` interface (`readTextFile` only — others come when a tool needs them), in-memory ZenFS impl, `read` built-in tool, tool-dispatch loop in the agent core.
**Does not introduce:** write/edit/list/grep/find/bash, permissions, FS conformance suite as a parametrised harness — those grow as their owners arrive.

**Gate, commit.**

---

#### **M3.2 — Write tool**

**Goal:** the agent can create a file at a path it chooses.

- **Integration test:** stub aimock turn 1 = `tool_call: write({path: "/out.txt", content: "hello"})`; turn 2 = `"done"`. Prompt: `"Write 'hello' to /out.txt."`. Assert FS contains `/out.txt` with `"hello"`.
- **e2e test:** real LLM, same prompt, side-effect assertion on FS.

**Introduces:** `Filesystem.writeTextFile`, `write` tool.

**Gate, commit.**

---

#### **M3.3 — Edit tool (read-then-replace semantics)**

**Goal:** the agent can modify part of an existing file.

- **Integration test:** seed `/code.txt` with `"foo bar baz"`. Stub aimock to call `edit({path, find: "bar", replace: "BAR"})` then return `"done"`. Assert FS now contains `"foo BAR baz"`.
- **e2e test:** real LLM, prompt phrased to be unambiguous about the edit.

**Introduces:** `edit` tool. May also force `Filesystem.exists` if the tool needs precondition checks — added in this milestone if so.

**Gate, commit.**

---

#### **M3.4 — List / find / grep tools**

**Goal:** read-only directory queries over injected filesystem.

- **Integration test:** seed FS with a small tree; stub three aimock conversations exercising each tool; assert tool dispatched with right args, results consumed.
- **e2e test:** real LLM, three prompts, assert correct file names appear in responses.

**Introduces:** `Filesystem.list` and `Filesystem.stat` (`exists` if not added in M3.3), and `ls` / `find` / `grep` tools.

**Gate, commit.**

---

#### **M4.1 — Terminal interface + bash tool**

**Goal:** the agent can run a shell command when a `Terminal` is injected.

- **Integration test:** stub aimock to call `bash({command: "echo hello"})` then return `"hello"`; inject a tiny `Terminal` impl (real Node spawn pinned to tmpRoot); assert `echo hello` ran and stdout was `"hello\n"`.
- **e2e test:** real LLM, prompt: `"Run 'echo hello' using bash and return the output verbatim."`. Assert response contains `"hello"`.
- **Negative test:** with no `Terminal` injected, the bash tool is **not registered**; the model never sees it in its tool list.

**Introduces:** `Terminal` interface (`create` returning a handle with `output()`, `waitForExit()`, `kill()`, `release()`), Node implementation, `bash` built-in tool, capability-conditional tool registration.

**Gate, commit.**

---

#### **M5.1 — Streaming text deltas**

**Goal:** the agent emits incremental `text_delta` events instead of one final blob.

- **Integration test:** aimock supports streaming; configure a chunked response; collect emitted events; assert ≥ 2 `text_delta` events plus one `turn_end`.
- **e2e test:** real LLM with a long response; assert events arrive incrementally (timestamps strictly increasing across deltas) and final concatenation matches assistant message.

**Introduces:** event subscription API on the agent, `text_delta` / `turn_end` / `agent_end` event shapes.

**Gate, commit.**

---

### 4.4 Outline of subsequent milestones (refined as we land each batch)

These are placeholders — each becomes a fine-grained milestone (test → gate → commit) when we get there. Roughly grouped by the first test that will demand new structure.

**Phase 5 — Tooling depth**
- Tool-result truncation (when a tool returns >2 KB).
- Tool-call interception hook (when an extension blocks a tool).
- Auto-retry on transient errors (when a flaky-network test needs it).

**Phase 6 — Sessions, fork, clone, compaction**
- Persist sessions to disk via JSONL `SessionStore` impl (when a test demands restart-survives).
- Fork session from a prior entry (when a test needs branching).
- Clone active branch.
- Manual compaction (`/compact` issued; assert old turns replaced by summary).
- Auto-compaction at token threshold.
- Branch summarisation on switch.

**Phase 7 — Skills, templates, context, settings**
- AGENTS.md walk (when a test seeds AGENTS.md and expects it in the system prompt).
- SYSTEM.md / APPEND_SYSTEM.md.
- Skill discovery and `/skill:name` invocation with arg substitution.
- Prompt-template `/cmd args` substitution.
- Layered settings (`~/.bodhi-pi/settings.json` + `.bodhi-pi/settings.json` merge).
- Settings-driven knobs (retry, compaction reserve, thinking budget).

**Phase 8 — Permissions**
- Permission round-trip for write tool with diff payload.
- `allow_session` semantics across same-kind ops.
- Extension-driven tool-call interception precedence.

**Phase 9 — Extensions (standalone JS)**
- Load extension by path.
- Register custom tool from extension.
- Subscribe to lifecycle events.
- Custom provider via extension.
- Inter-extension event bus.

**Phase 10 — OAuth + auth storage**
- Default `ModelAuth` impl writes `~/.bodhi-pi/auth.json` 0600.
- Host override path.
- OAuth handshake routed via ACP `authenticate`.

**Phase 11 — ACP wire adapter (stdio)**
- Spawn bodhi-pi as child process; complete ACP `initialize`.
- Drive prior milestones through ACP wire (parametrised re-run).
- ACP schema validation against upstream `schema.json`.
- Permission requests bridged across the wire.

**Phase 12 — Web hosts**
- WebSocket adapter.
- Stateless HTTP/SSE adapter (rehydrate from `SessionStore`).

**Phase 13 — Browser worker host**
- OPFS `Filesystem` impl via ZenFS WebAccess backend.
- Chrome FS-Access `Filesystem` impl via ZenFS WebAccess backend.
- Browser-worker bootstrap + MessagePort ACP transport.

**Phase 14 — Slash commands**
- Built-in slash-command resolver.
- Extension-registered command precedence.
- `/export` HTML.

**v1.1 — additions on top of parity**
- First-party MCP client.
- Plan mode.
- Sub-agents.
- Image input.

### 4.5 Notes on this approach

- The plan is **deliberately incomplete**. We refine as we ship.
- Interfaces are *narrowed at the point of introduction*. A `Filesystem` exposing only `readTextFile` in M3.1 is fine; we add `writeTextFile` in M3.2 because that test demands it.
- Conformance suites only become parametrised when there's more than one impl of a given interface (e.g., when M3.2 ships a JSONL `SessionStore` alongside the existing in-memory one — only then does `SessionStore` get a shared conformance suite).
- We resist adding a "cleanup refactor milestone." Refactor is part of each milestone's "make tests pass" step.
- Each commit is a complete vertical slice: tests + impl + any docs changes the milestone demands.

---

## 5. Test isolation specifics

The harness grows with the milestones — only what's needed for the current batch is in place.

### 5.1 aimock isolation (integration tests)
- One `LLMock` instance per test, started on `port: 0` (free port).
- Stopped in test teardown.
- Fixtures scoped to the instance — no cross-test fixture leakage.
- Run concurrently across vitest workers without contention.

### 5.2 Filesystem isolation
- When tests are still in-memory only (M1.x–M2.x), no FS isolation needed; ZenFS in-memory backends are per-instance.
- From M3.1 onward, in-memory ZenFS instances per test, each is an independent volume.
- When real-disk hosts arrive (later phases), `tmpRoot = path.join(os.tmpdir(), "bodhi-pi-test", nanoid())`, cleaned in teardown.

### 5.3 Auth isolation
- e2e tests read `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` from `process.env` once at harness boot, hand them to bodhi-pi via the host (or via whatever auth-injection mechanism exists at the milestone in question).
- Integration tests use a fake key — aimock doesn't validate it.
- No agent code path reads `process.env` directly. Verified by grep in CI lint as soon as a milestone introduces an `env` host binding.

### 5.4 Process isolation (ACP wire tests, from Phase 11 onward)
- Each ACP-mode test spawns a child via `child_process.spawn(["node", "dist/cli.js", "--acp"], { stdio: "pipe", cwd: tmpRoot })`.
- Child inherits only the keys it strictly needs.
- Killed in test teardown; SIGKILL after a short grace period.

### 5.5 Concurrency
- `vitest.config.ts` uses `pool: "forks"`, `poolOptions.forks.singleFork: false`.
- Default `BODHI_TEST_CONCURRENCY=4`; CI tunes per worker count.
- Slow e2e tests opt out of concurrency individually via `test.sequential`.

### 5.6 Determinism with a real model (e2e)
- Prompts engineered to elicit *structured* behaviour: tool calls with specific arguments, file writes with specific names. Text the model produces is asserted only loosely (e.g., contains a substring, length > N).
- Side-effect assertions (file state, event sequence, tool-call shapes) are the primary assertion form.
- A `retry: 2` budget per e2e test absorbs occasional model flakiness without masking real bugs.

### 5.7 Choice of stubbing & FS libraries

| Concern                        | Library                                                                              | Why                                                                                                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LLM stubbing (integration)     | [`@copilotkit/aimock`](https://github.com/CopilotKit/aimock)                         | One server, supports OpenAI/Anthropic/Gemini/etc., streaming, tool calls, multi-turn. Record-and-replay for fixture creation. Zero deps.                               |
| In-memory & browser filesystem | [`@zenfs/core`](https://github.com/zen-fs/core)                                      | Drop-in Node `fs` API, in-memory backend, OPFS / FS-Access backends in `@zenfs/dom`, S3 in `@zenfs/cloud`. License: LGPL-3.0 (acceptable for this project's purposes). |
| Real LLMs (e2e)                | `pi-ai` against Anthropic + OpenAI                                                   | Default: `claude-haiku-4-5`, `gpt-5-mini` (or current cheapest). API keys via CI secrets.                                                                              |
| ACP test client                | [`@agentclientprotocol/sdk`](https://www.npmjs.com/package/@agentclientprotocol/sdk) | Official client SDK, used to drive bodhi-pi over its ACP wire from Phase 11 onward.                                                                                    |

---

## 6. Open considerations

These are not blockers for starting; settle along the way and track in `ai-docs/plans/deferred.md` if they aren't resolved by the time the relevant milestone arrives.

1. **Slash-command namespace clash** between built-in and extension commands: warn, override, or rename? Recommend warn-and-prefer-built-in.
2. **`SessionStore` schema versioning** — coding-agent uses `CURRENT_SESSION_VERSION = 3`. Reset to v1 for bodhi-pi or stay compatible? Recommend reset; document migration as out of scope.
3. **Agent SDK exporting raw model calls** — coding-agent's `bash` RPC method lets external clients run arbitrary commands. Provide equivalent in bodhi-pi or punt to host? Recommend punt — hosts implement directly.
4. **`/export` HTML rendering** — port from coding-agent or simplify? Recommend port-then-prune.
5. **`/share` to gist** — host concern. Bodhi-pi exposes `exportToHtml`; that's it.
6. **Slash-command authentication scope** — should `/login` block the prompt loop? Recommend yes — agent emits `authenticate` request and waits.
7. **ZenFS LGPL-3.0 transitive license** — confirm legal acceptance; document in NOTICE / README.

---

## 7. Done criteria for v1

A bodhi-pi v1 release ships when **all** the following are true:

- Every milestone in §4.3 (detailed) and §4.4 (outlined Phases 5–14) has its tests green on Node (Linux, macOS, Windows).
- ACP wire validation passes against upstream `schema.json`.
- A reference Node CLI host (in `examples/`) can drive bodhi-pi end-to-end and reproduce coding-agent's print-mode output for a curated set of representative prompts.
- A reference browser-worker host (in `examples/`) can run a small scripted demo against OPFS.
- `pnpm test` (offline subset: unit + integration via aimock) passes in <5 minutes.
- `pnpm test:online` (e2e against real Haiku/openai-mini) passes in <30 minutes.
- Public API documented in `docs/sdk.md` and `docs/acp.md`.

---

## 8. References

- [`embeddable-agent-design.md`](./embeddable-agent-design.md) — architecture / interfaces
- [`../plans/deferred.md`](../plans/deferred.md), [`../plans/skipped.md`](../plans/skipped.md)
- `packages/coding-agent/docs/` — primary feature source for the port matrix
- [Agent Client Protocol](https://agentclientprotocol.com/)
- [`@agentclientprotocol/sdk`](https://www.npmjs.com/package/@agentclientprotocol/sdk) — ACP test client
- [`@copilotkit/aimock`](https://github.com/CopilotKit/aimock) — integration-test LLM stubbing
- [`@zenfs/core`](https://github.com/zen-fs/core) — in-memory + browser filesystem backends
