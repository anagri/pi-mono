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
| Auto-compaction (token threshold) | (post-`agent_end` hook in core) | ✅ core only | Triggers when last assistant `Usage.totalTokens` > `contextWindow - reserveTokens`. Settings: `enabled`, `reserveTokens` (default 16384), `keepRecentTokens` (default 20000). Faux-provider integration tests in `bodhi-pi/test/auto-compact.test.ts`; per-host e2e is intentionally skipped (rigging real-LLM context windows is flaky). |
| Branch creation by user-message rewind (`/fork`) | `_bodhi-pi/session/fork` | ✅ | Returns `{ newSessionId, selectedText? }`. Position `"before"` excludes the target message; `"at"` includes it (alias used by `/clone`). |
| Full-chain duplication (`/clone`) | `_bodhi-pi/session/clone` | ✅ | New session id with the same entries copied through `forkRecord`. |
| Active-branch entry list (`/entries`) | `_bodhi-pi/session/entries` | ✅ | Hosts use this as the blackbox seam to capture entry ids for `/fork`. |
| Full DAG tree (`/tree`) | `_bodhi-pi/session/tree` | ✅ | All entries with leaf marker + per-node child count; surfaces post-`/goto` divergent branches. |
| Leaf navigation (`/goto`) | `_bodhi-pi/session/navigate` | ⚠ partial | cli, web, ws-frontend, chrome-ext: works in same session/connection. http: deferred (per-turn rebuild needs `leaf_id` schema column — see PARITY follow-up). |
| Session display name (`/name`) | `_bodhi-pi/session/setName` | ✅ | Appends a `session_info` entry; latest on the active path wins. |
| Session stats (`/session`) | `_bodhi-pi/session/stats` | ✅ | Returns `messageCount`, `toolCallCount`, `leafId`, optional `name`. |
| Session export (`/export`) | `_bodhi-pi/session/export` | ✅ | JSONL header line + active-branch entries. CLI prints to stdout; browser hosts copy to clipboard. |
| Session deletion | `_bodhi-pi/session/delete` | ✅ | Pre-existing extension method. |

## Deferred

| Feature | Reason |
|---|---|
| `/import` (re-create a session from JSONL) | Out of scope for the Phase B–D minimum. Round-trip with `/export` requires schema validation and security review (untrusted bytes); revisit if a real consumer needs it. |
| `/goto` persistence in the http host | The http host rebuilds the agent per turn, so the in-memory leaf is lost across requests. Persisting `leaf_id` in the SQLite stores would unblock it (one-column schema migration in `bodhi-pi-node`, `bodhi-pi-ws-server`, and `bodhi-pi-http` plus `setLeafId` impls). |
| LLM-generated `branch_summary` on cross-branch navigation | `/tree` + `/goto` work without summarization. Adding a summarization LLM call on navigation can land if a host needs the abandoned-branch context surfaced. |
| Overflow-driven compaction recovery | Token-threshold auto-compaction shipped (Phase E). Provider-overflow detection + auto-retry of the failed call (per coding-agent's `isContextOverflow`) is a follow-up. |
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
