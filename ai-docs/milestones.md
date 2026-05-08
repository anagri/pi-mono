# bodhi-pi — Milestone Tracker

Tracks what's shipped, what's in progress, and what's planned. Each completed milestone has its commit hash for reference. See `ai-docs/research/coding-agent-features.md` for the full feature port matrix.

---

## Completed

| Milestone        | Commit                | Description                                                                                          |
| ---------------- | --------------------- | ---------------------------------------------------------------------------------------------------- |
| **M1.1**         | `347ecaf0`            | Bootstrap package + simple chat (public API was `createAgentSession`; internal, now deleted)         |
| **M1.2**         | `bbe3362b`            | Speak ACP via `@agentclientprotocol/sdk`; replaced public API with `createBodhiPiAgent` factory      |
| **M1.3**         | `fc8ac643`            | Model switching via stable `session/setSessionConfigOption` (`id: "model"`, `category: "model"`)     |
| **M2.1**         | `08c92563`            | Basic session persistence: `load`, `resume`, `list`, `close`, `_bodhi-pi/session/delete`             |
| **M3.1**         | `4f5c27d4`            | Filesystem interface + 6 built-in FS tools (`read`, `write`, `edit`, `ls`, `find`, `grep`)           |
| **M3.2**         | `b45a332e`–`302b0317` | Health pass + `systemPrompt`: wire correctness, source split, tool DRY, test helpers, coverage       |
| **M4.1**         | `5eaba958`            | Slash commands / prompt templates (`<cwd>/.bodhi-pi/commands/*.md`); ACP `available_commands_update` |
| **bodhi-pi-cli** | `092b8303`            | Hand-rolled REPL CLI host (`packages/bodhi-pi-cli`) for live-testing bodhi-pi                        |
| **M4.2**         | `f4f7a518`            | Skills (markdown-only): `<cwd>/.bodhi-pi/skills/*.md`; injected into system prompt                   |
| **M4.3**         | `019065e5`            | `ScriptExecutor` interface + `run_script` tool; host-injected, optional (capability-conditional)     |
| **M4.3-cli**     | `b523427a`            | Wire slash commands + `ScriptExecutor` into bodhi-pi-cli REPL                                        |
| **M4-health**    | `40d9d7d5`            | Health-pass fixes for slash commands + skills                                                        |
| **M5.1**         | _pending commit_      | Headless lifecycle events (16 types) + `BodhiPiConfig.eventHandlers`; wired across cli + web         |
| **M5.2**         | _pending commit_      | `ExtensionAPI` factory + Node/browser loaders; tools/commands/providers/events-bus/appendEntry       |

### M2.1 detail — session persistence

ACP methods: `session/load` (full replay), `session/resume` (rehydrate without replay), `session/list` (cwd filter), `session/close` (release runtime; persisted record stays loadable), `_bodhi-pi/session/delete` (permanent removal, custom extension).

Persistence triggers: `message_end` → `SessionMessageEntry` appended; `setSessionConfigOption(model)` → `ModelChangeEntry` appended.

### M3.2 detail — health pass

Five-commit cleanup from the `ai-docs/reviews/2026-05-08-bodhi-pi-m3-1-health.md` review:
- Wire correctness: stopReason mapping, cancel flag, `userMessageId` echo, `agentInfo`, `updatedAt`, `nextCursor`
- Source split: `acp/agent.ts` → `acp/agent.ts` + `acp/notifications.ts` + `acp/constants.ts`
- Tool DRY: `accumulateBounded` helper; `ls`/`find`/`grep` refactored; `read.ts` intentionally not migrated
- Test architecture: 7 shared helpers in `test/helpers/`; `vitest.e2e.config.ts` rewritten (no `mergeConfig`)
- Coverage: 94 integration tests, 6 e2e tests at wrap

---

## In progress

### CLI test correctness + feature-parity (`we-need-to-enhance-glistening-bubble.md`)

`bodhi-pi-cli/e2e/repl.e2e.ts` uses in-memory stubs instead of the CLI's real `createNodeFilesystem` + `createSqliteSessionStore` + `createNodeScriptExecutor`. Work:

1. Extract `src/agent.ts` (`createCliAgent` factory) from `cli.ts` — already landed (`092b8303` extracted parts, `b523427a` extended).
2. Create `test/helpers/cli-harness.ts` wrapping `createCliAgent` with a real tmpdir + temp SQLite.
3. Add `test/agent.test.ts` (integration) — faux provider + real tmpdir, covering node filesystem + SQLite persistence.
4. Add e2e tests for filesystem operations, script execution, and session persistence.

**Untracked files (in-progress):**
- `packages/bodhi-pi-cli/src/agent.ts` — `createCliAgent` factory
- `packages/bodhi-pi-cli/e2e/fs.e2e.ts`
- `packages/bodhi-pi-cli/e2e/scripts.e2e.ts`
- `packages/bodhi-pi-cli/e2e/sessions.e2e.ts`
- `packages/bodhi-pi/src/agent.ts`
- `packages/bodhi-pi/test/agent.test.ts`
- `packages/bodhi-pi/test/helpers/` (some new helpers)

---

## Planned / deferred

Items from `ai-docs/plans/deferred.md` and the feature port matrix:

### Near-term

| Item                                     | Notes                                                                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **M2.2 — Intermediate session features** | `unstable_forkSession`, branch labels, custom entries, `session_info_update`, pagination cursor                          |
| **M2.3 — Disk-backed `SessionStore`**    | JSONL on disk; lights up restart-survives + exercises the `cursor` parameter                                             |
| **Permissions**                          | Mandatory `Permissioner` interface; write/edit gate on `session/request_permission`; diff-content blocks for `tool_call` |
| **Terminal + bash tool**                 | `Terminal` interface; `bash` tool registered only when host injects `Terminal`                                           |

### Medium-term

| Phase    | Item                                                                                                           |
| -------- | -------------------------------------------------------------------------------------------------------------- |
| Phase 5  | Tool-call interception hook; auto-retry on transient errors                                                    |
| Phase 6  | Compaction (manual `/compact`, auto-compaction, branch summarisation, `CompactionEntry`)                       |
| Phase 7  | Full settings merge (`~/.bodhi-pi/settings.json` + `.bodhi-pi/settings.json`); AGENTS.md / SYSTEM.md file-walk |
| Phase 9  | Standalone-JS extension runtime (`ext.registerTool`, `ext.on(...)`, custom providers)                          |
| Phase 11 | ACP wire adapter over stdio (`ndJsonStream`); `bodhi-pi --acp` subprocess binary                               |

### Long-term / v1.1

| Item                | Notes                                                                |
| ------------------- | -------------------------------------------------------------------- |
| Browser worker host | OPFS / Chrome FS-Access `Filesystem` impl; MessagePort ACP transport |
| Web server hosts    | WebSocket + stateless HTTP/SSE adapters                              |
| MCP client          | Attach external MCP servers via config                               |
| Plan mode           | Agent commits to plan; host approves/edits                           |
| Sub-agents          | ACP `session/spawn_subagent`                                         |
| Image input         | Multimodal; deferred to v1.1                                         |

### Deferred design questions

See `ai-docs/plans/deferred.md`. Highlights:
- License for published package (currently MIT; revisit before first publish)
- ZenFS LGPL-3.0 acceptance (when browser-worker host needs OPFS/FS-Access)
- Protocol version negotiation (`initialize` hardcodes `protocolVersion: 1`)
- `tool_call.locations` field (recommended for read/edit/delete tools)
- `tool promptSnippet` / `promptGuidelines` metadata
