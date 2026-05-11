# Upstream sync report — 2026-05-11

## Base shift

|              | Commit     | Date       | Subject                                                                 |
| ------------ | ---------- | ---------- | ----------------------------------------------------------------------- |
| **Old base** | `50993d74` | 2026-05-07 | chore(coding-agent): switch back from fork to upstream jiti 2.7 (#4244) |
| **New base** | `f348a062` | 2026-05-10 | test(agent): cover harness stream configuration                         |

- Window: 3 days, **85 upstream commits** touching `packages/{ai,agent,coding-agent}`.
- Package versions: `0.73.0` → `0.74.0` (also published `0.73.1` mid-window, then jumped to `0.74.0`).
- Package scope renamed: `@mariozechner/*` → `@earendil-works/*` (commits `3e5ad67e`, `551385e4`).

## Scope of this report

Covers only the three packages bodhi-pi imports from:

- `@earendil-works/pi-ai` (was `@mariozechner/pi-ai`)
- `@earendil-works/pi-agent-core` (was `@mariozechner/pi-agent-core`)
- `@earendil-works/pi-coding-agent` (mirror reference, no direct imports)

bodhi-pi-currently-imported symbols (audit baseline):

```
pi-ai          : Api, AssistantMessage, AssistantMessageEvent, ImageContent, Message,
                 Model, TextContent, ToolResultMessage, Usage, UserMessage,
                 completeSimple, fauxAssistantMessage, fauxToolCall,
                 getEnvApiKey, getModel, getModels, getProviders,
                 registerFauxProvider, type Context, type FauxProviderRegistration
pi-agent-core  : AgentMessage, AgentTool, AgentToolResult
pi-coding-agent: (none — bodhi-pi is a parallel mirror, not a dependent)
```

**None of the symbols above had a breaking signature change.** All upstream activity on the public API is purely additive. Verified with a clean rebuild of `@bodhiapp/bodhi-pi` against the new base (succeeds with no edits beyond the package-name rename).

---

## Public API changes

### `@earendil-works/pi-ai`

**Barrel additions** (`src/index.ts`):

```diff
+ export * from "./image-models.js";
+ export * from "./images.js";
+ export * from "./images-api-registry.js";
+ export * from "./providers/images/register-builtins.js";
```

**`src/types.ts` additions** (no removals, no signature edits to existing types):

| New symbol                                  | Kind      | Notes                                                                                                                    |
| ------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------ |
| `KnownImagesApi`, `ImagesApi`               | type      | New API axis (`"openrouter-images"` only known so far)                                                                   |
| `KnownImagesProvider`, `ImagesProvider`     | type      | New provider axis (`"openrouter"` only known so far)                                                                     |
| `ImagesOptions`, `ProviderImagesOptions`    | interface | Mirrors `StreamOptions` shape (signal/apiKey/onPayload/onResponse/headers/timeoutMs/maxRetries/maxRetryDelayMs/metadata) |
| `ImagesFunction`                            | type      | `(model, ImagesContext, options?) => Promise<AssistantImages>`                                                           |
| `ImagesInputContent`, `ImagesOutputContent` | type      | Aliases of `TextContent \| ImageContent`                                                                                 |
| `ImagesContext`                             | interface | `{ input: ImagesInputContent[] }`                                                                                        |
| `ImagesStopReason`                          | type      | `"stop" \| "error" \| "aborted"`                                                                                         |
| `AssistantImages`                           | interface | Image-mode equivalent of `AssistantMessage`                                                                              |
| `ImagesModel<TApi>`                         | interface | `Omit<Model<Api>, "api"\|"provider"\|"reasoning"\|"contextWindow"\|"maxTokens"\|"compat">` plus `api/provider/output`    |

**`AgentMessage` union widened (effectively breaking under strict TS):**

`AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages]`. The new `harness/messages.ts` declares-module-augments `CustomAgentMessages` with `bashExecution`, `custom`, `branchSummary`, `compactionSummary`. Any code that did `m.content` on a value typed as `AgentMessage` now fails type-check because `BashExecutionMessage` (and the others) lack `.content`. **Fix in callers:** narrow with `"content" in m` or `m.role === "user"|"assistant"|"toolResult"` before reading `.content`. Hit one test in this sync (`bodhi-pi/test/build-context.test.ts`); fixed in this commit.

**Existing types — additive field changes:**

- `KnownProvider` gained `"together"`.
- `OpenAICompletionsCompat.thinkingFormat` gained `"together"` literal (existing callers unaffected).
- `AnthropicMessagesCompat` gained two optional flags:
  - `sendSessionAffinityHeaders?: boolean` (default `false`) — for Fireworks-style replica routing.
  - `supportsCacheControlOnTools?: boolean` (default `true`) — set `false` for providers that reject `cache_control` on tool defs.

### `@earendil-works/pi-agent-core`

**Barrel additions — the entire `harness/*` subtree is now public:**

```diff
+ export * from "./harness/agent-harness.js";
+ export { collectEntriesForBranchSummary, generateBranchSummary,
+          prepareBranchEntries } from "./harness/compaction/branch-summarization.js";
+ export { calculateContextTokens, compact, DEFAULT_COMPACTION_SETTINGS,
+          estimateContextTokens, estimateTokens, findCutPoint, findTurnStartIndex,
+          generateSummary, getLastAssistantUsage, prepareCompaction,
+          serializeConversation, shouldCompact } from "./harness/compaction/compaction.js";
+ export * from "./harness/execution-env.js";
+ export * from "./harness/messages.js";
+ export * from "./harness/prompt-templates.js";
+ export * from "./harness/session/repo/jsonl.js";
+ export * from "./harness/session/repo/memory.js";
+ export * from "./harness/session/repo/shared.js";
+ export * from "./harness/session/session.js";
+ export * from "./harness/skills.js";
+ export * from "./harness/system-prompt.js";
+ export * from "./harness/types.js";
+ export * from "./harness/utils/shell-output.js";
+ export * from "./harness/utils/truncate.js";
```

This is the headline change of the window — see "Opportunities" below.

**`src/types.ts` additions** (no removals, no signature edits to existing types):

- `AgentLoopTurnUpdate` — `{ context?, model?, thinkingLevel? }`.
- `PrepareNextTurnContext extends ShouldStopAfterTurnContext`.
- `AgentLoopConfig.prepareNextTurn?: (ctx) => AgentLoopTurnUpdate | undefined | Promise<…>` — fired after `turn_end`, before the loop decides to start another provider request. Lets the caller swap context/model/thinking between turns within a single run.

**Visibility change:**

- `QueueMode = "all" | "one-at-a-time"` is now `export`ed (was internal). Non-breaking.

### `@earendil-works/pi-coding-agent`

bodhi-pi does not import from this package directly, so its public surface only matters as a reference for parity decisions. Most changes in the window are coding-agent-internal (TUI fixes, theme schema, npm-self-update detection). No removals; no breaking renames.

---

## Notable behavior changes (no API change)

### pi-ai

- **Fireworks compat hardening** (`99dc6fce`, `cb3c42ec`). Fireworks is now the canonical case for `sendSessionAffinityHeaders: true` + `supportsCacheControlOnTools: false`. If you ever route bodhi-pi through Fireworks, pick up these flags from the registered model — don't re-derive.
- **Together AI provider added** (`7adb8e76`). New `together` `KnownProvider` + `thinkingFormat`. No effect unless you register Together models.
- **Mixed chat-completion delta fix** (`6b271842`, `fa35c5fa`). Stream parsing now tolerates providers that interleave content/reasoning/tool deltas in a single SSE event. **bodhi-pi inherits this for free** through `streamSimple`/`completeSimple`.
- **OpenAI reasoning auto-disable** (`783e96a1`). When a model is registered without reasoning support, the OpenAI provider now drops `reasoning_effort` instead of erroring. Reduces `BadRequestError` noise from misconfigured models.
- **Codex WebSocket → SSE fallback** (`ce377fc4`, `78c3cbe0`). Codex provider gracefully degrades. Not used by bodhi-pi.
- **Bun WebSocket proxy env support** (`8c2e3edd`). Honors `HTTPS_PROXY`/`HTTP_PROXY` in Bun. Relevant only for Bun-hosted clients.
- **Xiaomi default switched to API-billing + per-region token-plan providers** (`b326bf1a`). Cosmetic for bodhi-pi unless you ship Xiaomi-region models.
- **Copilot Claude test alignment** (`533d3730`, `cf7f2e3d`). Internal, no caller impact.

### pi-agent-core

- **Harness state is now snapshotted per turn** (`322759a3`, `e25415dd`, `79db9d62`, `c0f416aa`). The new `AgentHarness` captures `{model, thinkingLevel, streamOptions, resources}` at turn start; mid-run mutations to harness fields don't bleed into the in-flight provider request. Important if you adopt `AgentHarness` and hand it long-lived references.
- **Resource loaders return diagnostics** (`ddb18640`). When a skill/prompt-template fails to load, the harness returns a `{loaded, errors}` shape instead of throwing — letting the host surface partial loads.
- **Resource invocation made explicit** (`e1647aaa`, `617d8b31`, `e1ca501d`, `530f14c0`, `3d0f5718`, `cdde2e89`, `e6121493`). The harness session/repo layout was refactored across ~7 commits during the `bigrefactor` branch; the externally visible API stabilized at `f348a062` but the underlying types churned. **Treat any internal harness types as not-yet-stable for at least one more release.**

### pi-coding-agent

- **Theme shared across package scopes** (`f8d0fa67`). After the rename, themes published by `@mariozechner/*` and `@earendil-works/*` could each register independently; this fix makes them share. Irrelevant to bodhi-pi (no theme system).
- **`.agents` skill provenance preserved** (`0f959751`). Skill metadata now records the source folder. If bodhi-pi-cli ever reads coding-agent skills, this makes "where did this skill come from" answerable.
- **Resource path disambiguation** (`3421726e`). Two skills with same name but different folders no longer collide silently. bodhi-pi has its own skill loader (`packages/bodhi-pi/src/skills/`); worth comparing the disambiguation rule.
- **Renamed npm self-update package detection** (`dacb7eaa`, `5e1e4c3c`). coding-agent self-update follows the renamed package on npm. Not relevant — bodhi-pi has no self-update.
- **macOS Option key fix** (`91bacac7`), changelog hyperlink fix (`defd7038`), theme schema URLs (`76131673`). TUI-only.

---

## Opportunities — what bodhi-pi can adopt

### 1. **Replace the bodhi-pi session/compaction/skills stack with `pi-agent-core`'s harness** (high value, large scope)

The newly public `harness/*` subtree is functionally the same shape as code bodhi-pi has been building independently:

| bodhi-pi today                                                                               | pi-agent-core/harness now exports                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/sessions/session-store.ts`, `in-memory-session-store.ts`, branch-summary, build-context | `harness/session/session.ts`, `harness/session/repo/{jsonl,memory,shared}.ts`, plus `SessionTreeEntry` discriminated union (`MessageEntry`, `ThinkingLevelChangeEntry`, `ModelChangeEntry`, `CompactionEntry`, `BranchSummaryEntry`, `CustomEntry`, `LabelEntry`, `SessionInfoEntry`) |
| `src/sessions/compaction.ts`, `auto-compact` machinery                                       | `harness/compaction/compaction.ts` (`compact`, `prepareCompaction`, `shouldCompact`, `findCutPoint`, `serializeConversation`, `estimateContextTokens`, `DEFAULT_COMPACTION_SETTINGS`, …)                                                                                              |
| `src/sessions/branch-summary.ts`                                                             | `harness/compaction/branch-summarization.ts` (`generateBranchSummary`, `prepareBranchEntries`, `collectEntriesForBranchSummary`)                                                                                                                                                      |
| `src/skills/`, `src/commands/`                                                               | `harness/skills.ts`, `harness/prompt-templates.ts`                                                                                                                                                                                                                                    |
| ad-hoc system-prompt assembly                                                                | `harness/system-prompt.ts`                                                                                                                                                                                                                                                            |
| custom message normalization                                                                 | `harness/messages.ts`                                                                                                                                                                                                                                                                 |

The harness exports `AgentHarness` as a class (`packages/agent/src/harness/agent-harness.ts`) plus 76 supporting types in `harness/types.ts`. Adopting it would let bodhi-pi delete a lot of code, **but**:

- The CLAUDE.md rule "Mirror coding-agent" predates this harness existing — that mirroring decision was made when these primitives were private. Re-evaluate.
- The harness types churned heavily across the 3-day window (see "Resource invocation made explicit" above). Pin the exact upstream commit before adopting; don't track HEAD.
- Some bodhi-pi shapes (notably `SessionEntry`, `SessionInfo`, `SessionRecord`) are intentionally not re-exported (per CLAUDE.md "ACP is the public contract"). Adoption must keep that boundary — wrap, don't re-export.

**Recommendation:** worth a dedicated design pass. File as a follow-up; do not bundle with this sync.

### 2. **`AgentLoopConfig.prepareNextTurn`** (low scope, drop-in)

If bodhi-pi ever needs to swap the model or context mid-run (e.g., switch to a smaller model after the first turn, inject extra context after compaction), this callback now exists upstream. Today bodhi-pi solves this either by issuing multiple `agent.loop()` calls or by pre-mutating `AgentContext`. The new hook is cleaner.

Concrete candidate: post-compaction model swap in `src/sessions/compaction.ts`.

### 3. **Together AI as an optional model registration** (trivial)

If your model registry surfaces user-supplied providers, `KnownProvider` now includes `"together"`. No code change required to support it; just make sure the model JSON allows the literal.

### 4. **Lift Fireworks compat flags from the registered Model** (defensive)

If users configure Fireworks endpoints in bodhi-pi, ensure the `Model<Api>.compat` you store carries `sendSessionAffinityHeaders: true` and `supportsCacheControlOnTools: false`. Without these, prompt-cache hit rate degrades and tool calls may be rejected. Pure config — no bodhi-pi code change.

---

## Risks — what could break or needs attention

### 1. **Package-name rename is the only forced change** (already applied)

Done in this rebase: 102 files in `packages/bodhi-pi*` had `@mariozechner/` → `@earendil-works/`. Four `package.json` deps bumped from `^0.73.0` → `^0.74.0`. `bodhi-pi-browser` and `bodhi-pi-web` use `"*"` so untouched.

### 2. **Symbol-name collisions if you ever `export *` from bodhi-pi**

bodhi-pi has internal modules with names identical to upstream's newly public ones (`compaction`, `branch-summary`, `session`, `skills`, `prompt-templates`, `system-prompt`). This is fine while bodhi-pi's barrel is curated, but a sloppy `export * from "./sessions"` followed by `export * from "@earendil-works/pi-agent-core"` would clash. Keep the curation rule explicit in CLAUDE.md if you don't already.

### 3. **Harness types are not stable yet**

Across the 3-day window the harness session/repo layout was rewritten ~7 times (commits `e1647aaa`, `617d8b31`, `e1ca501d`, `530f14c0`, `3d0f5718`, `cdde2e89`, `e6121493`). The `f348a062` snapshot compiles cleanly today, but anything that imports from `@earendil-works/pi-agent-core/harness/*` should expect at least one more wave of refactors. Don't depend on it for adapter-level packages (`bodhi-pi-node`, `bodhi-pi-browser`) yet.

### 4. **`Tool.name` confusion (false alarm — recorded for posterity)**

During the build-verification step of this rebase, `tsgo` and `tsc` both reported `Property 'name' does not exist on type 'AgentTool<…>'` against `packages/bodhi-pi/src/tools/*.ts` and `extensions/{merge,tool-adapter}.ts`. **This was a transient artifact** — likely stale workspace symlink resolution from running build before `npm install` had fully settled. A clean rebuild after `npm install` succeeds with no changes. `Tool.name` is unchanged in upstream's source and `.d.ts`. No action required.

### 5. **No behavior-level surprises in the symbols bodhi-pi imports**

`completeSimple`, `streamSimple`, `getModel`, `getModels`, `getProviders`, `getEnvApiKey`, the faux provider helpers (`fauxAssistantMessage`, `fauxToolCall`, `registerFauxProvider`), and the type imports (`Api`, `Model`, `Message`, `AssistantMessage`, `UserMessage`, `ToolResultMessage`, `AssistantMessageEvent`, `TextContent`, `ImageContent`, `Usage`, `Context`, `FauxProviderRegistration`, `AgentMessage`, `AgentTool`, `AgentToolResult`) all preserve their 0.73.0 contracts. The mixed-delta and OpenAI-reasoning fixes change behavior under the hood but in a strictly more-tolerant direction.

---

## Suggested follow-ups (file as separate work, not in this sync)

1. **Design doc: "Adopt or skip pi-agent-core/harness?"** — compare the harness API against bodhi-pi's session/compaction/skills/prompt-templates code, decide whether to consolidate. Big enough to deserve its own ai-docs/research entry.
2. **Spike: `prepareNextTurn` for post-compaction model swap.** Small enough to land as one PR if useful.
3. **Pin Fireworks compat flags in any user-supplied model JSON examples.** Documentation-only.
4. **Verify each `bodhi-pi-*` package builds against the new base.** Remaining: `bodhi-pi-node`, `bodhi-pi-browser`, `bodhi-pi-cli`, `bodhi-pi-http`, `bodhi-pi-ws-server`, `bodhi-pi-web`, `bodhi-pi-ws-frontend`, `bodhi-pi-chrome-ext`. (`bodhi-pi` core verified.)

---

## Appendix — full upstream commit list (50993d74..f348a062, ai/agent/coding-agent)

```
f348a062 test(agent): cover harness stream configuration
c0f416aa feat(agent): add harness stream configuration
f8d0fa67 fix(coding-agent): share theme across package scopes
f6b6b1f0 Merge pull request #4354 from haoqixu/fix-bun-ws-proxy
cb3c42ec Merge pull request #4358 from yanirz/fix/fireworks-session-affinity-cache
533d3730 fix(ai): align copilot claude adaptive test
cf7f2e3d fix(ai): update copilot claude test model
e25415dd refactor(agent): finalize harness resource config
79db9d62 refactor(agent): make harness resources explicit
99dc6fce fix(ai): add session affinity and compat fixes for Fireworks provider caching
fe6b85b3 docs(agent): clarify harness lifecycle state
322759a3 refactor(agent): snapshot harness turn state
76131673 docs(coding-agent): update theme schema URLs
8c2e3edd fix(ai): respect proxy envs in bun's websocket
f13e6a88 test(agent): pin harness resource formatting
401017a3 refactor(agent): rename resource formatting helpers
7adb8e76 feat(ai): add Together AI provider
9751057b Merge pull request #3887 from cristinaponcela/feat/image-outputs
91bacac7 fix(coding-agent): show Option key on macOS
c889ff40 Merge pull request #4282 from PriNova/tw/fix-docs
dfb9ffa9 Merge pull request #4299 from aliou/fix/resource-location-in-config-tui
defd7038 fix(coding-agent): hyperlink update changelog closes #4280
90c017b0 Merge remote-tracking branch 'origin/main' into bigrefactor
e1647aaa refactor(agent): make resource invocation explicit
8fa1194c fix: no fallback for apiKey
0e4f845c fix: lazy loading
3421726e fix(coding-agent): disambiguate resource paths
323abaea docs(coding-agent): fix termux-open chooser flag
783e96a1 fix(ai): disable OpenAI reasoning where supported
dacb7eaa fix(coding-agent): detect renamed npm self updates
f4fc04cd doc: Update readmes
b38bd49b Add [Unreleased] section for next cycle
1eee081e Release v0.74.0
551385e4 chore: migrate packages to earendil works scope
ffdf426e Merge remote-tracking branch 'upstream/main' into feat/image-outputs
147f8158 Add [Unreleased] section for next cycle
781152fc Release v0.73.1
7fa924b7 docs: audit unreleased changelog entries
e5b809e7 update changelog
32b2cd07 delete: images()
5e1e4c3c feat(coding-agent): support renamed self-update package
3e5ad67e chore: migrate pi packages to earendil works scope
36804182 Merge branch 'main' into bigrefactor
9eb126e7 docs(ai): document interleaved stream events
fa35c5fa Merge pull request #4247 from badlogic/separate-accumulators
65206cfb docs(agent): document harness resource types
af2b3ee2 Merge branch 'main' into bigrefactor
6b271842 fix(ai): handle mixed chat completion deltas
ddb18640 feat(agent): return diagnostics from resource loaders
617d8b31 refactor(agent): tighten harness environment and resources
e1ca501d refactor(agent): expose concrete harness
530f14c0 refactor(agent): expose concrete harness session
0f959751 fix(coding-agent): preserve .agents provenance in skill metadata
074747c6 docs: readme image section
3728e4b9 e2e: add images test
0d96b9be rename: generateImages
60e885f9 refactor: image providers into subfolder
0a032ae1 Merge branch 'main' into bigrefactor
5731e13a Merge branch 'main' into feat/image-outputs
ab14238f dog
b9c19135 cleanup
63c61aac feat: image models
d9adc536 feat: openrouter images
e9b0af0a feat: images stream
62d91326 feat: images registry
e3d066da feat: images api types
cbf3c333 revert
d29e47c7 feat(agent): add harness factory helpers
c5340670 Merge remote-tracking branch 'origin/main' into bigrefactor
78c3cbe0 fix(coding-agent): close codex websocket sessions
ce377fc4 fix(ai): fall back from codex websocket to sse (#4133)
b326bf1a feat(ai): switch xiaomi default to api billing, add per-region token plan providers (#4112)
924a1395 test(ai,coding-agent): stabilize env-sensitive test cases (#4119)
05abdd8f fix(ai): fix mismatch between models.dev and OpenCode Go (Qwen3.5/3.6, MiniMax M2.7) (#4110)
e1433cf6 fix(ci): repair failing test expectations
8940c023 feat(read): compact resource read rendering
3d0f5718 refactor(agent): simplify harness session repo layout
cdde2e89 refactor(agent): consolidate harness session abstraction
e6121493 refactor(agent): tighten harness session storage
83599e78 feat(agent): split harness compaction and session modules
a5b27367 feat(agent): add initial harness foundation
59a89e0c fix: modalities from openrouter
e9414b05 fix
364ac0f3 fix: test (openRouterImageGeneration)
c3c10737 feat: image content
```
