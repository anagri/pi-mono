# bodhi-pi

ACP-speaking coding agent. Hosts inject `Filesystem`, `SessionStore`, `ScriptExecutor`; this package owns ACP wire, session lifecycle, and built-in tools.

**DEVELOPMENT.md** covers: Node/toolchain setup, verification commands, ENV files, comments policy, test architecture, test helper catalog, stub strategy (aimock vs faux provider), e2e model selection, and external reference paths (coding-agent, ACP spec, SDK types).

## Architecture pillars

**ACP is the public contract.** Drive via `AgentSideConnection` only. Internal `pi-agent-core` types and session-store impl types (`SessionEntry`, `SessionInfo`, `SessionRecord`) are not re-exported. Tests go through `ClientSideConnection` — never touch the inner `Agent` directly.

**No silent defaults.** Missing required `BodhiPiConfig` field → factory throws. Mandatory: `models`, `defaultModelId`, `getApiKey`, `sessionStore`, `filesystem`. Optional: `scriptExecutor` (skills register `run_script` only when present), `systemPrompt` (pi-agent-core's empty-string default otherwise).

**Stable ACP over `unstable_*`.** Non-spec features use `_bodhi-pi/<area>/<verb>` extensions, advertised via `agentCapabilities._meta["bodhi-pi"]`.

**Mirror coding-agent.** Read `packages/coding-agent/` first, strip TUI/Node parts, replicate field/method shape.

**Reuse dependency types.** Use `pi-agent-core`'s `AgentOptions`, `pi-ai`'s `Model<Api>`, ACP SDK's types directly — no wrapper types until a real semantic mismatch.

## Key files

| Path | Role |
|---|---|
| `src/index.ts` | Public exports barrel |
| `src/version.ts` | `BODHI_PI_VERSION` — bump alongside `package.json` |
| `src/acp/agent.ts` | `createBodhiPiAgent` factory + `BodhiPiAcpAgent` class |
| `src/acp/notifications.ts` | ACP-shape helpers + `isAssistantMessage`/`isToolResultMessage` guards |
| `src/acp/constants.ts` | `MODEL_CONFIG_ID`, `EXT_DELETE_SESSION` |
| `src/sessions/session-store.ts` | `SessionStore` interface + `SessionEntry` union |
| `src/sessions/in-memory-session-store.ts` | `createInMemorySessionStore()` helper |
| `src/filesystem/filesystem.ts` | `Filesystem` interface |
| `src/filesystem/in-memory-filesystem.ts` | `createInMemoryFilesystem()` helper |
| `src/tools/index.ts` | `createBuiltinTools({ filesystem, cwd, scriptExecutor? })` |
| `src/tools/_accumulate.ts` | `accumulateBounded` + `truncationFooter` — canonical truncation for ls/find/grep |
| `src/slash-commands/` | Prompt-template discovery + expansion |
| `src/skills/` | Skill discovery + activation |
| `src/script-executor/` | `ScriptExecutor` interface |
| `test/helpers/harness.ts` | `createTestHarness(...)` — single source of truth for ACP test wiring |

## Source code rules

- **No fallbacks.** Throw at factory time if required field missing. `systemPrompt` is the sole exception.
- **`systemPrompt` is config-time only.** Rebuilt on every session load; never persisted as a `SessionEntry`.
- **No fs/file-walk in core.** AGENTS.md/SYSTEM.md discovery is the host's responsibility.
- **`stopReason` mapping:** `"aborted"→"cancelled"`, `"length"→"max_tokens"`, `"stop"|"toolUse"→"end_turn"`, `"error"→throws RequestError(-32603)`.
- **`SessionStore.append` must bump `updatedAt`.**
- **No `as` casts in ACP message handling.** Narrow on `role` via pi-ai's `Message` discriminator.
- **`accumulateBounded` is canonical** for list-producing tools. `read.ts` uses `Buffer.byteLength` — intentional exception.
- **ACP `fs/*` methods are deliberately absent** — orthogonal to our host-injected `Filesystem`.

## Test conventions

- No `if (cond) { expect(...) }` — use narrowing helpers and `expect(val, "diag").toBe(...)`.
- No milestone IDs in filenames (`chat.test.ts` not `m2_1_chat.test.ts`).
- Shared helpers live in `test/helpers/` — never duplicate.
- Tool-call tests: prefer `registerFauxProvider` over aimock (aimock SSE isn't always parsed for tool-call rounds).
- `vitest.e2e.config.ts` does NOT use `mergeConfig` — composes `test.include` directly.
- e2e: assert side-effects and stable substrings, not exact model text.
- Per-feature e2e uses `gpt-4o-mini` (non-reasoning). Cross-provider parity lives in `e2e/chat.e2e.ts`.
