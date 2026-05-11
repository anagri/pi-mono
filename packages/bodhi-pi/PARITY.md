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

## Deferred

| Feature | Reason |
|---|---|
| `/import` (re-create a session from JSONL) | Multiple runtimes complicate "where do we import from" (filesystem injection differs in browser hosts). Round-trip with `/export` also needs schema validation + security review for untrusted bytes; revisit if a real consumer needs it. |
| Session-cwd switching mid-run | Niche; ship if a host asks. |
| Skill `allowed-tools` runtime enforcement | Will land alongside the permissions phase (host-injected `Permissioner`). |
| HTML export | Host concern; out of scope for the agent. A separate `@bodhiapp/bodhi-pi-export-html` helper can be added if a host wants it. |
| `/share` (gist upload) | Auth + GitHub integration; out of scope. |
| Auth credential store / OAuth refresh | Hosts inject API keys via `getApiKey`; persistent credential storage is a host concern for now. |
| Thinking levels (`setSessionConfigOption("thinking", ...)`) | Reasoning models supported; level wiring is a separate milestone. |
| Sub-agents (`.claude/agents/`) | Not on the bodhi-pi roadmap. |
| Package manager (git-pinned packs of extensions/skills/commands) | Defer until users ask for shared packs. |

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
