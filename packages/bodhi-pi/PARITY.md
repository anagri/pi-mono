# bodhi-pi vs coding-agent — Session-feature parity

Source plan: `ai-docs/plans/we-want-to-start-jazzy-owl.md`. Reference for the
target shape: `packages/coding-agent/`. Every row below tracks a coding-agent
session capability and how bodhi-pi covers it across the five reference hosts
(`bodhi-pi-cli`, `bodhi-pi-web`, `bodhi-pi-ws-frontend` + `bodhi-pi-ws-server`,
`bodhi-pi-http`, `bodhi-pi-chrome-ext`).

Legend: ✅ shipped · ⏭ deferred · ❌ excluded by design.

## Shipped

| Feature | ACP method | All hosts | Notes |
|---|---|---|---|
| Manual context compaction | `_bodhi-pi/session/compact` | ✅ | Faux-mocked LLM in core; real `gpt-4o-mini` per host (Phase A). |
| Auto-compaction (token threshold) | (mid-loop `prepareNextTurn` + post-`agent_end` fallback) | ✅ core only | Triggers when last assistant `Usage.totalTokens` > `contextWindow - reserveTokens`. Wired into `AgentLoopConfig.prepareNextTurn` so compaction can land between turns within one `agent.loop()` call; post-prompt `checkAutoCompact` retained as the single-turn fallback. Settings: `enabled`, `reserveTokens` (default 16384), `keepRecentTokens` (default 20000). Tests: `bodhi-pi/test/auto-compact.test.ts`, `bodhi-pi/test/prepare-next-turn-wiring.test.ts`. Per-host e2e intentionally skipped (rigging real-LLM context windows is flaky). |
| Provider-overflow recovery | (`prompt()` error path) | ✅ core only | Catches context-overflow errors via `isContextOverflow` from pi-ai (covers Anthropic / OpenAI / Google / xAI / Groq / Bedrock / Mistral / OpenRouter / llama.cpp / LM Studio / Kimi / z.ai silent-overflow / Xiaomi length-truncation), runs auto-compact, retries the same prompt once. Re-overflow on retry propagates. Tests: `bodhi-pi/test/overflow-recovery.test.ts`. |
| Branch creation by user-message rewind (`/fork`) | `_bodhi-pi/session/fork` | ✅ | Returns `{ newSessionId, selectedText? }`. Position `"before"` excludes the target message; `"at"` includes it (alias used by `/clone`). |
| Full-chain duplication (`/clone`) | `_bodhi-pi/session/clone` | ✅ | New session id with the same entries copied through `forkRecord`. |
| Active-branch entry list (`/entries`) | `_bodhi-pi/session/entries` | ✅ | Hosts use this as the blackbox seam to capture entry ids for `/fork`. |
| Full DAG tree (`/tree`) | `_bodhi-pi/session/tree` | ✅ | All entries with leaf marker + per-node child count; surfaces post-`/goto` divergent branches. |
| Leaf navigation (`/goto`) | `_bodhi-pi/session/navigate` | ✅ | All five hosts. SQLite + Dexie stores persist `leaf_id` so http's per-turn rebuild reads the navigated leaf back across requests. Cross-branch `/goto` auto-appends a `branch_summary` entry on the new branch via `runBranchSummary` (see below). |
| Cross-branch `branch_summary` on `/goto` | (auto-appended in `_bodhi-pi/session/navigate`) | ✅ core | When a `/goto` target's parentId chain does not include the current leaf, the agent walks the abandoned tail back to the common ancestor, summarizes it via `runBranchSummary`, and persists a `branch_summary` entry on the new branch. `buildSessionContext` already replays it as a synthesized user message. Failures are non-fatal (falls back to plain navigate). Tests: `bodhi-pi/test/branch-summary.test.ts`. |
| Pagination cursor in `session/list` | (already in ACP) | ✅ | All four stores encode `{updatedAt,id}` base64url cursors with `LIMIT PAGE_SIZE+1` over-fetch. Each host's `/sessions` slash dispatcher loops until `nextCursor` is undefined. Tests: `bodhi-pi-cli/test/sessions-pagination.test.ts`, `bodhi-pi-http/test/integration/session-list-pagination.test.ts`. |
| Session display name (`/name`) | `_bodhi-pi/session/setName` | ✅ | Appends a `session_info` entry; latest on the active path wins. |
| Session stats (`/session`) | `_bodhi-pi/session/stats` | ✅ | Returns `messageCount`, `toolCallCount`, `leafId`, optional `name`. |
| Session export (`/export`) | `_bodhi-pi/session/export` | ✅ | JSONL header line + active-branch entries. CLI prints to stdout; browser hosts copy to clipboard. |
| Session deletion | `_bodhi-pi/session/delete` | ✅ | Pre-existing extension method. |
| Built-in system prompt with tool descriptions | (composed at session boot) | ✅ | `buildSystemPrompt` ported from coding-agent; tool snippets keyed off registered tool names; `run_script` snippet only when `scriptExecutor` is configured. Tests: `bodhi-pi/test/system-prompt-builtin.test.ts`. |
| Append surface (`appendSystemPrompt`) | `BodhiPiConfig.appendSystemPrompt` | ✅ | New config field; CLI mirrors with `--append-system-prompt` flag + `BODHI_APPEND_SYSTEM_PROMPT` env. Project settings may also supply it; host-explicit wins. Tests: `bodhi-pi/test/system-prompt-append.test.ts`. |
| AGENTS.md / CLAUDE.md walk | (`loadProjectContextFiles` at session boot) | ✅ | Walks `<cwd>` → ancestors → root via injected `Filesystem`. Candidates per dir: `AGENTS.md > AGENTS.MD > CLAUDE.md > CLAUDE.MD` (first match wins). Root-first ordering so cwd lands last in the prompt. Tests: `bodhi-pi/test/resource-loader.test.ts`, `bodhi-pi/test/system-prompt-context.test.ts`. |
| Project settings (`.bodhi-pi/settings.json`) | (`loadProjectSettings` at session boot) | ✅ | Reads `compaction.*` overrides + `appendSystemPrompt`. Precedence: defaults < project settings < host-explicit `BodhiPiConfig.compaction`. Surfaced for blackbox testing via `_bodhi-pi/session/config` + per-host `/config` slash. Tests: `bodhi-pi/test/settings.test.ts`, `bodhi-pi/test/session-config-ext.test.ts`. |
| Per-session resolved config | `_bodhi-pi/session/config` | ✅ | Returns `{ cwd, defaultModelId, currentModelId, compaction, appendSystemPrompt, contextFilePaths, projectSettingsPresent, projectSettings }`. Per-host `/config` slash command renders this for visual blackbox verification. |
| Streaming tool output (`tool_call_update.content` mid-flight) | (`tool_execution_update` → `sessionUpdate`) | ✅ core | Phase H. `subscribeToAgent` now forwards `tool_execution_update` to ACP as `tool_call_update` with `status:"in_progress"` + content snapshot. Extension `ExtensionToolDefinition.execute` gained an optional `onUpdate` callback so extension-registered tools can stream. Test: `bodhi-pi/test/streaming-tool-output.test.ts`. Browser/ws/http renderers already update tool-card preview for any status; CLI deliberately renders only `completed`/`failed` (no terminal redraw). |
| `edit` preserves CRLF/LF line endings | (`tools/edit.ts`) | ✅ core | Phase H. Detect → normalise to LF for matching → restore original ending on write. Helpers in `tools/_text-encoding.ts` (`detectLineEnding`, `restoreLineEndings`, `normalizeToLF`). Tests: `bodhi-pi/test/fs.test.ts` (CRLF + LF round-trip). |
| `edit` preserves UTF-8 BOM | (`tools/edit.ts`) | ✅ core | Phase H. `stripBom` strips on read, prepended back on write. Test: `bodhi-pi/test/fs.test.ts`. |
| `edit` rejects ambiguous `oldText` | (`tools/edit.ts`) | ✅ | Pre-existing; coverage tightened in Phase H. Throws with byte offsets when `oldText` appears more than once. Test: `bodhi-pi/test/fs.test.ts`. |
| File-mutation queue (serialise concurrent writes/edits per path) | (`tools/file-mutation-queue.ts`) | ✅ core | Phase H. Module-global `Map<absolutePath, Promise>` promise-chain. Wraps `edit` + `write` execute bodies. Keyed by resolved absolute path (no `realpath` resolution — keeps core browser-safe; symlink aliases on Node won't share a lock — accepted trade-off). Test: `bodhi-pi/test/file-mutation-queue.test.ts`. |
| `grep` long-line truncation marker | (`tools/grep.ts`) | ✅ | Phase H. Marker aligned to coding-agent: `... [truncated]` (was `...`). Lines > `GREP_MAX_LINE_LENGTH` (500 chars) truncated. Test: `bodhi-pi/test/fs.test.ts`. |
| Layered settings (global + project + session) | (`loadGlobalSettings` + `mergeSettings` at session boot; `_bodhi-pi/session/settings/*` ext methods) | ✅ | Phase I. New global layer at `<homeDir>/.bodhi-pi/settings.json` (Node hosts; browser hosts omit `homeDir`). Precedence: defaults < global < project < host-explicit `BodhiPiConfig` < session overrides (`setSessionConfigOption`). `_bodhi-pi/session/config` returns per-layer breakdown. Tests: `bodhi-pi/test/settings.test.ts`. |
| Thinking-level per session | `setSessionConfigOption("thinking", ...)` + `THINKING_CONFIG_ID` | ✅ core | Phase I. Advertised as second `SessionConfigOption` filtered by `getSupportedThinkingLevels(model)`; omitted entirely for non-reasoning models. `prepareNextTurn` flushes pending level + mutates `piAgent.state.thinkingLevel` so subsequent prompts pick up the change. `thinking_change` `SessionEntry` variant persists for replay. Bug fix bundled: `setSessionConfigOption` now returns FULL `configOptions[]` (was returning only the changed option). Real-LLM e2e gated on `ANTHROPIC_API_KEY`; faux path covers wiring. Tests: `bodhi-pi/test/thinking.test.ts`. |
| Per-provider retry/timeout settings | (`providerOptions[...]` + `retry` in merged settings) | ✅ core | Phase I. `providerOptions[<provider>].maxRetryDelayMs` + `retry.maxDelayMs` threaded to pi-`Agent` ctor (`AgentLoopConfig` extends `SimpleStreamOptions`). Surfaced via `_bodhi-pi/session/config.retryOptions`. `maxRetries`/`timeoutMs` are accepted in settings (forward-compatible) but not yet plumbed through upstream pi-agent-core — see Deferred row below. Tests: `bodhi-pi/test/provider-options.test.ts`. |
| Host-injected `KvStore` + auth credential storage | `BodhiPiConfig.kvStore` + `_bodhi-pi/kv/{get,set,list,remove}` | ✅ | Phase I. Generic key-value primitive with `secret: boolean` hint. API keys stored under `auth/<provider>`. **ACP reads mask secret values to `***`**; internal in-process resolution (`getApiKey` path) reads unmasked. Adapters: `createNodeKvStore` (file-per-key, 0o600 for secrets), `createDexieKvStore` (two-table segregation: `kv` + `kv_secret`). Wired into cli, browser shared (web + chrome-ext), ws-server, http server. Tests: `bodhi-pi/test/kv-store.test.ts`, `bodhi-pi/test/kv-slash.test.ts`, `bodhi-pi-node/test/node-kv-store.test.ts`, `bodhi-pi-browser/src/kv/dexie-kv-store.test.ts`. |
| Flat slash commands: `/settings`, `/login`, `/logout`, `/logins` | (host dispatchers) | ✅ | Phase I. All five hosts (cli, browser shared, ws-frontend, http frontend) ship word-for-word identical surface. `/settings list|get|set|unset [--global|--project|--session]`. `/login <provider> <api-key>` → `_bodhi-pi/kv/set auth/<provider> <key> secret:true`. `/logout <provider>`. `/logins` lists stored providers with masked values. Flat-and-complete by design — no prompts, no popups, no UI cycle (host UI can implement cycling natively over ACP). `--global` errors with `-32602` when host has no `homeDir`. Tests: `bodhi-pi/test/settings-slash.test.ts`, `bodhi-pi-cli/test/slashes-settings-kv.test.ts`. |
| Full `configOptions[]` from `setSessionConfigOption` (schema fix) | `setSessionConfigOption` | ✅ | Phase I. Response now returns the FULL updated `configOptions[]` (matching ACP schema), not just the changed entry. Was a latent bug visible once thinking landed as a second option. |

## Deferred

| Feature | Reason |
|---|---|
| `/import` (re-create a session from JSONL) | Multiple runtimes complicate "where do we import from" (filesystem injection differs in browser hosts). Round-trip with `/export` also needs schema validation + security review for untrusted bytes; revisit if a real consumer needs it. |
| Session-cwd switching mid-run | Niche; ship if a host asks. |
| Skill `allowed-tools` runtime enforcement | Will land alongside the permissions phase (host-injected `Permissioner`). |
| Global settings layer in browser/chrome-ext/ws-frontend runtimes | Phase I. Node hosts have `homeDir`; browser-side hosts have no natural `~`. The `--global` slash scope errors cleanly with `-32602`. Hosts can wire a virtual home dir later if a real consumer asks. |
| Tool snippet customization in system prompt | Niche (parity §3.4 P3). The current snippet table is hard-coded next to the built-in tool factory. |
| HTML export | Host concern; out of scope for the agent. A separate `@bodhiapp/bodhi-pi-export-html` helper can be added if a host wants it. |
| `/share` (gist upload) | Auth + GitHub integration; out of scope. |
| OAuth login flow (Anthropic Claude.ai et al.) + OAuth token refresh | Phase I shipped API-key persistence via the generic `KvStore`. OAuth needs interactive browser auth + per-host plumbing (open browser tab, capture redirect, periodic refresh) — deferred to a follow-up phase. |
| Dynamic model registry (`models.json`, `modelOverrides`, OAuth `modifyModels`) | The primary motivator (`modifyModels` post-login) is OAuth-dependent. Phase I retains static `BodhiPiConfig.models` + extension-provided models. Will land alongside OAuth. |
| Scoped-models cycle command (`Ctrl+P` analogue in coding-agent) | Depends on dynamic model registry. Defer with the OAuth+registry phase. |
| Cross-provider mid-session retry/timeout mutation | Phase I ships static-per-session retry options; when the user changes models mid-session, the new provider keeps the same retry config until the next session. Upstream `Agent` ctor accepts `maxRetryDelayMs` only via `AgentLoopConfig`; `maxRetries`/`timeoutMs` plumbing through `Agent` requires an upstream patch. |
| Browser encrypted-at-rest secret storage | Phase I segregates secret entries into a separate Dexie table (`kv_secret`) and uses 0o600 file perms on Node. No real cryptography. Hosts that need it can wrap the adapter. |
| Sub-agents (`.claude/agents/`) | Not on the bodhi-pi roadmap. |
| Package manager (git-pinned packs of extensions/skills/commands) | Defer until users ask for shared packs. |
| `bash` tool + Terminal interface | Phase H deliberately deferred. Larger surface (streaming, abort, exit-code, optional SSH ops); needs host-injected `Terminal` capability. Will reuse `harness/utils/shell-output.ts` per upstream-alignment plan. |
| Per-host streaming-tool e2e specs | Phase H. Core wire-through is tested. Browser/ws/http renderers already handle `tool_call_update` with any status uniformly (visible by inspection). Production built-in tools don't yet emit `onUpdate` — they will when the `bash` tool lands. Add per-host streaming e2e then. |

## Excluded by design

These intentionally never land in `bodhi-pi`'s core (per `ai-docs/parity-post-extension.md` §3.10):

- TUI rendering, message components, theming, keyboard navigation
- Image clipboard paste, EXIF orientation, photon image processing
- Git branch detection, fs-watch–driven branch monitoring
- External tool binary downloads (`fd`, `ripgrep` shipped with `pi`)
- Bun-binary entrypoint, install-method detection, self-update
- ANSI-to-HTML conversion (lives with the export-html host helper if/when built)

## ACP convention

ACP itself is intentionally minimal — it covers `initialize`, `session/new`,
`session/load`, `session/resume`, `session/list`, `session/close`,
`session/prompt`, `session/cancel`, `session/setSessionConfigOption`, and
`session/setSessionMode`. None of the session-management features above have
first-class ACP methods, so each ships as an `extMethod` under the
`_bodhi-pi/session/<verb>` namespace per the project's
"Stable ACP over `unstable_*`" rule. Capability is advertised via
`agentCapabilities._meta["bodhi-pi"]` in the `initialize` response so
clients can negotiate.

## Upstream alignment — 2026-05-11

Post-`@earendil-works/*` rebase audit. Rationale + per-module decisions
in `ai-docs/research/upstream-sync-2026-05-11.md` ("Appendix — Adoption
decisions"). Default stance: keep parallel impls, reuse harness as reference.

| Harness module (`@earendil-works/pi-agent-core/harness/*`) | Decision |
|---|---|
| `session/*` | Keep parallel — revisit next sync |
| `compaction/compaction.ts` | Keep parallel — reuse as reference |
| `compaction/branch-summarization.ts` | Keep parallel |
| `messages.ts` (+ `CustomAgentMessages` augmentation) | Keep parallel; cast workaround retained |
| `prompt-templates.ts` | Keep parallel |
| `skills.ts` | Keep parallel |
| `system-prompt.ts` | Keep parallel — note for Group 2 |
| `execution-env.ts` + `env/nodejs.ts` | Keep parallel — permanent split |
| `utils/shell-output.ts` | Adopt later (Phase H, bash tool) |
| `utils/truncate.ts` | Keep parallel — semantic spot-check |

Shipped this phase:

- `AgentLoopConfig.prepareNextTurn` wired into `_buildSessionState` for
  mid-loop proactive compaction; post-prompt `checkAutoCompact` retained
  as fallback. See appendix for the timing nuance.
- `AgentMessage` widening decision deferred (one `as unknown as
  AgentMessage` cast + `"content" in m` narrowing retained).
- Upstream module-augmentation bug deferred to next sync.
