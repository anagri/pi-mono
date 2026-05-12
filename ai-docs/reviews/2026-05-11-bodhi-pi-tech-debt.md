# bodhi-pi review — tech-debt

**Snapshot:** 2026-05-11, HEAD `76f09088`. Package in scope: `packages/bodhi-pi`
(adapters and reference hosts excluded per user direction). Whole-package
audit: agent.ts decomposition, cross-file duplication, ACP extension-method
catalog, settings-vs-KV consolidation, event-driven gaps, notification usage,
e2e coverage, feature-implementation cleanliness. Every finding below has
been verified against the current tree, has a concrete file:line, and is
fix-now actionable.

---

## Progress (last updated 2026-05-12)

| Batch | Status | Notes |
|---|---|---|
| **A** Stable-ACP notifications | ✅ shipped | `config_option_update` + `session_info_update` wired via internal subscribers; clean break on the four ext responses. Plan: `ai-docs/plans/smooth-purring-patterson.md`. **A.3** marked **obsolete (kept `dist/` import)** — see `packages/bodhi-pi/CLAUDE.md` "pi-agent-core import policy" + Decision log entry 2026-05-12. |
| **B** `agent.ts` decomposition + `gpt-4o-mini` removal | ✅ shipped | B.1 dispatcher Map; B.2 saturated `requireSession`/`requireSessionRecord`/`validateSessionId`/`optionalSessionId`; B.3/B.4 `setAt`/`effectiveSettings` reuse; B.5/B.6 `runAndPersistCompaction` + `makeCompactionEntry`; B.7 `finishTurn` closure; B.8 `_buildSessionState` split into `loadProjectArtifacts` + `composeSystemPrompt` + `createPiAgent`; B.9 `SessionState` → `SettingsState` + `SessionRuntime`; **B.10 BREAKING** — no hardcoded `gpt-4o-mini`, `currentModelId` becomes `string \| null`, `prompt()` rejects with branched hint, `ModelSelectEvent.fromModelId` widens to `string \| null`. All eight downstream hosts updated to render the empty-model state. Kickoff: `ai-docs/reviews/kickoff-batch-3-agent-decomposition.md`. |
| **C** `compaction.ts` ↔ `branch-summary.ts` dedup | ✅ shipped | (implemented in batch 2 — `sessions/_shared.ts` extraction + `runSummarizationLLM` wrapper) |
| **D** `sessions/build-context.ts` cleanup | ✅ shipped | (implemented in batch 2 — `walkPath` reuse in `buildSessionContext` + `createInMemorySessionStore.forkRecord` + `wrapAsUserMessage` consolidation) |
| **E** Event system: generalize emitter, fill gaps | ✅ shipped (with A) | 8 new events (`auth_change`, `settings_change`, `compaction_start`/`end`, `branch_summary_created`, `session_navigate`, `session_fork`/`clone`); generic `emit<E>`; `safeRun` JSDoc. **E.4** (`advertiseSlashable` refresh hook) deferred — folded into batch 4 below. |
| **F** ACP extension-method catalog hygiene | 🔜 **next (with E.4)** | F.1 capability advertisement (collapse to single `version` flag) + F.2 `EXT_SESSION_CONFIG` slimdown; bundled with E.4 since both touch ext surface. Kickoff: `ai-docs/reviews/kickoff-batch-4-acp-hygiene-and-slashable-refresh.md`. |
| **G** Dead code (`LabelEntry`) | ✅ shipped (with A) | Removed from union, exports, downstream imports. |
| **H** Tests + e2e gaps | ⏭ deferred | H.1/H.2/H.3; the settings/kv e2e in H.3 are now unblocked since the notification API shipped in A. |

**Batch 3 verification:** All `bodhi-pi` unit + integration + e2e green (338 + faux integration + real-LLM e2e); 8 downstream hosts (`bodhi-pi-node`, `bodhi-pi-browser`, `bodhi-pi-cli`, `bodhi-pi-web`, `bodhi-pi-chrome-ext`, `bodhi-pi-ws-server`, `bodhi-pi-ws-frontend`, `bodhi-pi-http`) build clean and pass full Playwright suites under `just test`; `npm run check` (biome + tsgo across every package) clean. Two flaky-on-parallel cases re-passed standalone.

**First-ship verification (batch 1):** 531 unit tests across 6 packages green; biome clean; tsgo clean (modulo pre-existing `BootstrapResult` errors in `bodhi-pi-web` / `bodhi-pi-chrome-ext` unrelated to this work). Implementation plan: `ai-docs/plans/smooth-purring-patterson.md`.

---

## Batch sequence

Batches ship one at a time, in the order below. Each row is a self-contained shippable unit; the kickoff prompt for the **next 🔜 batch** lives at the path in its row.

| # | Batch(es) | Status | Kickoff |
|---|---|---|---|
| 1 | A + E + G.1 (stable-ACP notifications, event-system overhaul, dead-code) | ✅ shipped | `ai-docs/plans/smooth-purring-patterson.md` |
| 2 | C + D (`sessions/` dedup) + bonus: `walkPath` reuse in `in-memory-session-store.forkRecord`, `joinTextBlocks` helper, `runSummarizationLLM` wrapper | ✅ shipped | `ai-docs/reviews/kickoff-batch-2-sessions-dedup.md` |
| 3 | B (`agent.ts` decomposition: dispatcher table, saturated `requireSession`, `finishTurn` helper, `_buildSessionState` split, `SessionState` split) + **B.10 BREAKING** removal of hardcoded `gpt-4o-mini` fallback | ✅ shipped | `ai-docs/reviews/kickoff-batch-3-agent-decomposition.md` |
| 4 | F (capability advertisement + `EXT_SESSION_CONFIG` slimdown) + E.4 (`advertiseSlashable` refresh hook) | 🔜 **next** | `ai-docs/reviews/kickoff-batch-4-acp-hygiene-and-slashable-refresh.md` |
| 5 | H (test helper extraction + e2e gap fills, including settings/kv now unblocked by batch 1) | ⏭ pending | TBD |

The next kickoff is drafted only after the previous batch ships. The order above is a recommendation, not a contract — each batch's "go" decision is made when its turn arrives, with the option to re-order based on what surfaced.

### Decision log

- **Clean break on `configOptions` response field** (batch 1, locked 2026-05-11): no dual-write. All hosts updated in the same series. Picked over dual-write for cleaner code, single source of truth, and no deprecation cycle.
- **Internal subscriber pattern for picker refresh** (batch 1, locked 2026-05-11): the agent registers its own subscriber on `auth_change`/`settings_change`/`model_select` and dispatches `config_option_update`. Same hook surface available to extensions. Demonstrates the pattern; collapses the four ad-hoc `affectsPicker` blocks into one subscriber.
- **Sequential batches, no parallel worktrees** (locked 2026-05-11): one batch at a time. Trades speed for simpler reasoning about where work stopped and what changed.
- **A.3 reversal — keep `Agent` import from `@earendil-works/pi-agent-core/dist/agent.js`** (batch 2, locked 2026-05-12): the upstream barrel transitively re-exports `harness/env/nodejs.ts` + `harness/session/storage/jsonl.ts` + `harness/session/storage/memory.ts` + `harness/utils/shell-output.ts`, all of which import `node:fs`/`node:path`/`node:os`/`node:crypto` at module top level. Bundlers can't reliably tree-shake those when shipping to browser hosts (`bodhi-pi-browser`, `bodhi-pi-web`, `bodhi-pi-chrome-ext`). Direct deep import keeps the runtime graph minimal. Documented as policy in `packages/bodhi-pi/CLAUDE.md` ("pi-agent-core import policy") so future agents don't "fix" it.
- **Single shared module `sessions/_shared.ts`, flat layout** (batch 2, locked 2026-05-12): bodhi-pi keeps the existing flat `sessions/` layout instead of mirroring upstream's `compaction/` subfolder — minimizes diff and avoids file-move noise. Module-private (not in `src/index.ts`); matches the existing `walkPath` precedent.
- **Extract `runSummarizationLLM` even though upstream doesn't** (batch 2, locked 2026-05-12): upstream coding-agent's three call sites have heterogeneous post-call shapes (`{aborted}|{error}|{summary,readFiles,modifiedFiles}` etc.) that can't share a wrapper. bodhi-pi's three call sites have homogeneous shapes (throw on `stopReason==="error"`, `joinTextBlocks` on success). Net ~18 LOC reduction + a single testable surface for "how do we call the LLM for summarization."
- **`serializeConversation` is parameter-free** (batch 2, locked 2026-05-12): always includes thinking blocks, always truncates tool results at 2000 chars (upstream behavior). Removes `branch-summary.ts`'s pre-existing `.slice(0, 800)` + skip-thinking divergence. Verified the `/Outcome/` regex in `branch-summary.test.ts` matches the prompt body, not the conversation, so the test stays green.
- **System prompts and prompt bodies stay where they are** (batch 2, locked 2026-05-12): each module owns its own prompts. Touching them changes LLM output and would break test mocks.
- **`extMethod` dispatch becomes a `Map`, not a switch** (batch 3, locked 2026-05-12): private readonly `extHandlers: Map<string, ExtHandler>` populated in the constructor. Adds two LOC over a switch but keeps every handler discoverable as a sibling method (no hidden ordering, no `default:` fall-through). Symmetric with the slash-command dispatcher in the REPL.
- **Saturate, don't unify, the session-validation helpers** (batch 3, locked 2026-05-12): split into four — `requireSession` (in-memory `SessionState`), `requireSessionRecord` (storage-only lookup), `validateSessionId` (typed-string narrowing), `optionalSessionId` (id-or-undefined). One unified helper would force every caller to handle "loaded but not in-memory" cases that don't apply. Same `unknown session` / `not loaded` strings as before.
- **`SessionState` splits into `SettingsState` + `SessionRuntime`** (batch 3, locked 2026-05-12): no `RuntimeOnly` / `Persisted` axis, no `Pick<>`-derived sub-types. The two halves have genuinely independent lifecycles — settings is replaceable on every `_buildSessionState`, runtime survives. Composing into the outer `SessionState` keeps existing call sites working with one extra `.settings.` / `.runtime.` step.
- **No hardcoded `gpt-4o-mini` fallback (B.10)** (batch 3, locked 2026-05-12, BREAKING): `pickDefaultModelId` returns `string | null`; `currentModelId` is allowed to be `null`; `prompt()` rejects with a branched hint (empty-models → "configure provider auth", populated → "pick one with /model"). Picked over keeping the placeholder because the placeholder created silent 404s against OpenAI when no auth was wired, masking the real "no auth configured" condition. All eight downstream hosts surface the same hint at boot via a system message.
- **Folded F + E.4 into batch 4** (batch 4 plan, locked 2026-05-12): F is two findings on the ext-method surface (capability advertisement, `EXT_SESSION_CONFIG` slimdown) and E.4 is one finding on the same surface (slashable refresh hook). Shipping together avoids two churn cycles for downstream hosts that subscribe to `available_commands_update` and `agentCapabilities._meta`.

---

## Batch A — Adopt stable-ACP `config_option_update` / `session_info_update` notifications

The ACP SDK ships `sessionUpdate: "config_option_update"` (`/tmp/acp-sdk-inspect/package/dist/schema/types.gen.d.ts:787-805`, `:4347-4348`) and `sessionUpdate: "session_info_update"` (`:4167`, `:4349-4350`) as stable variants. bodhi-pi reaches for an ad-hoc response-side-channel instead, in four places, with no notification dispatch. The CLAUDE.md "Stable ACP over `unstable_*`" pillar is bent here.

**A.1** Picker refresh on auth/setting writes is bundled as a response field instead of an ACP notification.
- `packages/bodhi-pi/src/acp/agent.ts:650-660` (handleSettingsSet, `affectsPicker` block)
- `packages/bodhi-pi/src/acp/agent.ts:699-709` (handleSettingsUnset, same block)
- `packages/bodhi-pi/src/acp/agent.ts:754-760` (handleKvSet, `AUTH_PREFIX` block)
- `packages/bodhi-pi/src/acp/agent.ts:798-803` (handleKvRemove, same block)
- `packages/bodhi-pi/src/acp/agent.ts:1171` (setSessionConfigOption — stable-ACP-allowed but redundant once the notification fires)
- Fix: emit `await this.conn.sessionUpdate({ sessionId, update: { sessionUpdate: "config_option_update", configOptions } })` from a single helper. Drop the `configOptions` field from all four ext responses. Hosts subscribe once.

**A.2** `EXT_SESSION_SET_NAME` writes a `session_info` entry but never emits the spec-native `session_info_update` so other clients on the session see nothing.
- `packages/bodhi-pi/src/acp/agent.ts:849-870`
- Fix: after `appendEntry`, emit `sessionUpdate: "session_info_update"` with `{ title: name, updatedAt: new Date(now).toISOString() }`.

**A.3** ~~Direct dist import of `pi-agent-core` bypasses the package's public exports.~~ **OBSOLETE (batch 2, 2026-05-12)** — the deep import is intentional and must stay. See `packages/bodhi-pi/CLAUDE.md` "pi-agent-core import policy" for the full rationale (upstream barrel pulls in Node-only modules transitively; bundlers can't reliably tree-shake them; browser hosts break). Decision log entry dated 2026-05-12.
- `packages/bodhi-pi/src/acp/agent.ts:38` `import { Agent } from "@earendil-works/pi-agent-core/dist/agent.js";`

---

## Batch B — `agent.ts` (1893 lines) decomposition

The file is dominated by 21-arm `extMethod` dispatch and a 140-line session bootstrap. Validation pattern, the picker-refresh side-effect, and compaction triple repeat throughout. Quick-win refactors that do not change behaviour.

**B.1** `extMethod` is a 17-arm `if/else` chain that re-dispatches to private handlers; replace with a method table.
- `packages/bodhi-pi/src/acp/agent.ts:462-528`
- Fix: `private readonly extHandlers = new Map<string, (p: Record<string,unknown>) => Promise<Record<string,unknown>>>([[EXT_DELETE_SESSION, this.handleSessionDelete.bind(this)], …]);` populated in the constructor; `extMethod` becomes 5 lines. Eliminates the chain; symmetrically positions every handler.

**B.2** `requireSession` (declared at `agent.ts:531-541`) is used by exactly four handlers (settings get/set/unset/list) while twelve other handlers re-implement the `typeof sessionId !== "string"` + `sessions.get` + `RequestError(-32602)` boilerplate inline. Verified by `grep -c "typeof sessionId !== \"string\"" packages/bodhi-pi/src/acp/agent.ts` → 12.
- Inline copies: `agent.ts:464-468` (delete), `:808-813` (config), `:852-861` (setName), `:874-878` (stats), `:907-911` (export), `:929-933` (tree), `:963-973` (navigate), `:1025-1029` (entries), `:1047-1056` (fork), `:1078-1083` (clone), `:1094-1101` (compact), plus implicit re-checks in `handleKvSet:756-757` and `handleKvRemove:798-799`.
- Fix: split `requireSession` (live `SessionState`) from `requireSessionRecord` (load from store). Replace every inline check; for record-only handlers pass through `validateSessionId(method, params): string`.

**B.3** `handleSettingsSet` reimplements the canonical `setAt` from `core/settings-writer.ts:19-32` as an inline IIFE.
- `packages/bodhi-pi/src/acp/agent.ts:631-646`
- Fix: `session.sessionOverrides = setAt(session.sessionOverrides as Record<string, unknown>, path, value) as BodhiPiProjectSettings;` — `setAt` is already imported at `agent.ts:60`.

**B.4** `handleSessionConfig` reimplements `effectiveSettings(session)` (which exists at `agent.ts:560-565`) inline as a nested `mergeSettings(mergeSettings(...), …)`.
- `packages/bodhi-pi/src/acp/agent.ts:815-818`
- Fix: replace with `const effective = this.effectiveSettings(session);`.

**B.5** Compaction-summarize-rebuild block repeats three times verbatim: load record → walkPath → prepareCompaction → resolveApiKey → runCompaction → build CompactionEntry → appendEntry → reload + buildSessionContext → assign messages.
- `packages/bodhi-pi/src/acp/agent.ts:1102-1135` (handleSessionCompact, `customInstructions` arg)
- `packages/bodhi-pi/src/acp/agent.ts:1341-1371` (runProactiveCompaction, swallows errors)
- `packages/bodhi-pi/src/acp/agent.ts:1403-1427` (tryOverflowRecovery, swallows errors)
- Fix: extract `private async runAndPersistCompaction(sessionId, session, opts: { customInstructions?: string; swallowErrors: boolean }): Promise<{ messages: AgentMessage[] } | undefined>`. The three callers shrink to one line plus their unique post-condition.

**B.6** `CompactionEntry` literal repeats three times with the same eight fields.
- `packages/bodhi-pi/src/acp/agent.ts:1118-1127`, `:1356-1365`, `:1412-1421`
- Fix: single helper `makeCompactionEntry(parentId, result): CompactionEntry`. Folded into B.5's extraction.

**B.7** `agent_end` emission shape is duplicated four times across `prompt()` and `tryOverflowRecovery()`.
- `packages/bodhi-pi/src/acp/agent.ts:1281-1287` (cancelled branch)
- `packages/bodhi-pi/src/acp/agent.ts:1295-1300` (error-no-recovery branch)
- `packages/bodhi-pi/src/acp/agent.ts:1304-1309` (success branch)
- `packages/bodhi-pi/src/acp/agent.ts:1446-1451` (recovery-success branch)
- Fix: local helper `const finishTurn = (stopReason: AcpStopReason, errorMessage?: string) => events.emitAgentEnd({ type: "agent_end", sessionId, stopReason, messages: session.piAgent.state.messages, ...(errorMessage ? { errorMessage } : {}) });`.

**B.8** `_buildSessionState` is a 140-line factory mixing concerns: project-artifact loading, system-prompt composition, thinking-level resolution, retry-option resolution, `Agent` construction with five callbacks, and a 22-field `this.sessions.set(...)` literal.
- `packages/bodhi-pi/src/acp/agent.ts:1737-1876`
- Fix: extract `loadProjectArtifacts(cwd) → { commands, skills, contextFiles, projectSettings, globalSettings }` (lines 1750-1757), `composeSystemPrompt({ tools, skills, contextFiles, cwd, custom, append })` (lines 1768-1776), `createPiAgent({ retryOptions, initialState, callbacks })` wrapping the 60-line `new Agent({...})` (lines 1788-1847). Reduces `_buildSessionState` to ~30 lines of orchestration.

**B.9** `SessionState` mixes runtime, settings-snapshot, and parse-error fields in a single 22-field interface.
- `packages/bodhi-pi/src/acp/agent.ts:162-191`
- Fix: extract `interface SettingsState { globalSettings, projectSettings, sessionOverrides, projectSettingsPresent, globalSettingsPresent, projectSettingsParseError?, globalSettingsParseError? }` and `interface SessionRuntime { piAgent, currentModelId, thinkingLevel, pendingThinkingLevelChange, cancelled, leafId, overflowRecoveryAttempted }`. Compose into `SessionState`. Cuts the field count by half per interface and clarifies access patterns.

**B.10** Magic placeholder model id `"gpt-4o-mini"` returned when no auth and no openai catalog.
- `packages/bodhi-pi/src/acp/agent.ts:1663` and `:1731-1733` (`_resolveSessionModel` fallback)
- Fix: extract `const PLACEHOLDER_MODEL_ID = "gpt-4o-mini";` to module top with a `// boots a session that will fail loudly on first prompt unless /login runs` comment. Or throw a `RequestError(-32603, "no models available; configure auth via /kv set auth/<provider> ...")` and let the host explain.

---

## Batch C — `compaction.ts` ↔ `branch-summary.ts` duplication

Two siblings under `sessions/` independently implemented the same three primitives. The slim variants in `branch-summary.ts` are not "intentionally minimal" — they predate the richer `compaction.ts` versions.

**C.1** `FileOps` interface, `newFileOps`, `extractFileOpsFromMessage`, `computeFileLists`, `formatFileOperations` are duplicated between the two modules.
- `packages/bodhi-pi/src/sessions/compaction.ts:25-73` (canonical, with `formatFileOperations` XML wrap)
- `packages/bodhi-pi/src/sessions/branch-summary.ts:47-63` and `:158-162` (`extractFileOps` + an inline reimplementation of `computeFileLists`)
- Fix: extract `packages/bodhi-pi/src/sessions/_file-ops.ts` exporting all five names. `branch-summary.ts` imports and uses identically.

**C.2** `serializeConversation` duplicated, with semantic drift.
- `packages/bodhi-pi/src/sessions/compaction.ts:330-369` (includes thinking blocks, tool-result truncation via `truncateForSummary` capped at `TOOL_RESULT_MAX_CHARS=2000` (`:323`))
- `packages/bodhi-pi/src/sessions/branch-summary.ts:65-98` (no thinking, hard-coded `.slice(0, 800)` cap)
- Fix: move to `_file-ops.ts` (or `_serialize.ts`) with options `{ includeThinking: boolean; toolTruncateChars: number }`, default `{ true, 2000 }`. Branch-summary calls it with `{ false, 800 }`.

**C.3** `completeSimple` summarization wrapper repeats three times.
- `packages/bodhi-pi/src/sessions/compaction.ts:435-474` (`generateSummary`)
- `packages/bodhi-pi/src/sessions/compaction.ts:476-501` (`generateTurnPrefixSummary`)
- `packages/bodhi-pi/src/sessions/branch-summary.ts:140-156` (`runBranchSummary`)
- Fix: extract `runSummarizationLLM(model, apiKey, systemPrompt, conversationText, maxTokens, signal?): Promise<string>` to `_serialize.ts`. Each caller becomes one line plus the prompt-string assembly.

---

## Batch D — `sessions/build-context.ts` cleanup

**D.1** `walkPath` is duplicated inside `buildSessionContext`.
- `packages/bodhi-pi/src/sessions/build-context.ts:18-32` (exported)
- `packages/bodhi-pi/src/sessions/build-context.ts:96-108` (inline, identical algorithm)
- Fix: replace the inline block with `path = walkPath(entries, targetLeaf);`.

**D.2** Three near-identical user-message wrappers for the three checkpoint entry types.
- `packages/bodhi-pi/src/sessions/build-context.ts:40-51` (`compactionSummaryMessage`)
- `packages/bodhi-pi/src/sessions/build-context.ts:53-64` (`branchSummaryMessage`)
- `packages/bodhi-pi/src/sessions/build-context.ts:66-72` (`customDisplayMessage`)
- Fix: `function wrapAsUserMessage(text: string, timestamp: number): AgentMessage` plus three thin formatters that pass the wrapped XML/plain-text body. Drops three near-duplicate `as AgentMessage` casts.

---

## Batch E — Event system: generalize emitter, fill catalog gaps

`EventDispatcher` was added with purpose-built emitter methods per event type; with 17 observation-only events the boilerplate now dominates the file. The catalog also has visible gaps for state-changing extension methods, leaving extensions unable to react.

**E.1** Seventeen observation-only `emitX` methods are byte-for-byte identical except for the handler-map key and label string.
- `packages/bodhi-pi/src/events/dispatcher.ts:60-116`
- Fix: keep mutation-aware emitters (`emitInput`, `emitBeforeAgentStart`, `emitBeforeProviderRequest`, `emitToolCall`, `emitToolResult`) as-is. Replace the 17 observation-only methods with a single `private async emit<T extends keyof BodhiPiEventHandlers>(type: T, event: …)` plus 17 one-line delegators (or call-site direct `emit("session_start", …)`). ~50 LOC reduction.

**E.2** No event fires for state-changing extension methods, blocking extensibility.
- KV mutations (`auth/<provider>` set/remove): `packages/bodhi-pi/src/acp/agent.ts:741-804` — no `auth_change` event.
- Settings mutations: `packages/bodhi-pi/src/acp/agent.ts:606-710` — no `settings_change` event.
- Compaction execution (manual + proactive + recovery): `packages/bodhi-pi/src/acp/agent.ts:1092-1453` — no `compaction_start`/`compaction_end` events.
- Branch-summary creation: `packages/bodhi-pi/src/acp/agent.ts:980-1008` — no `branch_summary_created` event.
- Session navigate: `packages/bodhi-pi/src/acp/agent.ts:960-1021` — no `session_navigate` event.
- Session fork/clone: `packages/bodhi-pi/src/acp/agent.ts:1043-1090` — no `session_fork`/`session_clone` events.
- Fix: add the seven event types to `events/types.ts` + handler-map fields; emit at the cited sites. Move the picker-refresh side-effect (Batch A) to a `model_select`/`auth_change`/`settings_change` subscriber inside the agent itself, so the dispatch chain becomes uniform: emit event → subscriber emits `config_option_update` notification.

**E.3** `model_select` event fires only when the model changes via `setSessionConfigOption`, not when `defaultModel` changes via `_bodhi-pi/session/settings/set`.
- Fires: `packages/bodhi-pi/src/acp/agent.ts:1197-1202`
- Does not fire: `packages/bodhi-pi/src/acp/agent.ts:606-661` (`affectsPicker` recognises the key but only patches the response).
- Fix: emit `model_select` (or a new `default_model_change`) inside the settings handler when `path[0] === "defaultModel"` and the resolved model id differs from `session.currentModelId`.

**E.4** `advertiseSlashable` runs only at session boot; extensions registered after boot do not refresh `available_commands_update`.
- Callers: `packages/bodhi-pi/src/acp/agent.ts:329`, `:410`, `:426`. No re-fire path.
- Fix: expose `void requestSlashableRefresh(sessionId)` on `ExtensionAPI` so extensions that mutate their command registry can request a refresh; or fire automatically when `extensions/runner.ts:98` `registerCommand`'s closure runs after build is complete.

**E.5** Handler errors are silently swallowed by `safeRun`, undocumented.
- `packages/bodhi-pi/src/events/dispatcher.ts:50-57`
- Fix: add JSDoc to `BodhiPiEventHandlers` (`events/types.ts:208`) stating "Handler errors are caught, logged via `console.error`, and do not block peer handlers or event propagation."

---

## Batch F — ACP extension-method catalog hygiene

Per CLAUDE.md the 17 `_bodhi-pi/*` extensions are deliberate non-spec features. Most are correct (DAG-model concepts have no ACP equivalent). Two soft cleanups.

**F.1** `agentCapabilities._meta["bodhi-pi"]` advertises seven capabilities while seventeen extension methods are implemented. Hosts cannot probe for `sessionFork`/`sessionClone`/`sessionTree`/`sessionEntries`/`sessionNavigate`/`sessionSetName`/`sessionStats`/`sessionExport`/`sessionSettings`/`kvStore`.
- `packages/bodhi-pi/src/acp/agent.ts:308-315`
- `packages/bodhi-pi/src/acp/constants.ts:8-56` (full method list)
- Fix: collapse to a single `version: BODHI_PI_VERSION` flag and document "if the agent advertises any `bodhi-pi.version`, all extensions listed in CHANGELOG for that version are present" — OR enumerate every method explicitly. Mid-state (current) is the worst of both.

**F.2** `EXT_SESSION_CONFIG` returns a 19-field response that overlaps `_bodhi-pi/session/settings/list?scope=effective` plus a handful of computed bits.
- `packages/bodhi-pi/src/acp/agent.ts:806-847`
- Effective merge already available via `EXT_SESSION_SETTINGS_LIST` at `:712-732` with `scope=effective`.
- Computed bits unique to `sessionConfig`: `cwd`, `currentModelId`, `thinkingLevel`, `retryOptions`, `contextFilePaths`, `defaultModelId`, parse errors.
- Fix: shrink `sessionConfig` to those seven unique computed bits; remove `projectSettings`/`globalSettings`/`sessionOverrides`/`layers`/`projectSettingsPresent`/`globalSettingsPresent` from the response. Hosts that need the merged view call `settings/list?scope=effective` (one extra round-trip; happens once per panel open).

(Note: `EXT_SESSION_STATS`, `EXT_SESSION_ENTRIES`, `EXT_SESSION_EXPORT` were considered for client-side derivation. `TREE` returns previews + `role` only — not full content blocks — so `STATS` (toolCallCount needs content), `ENTRIES` (full preview text), and `EXPORT` (JSONL of full entries) cannot be derived from `TREE` as currently shaped. Keep all three.)

(Note: settings vs KV are correctly distinct — settings is structured/scoped/dotted-key config; KV is flat string→string with `secret?` masking and a single namespace. No consolidation.)

---

## Batch G — Dead code

**G.1** `LabelEntry` is defined, exported, and added to the `SessionEntry` union but never created or read by any code path in `packages/bodhi-pi/`, the adapters, or any host.
- `packages/bodhi-pi/src/sessions/entries.ts:61-65` (definition)
- `packages/bodhi-pi/src/sessions/entries.ts:96` (in union)
- `packages/bodhi-pi/src/sessions/session-store.ts:8` (re-imported)
- `packages/bodhi-pi/src/index.ts:99` (re-exported)
- Fix: delete the interface, drop from the union, drop the imports/exports. Verified absent in `grep -rn "LabelEntry\\|type: \"label\"" packages/`.

---

## Batch H — Tests: helper extraction + e2e gaps

**H.1** `auto-compact.test.ts` and `overflow-recovery.test.ts` share a 28-line provider-management boilerplate (imports, `providers` array, `beforeEach`/`afterEach` reset, `newProvider()` factory).
- `packages/bodhi-pi/test/auto-compact.test.ts:1-28`
- `packages/bodhi-pi/test/overflow-recovery.test.ts:1-28`
- Fix: extract `test/helpers/faux-provider-pool.ts` exporting `useFauxProviderPool()` returning `{ newProvider }` and wiring beforeEach/afterEach internally.

**H.2** Compaction e2e is 56 lines and covers only manual `/compact`. Auto-compact and overflow-recovery have no real-LLM validation.
- `packages/bodhi-pi/e2e/compaction.e2e.ts:1-56`
- In-process coverage exists: `packages/bodhi-pi/test/auto-compact.test.ts`, `packages/bodhi-pi/test/overflow-recovery.test.ts`.
- Fix: add `e2e/auto-compact.e2e.ts` driving a long enough conversation against `gpt-4o-mini` to trip `contextTokens > contextWindow - reserveTokens`; assert a `CompactionEntry` is appended via `EXT_SESSION_TREE`.

**H.3** Settings/KV/sessions/thinking features have full in-process coverage but no e2e.
- Settings: `test/settings.test.ts` (214) + `test/settings-slash.test.ts` (249); no `e2e/settings.e2e.ts`.
- KV: `test/kv-store.test.ts` (102) + `test/kv-slash.test.ts` (176); no `e2e/kv.e2e.ts`.
- Sessions DAG: `test/fork-clone.test.ts` (119) + `test/tree-navigate.test.ts` (114) + `test/branch-summary.test.ts` (92); no `e2e/sessions.e2e.ts`.
- Thinking: `test/thinking.test.ts` (167); no `e2e/thinking.e2e.ts`.
- Name/stats/export: `test/name-stats-export.test.ts` (102); no e2e.
- Fix: add one e2e per area asserting one stable side-effect against `gpt-4o-mini` (per CLAUDE.md "side-effects and stable substrings, not exact model text"). Settings e2e specifically should assert that after `/settings set defaultModel <other>`, the next `prompt()` round-trip uses the new model id (visible via `before_provider_request` event recorded payload).

---

## Where to look for ordering

The "Batch sequence" table near the top of this file is the live ship-order
plus status. Don't re-derive ordering from the batch list below — that's the
punch list, in alphabetical-batch order, not execution order.
