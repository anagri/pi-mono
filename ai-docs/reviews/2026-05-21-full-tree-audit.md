# bodhi-pi review — full-tree-audit

**Snapshot:** 2026-05-21, working tree at HEAD `0c88ce3b` (last bodhi-pi-touching
commit `7d4677c8`; uncommitted in-scope edits in
`e2e/helpers/browser/acp-connection.ts`,
`test-apps/browser/src/host/runtime/bootstrap-worker.ts`,
`test-apps/cli/src/host/cli.ts`). Packages in scope: `packages/bodhi-pi`
(`src`, `test`, `e2e`, `e2e-ui`, `test-apps`, `scenarios`) +
`ai-docs/specs/bodhi-pi`. Revised to fold in review feedback: runtime-specific
skips are to be **eliminated by making all runtimes behave consistently** (http/
ws per-turn rebuild and browser/chrome-ext worker reload are a PoC that every
runtime behaves the same), not documented as permanent. Every finding is
verified against the current tree with a concrete file:line and is fix-now
actionable. The deprecated top-level `packages/bodhi-pi-{cli,web,browser,node,
http,chrome-ext,ws-*}` are out of scope.

**Ordering:** code is the source of truth; e2e/e2e-ui/integration tests verify
behavior. Land the code-fix batches (A, B, D, E, F, G, H) first; the spec-refresh
batch (C) lands last so the specs are regenerated against the corrected code.

---

## Batch A — Cross-runtime consistency: eliminate runtime-specific skips (Commit 1)

The goal is consistent behavior across all runtimes so the gates disappear, not a
SKIPPED.md that enshrines them.

**A.1** After A.2–A.4, the only legitimate residual gate is the stdio
spawn-capability partition (A.4). Create `packages/bodhi-pi/e2e/SKIPPED.md` and
`packages/bodhi-pi/e2e-ui/SKIPPED.md` documenting that one entry plus the
PARITY.md-tracked deferrals (auto-compaction per-host e2e `PARITY.md:15`,
streaming-tool e2e `PARITY.md:68`) as a table
`spec/test | gate | runs-on / skips-on | reason`. Everything else in this batch
is removed, not documented.

**A.2** Remove the `bash` in-memory gate by wiring just-bash into the in-memory
harness. `e2e/shared/bash.e2e.ts:17` `runIf(!isRuntime("in-memory"))` exists only
because the in-memory harness has no Terminal. just-bash is runtime-neutral and
runs over any injected `Filesystem`:
`test-apps/app-utils/just-bash-terminal.ts:30`
`createJustBashTerminal(BashCtor, { filesystem })` +
`test-apps/app-utils/just-bash-fs-adapter.ts:41` `createJustBashFsAdapter`.
`e2e/helpers/in-memory/harness.ts:23` already injects a default `scriptExecutor`
over the in-memory FS — inject a just-bash `Terminal` the same way (Node
`just-bash` ctor over the in-memory `Filesystem`), then delete the `runIf` so the
`bash` tool is exercised on every runtime.

**A.3** Make per-turn-rebuild (http/ws) and worker-reload (browser/chrome-ext)
runtimes rehydrate full session state on each incoming request, mirroring
`session/resume`, so three gates vanish. (a) Session-scope settings: today
`e2e/shared/settings.e2e.ts:61` `if (!isRuntime("http"))` skips all session-scope
assertions because overrides "reset before the next read" under per-turn rebuild
(`settings.e2e.ts:57-60`) — persist session-scope setting overrides into the
session store (the mechanism `model_change`/`thinking_change` entries already use,
`src/sessions/entries.ts`) so http rehydrates them per turn; remove the gate.
(b) MCP connection restore: `e2e-ui/shared/mcp-multi.spec.ts:82`
`test.skip(!inProcess, …)` skips page-reload restore on http/ws — implement
consistent restore (server-side store already exists, `PARITY.md:26`) so the
behavior holds on all runtimes; remove the skip. (c) Explicit resume:
`e2e/shared/sessions.e2e.ts:63` `if (!isRuntime("http"))` skips the explicit
`resumeSession` RPC because http doesn't expose it — make http accept
`session/resume` idempotently (it already resumes implicitly) so the assertion is
uniform; remove the gate.

**A.4** The stdio MCP partition is the one genuine capability boundary — keep and
document. `e2e/shared/mcp-stdio.e2e.ts:12,51` `runIf(in-memory||cli)` paired with
`:95` `runIf(http||ws||browser||chrome-ext)`: stdio needs `child_process.spawn`,
which browser/chrome-ext fundamentally cannot do, and the `:95` test already
makes behavior consistent (unsupported → clean `-32601`). This is the parity
contract for an unsupportable capability, not an inconsistency to fix.

---

## Batch B — Reference-host feature parity (Commit 2)

**B.1** Implement session-management commands in the browser-family client so
`e2e-ui/shared` runs them on every Playwright project.
`test-apps/cli/src/client/lib/commands.ts` handles `/compact` (:230), `/entries`
(:245), `/tree` (:263), `/goto` (:284), `/name` (:335), `/export` (:374),
`/config` (:386); the shared browser dispatcher
`test-apps/browser/src/client/lib/commands.ts` (reused by http + chrome-ext via
`AppShell` — `http/src/client/react/App.tsx:3`,
`chrome-ext/src/client/react/App.tsx:1`) handles none of them (cases:
`model/sessions/new/resume/close/fork/clone/mcps/mcp/agents/subagent` only). Add
the cases (all SDK methods exist, `src/client/client.ts:442-493`) and add
`e2e-ui/shared/*.spec.ts` coverage; update PARITY.md:14-32 once parity is real.

**B.2** Implement settings/auth commands in the browser-family client.
`test-apps/cli/src/client/lib/commands.ts` has `/settings` (:409), `/login`
(:483), `/logout` (:498), `/logins` (:514); the browser-family dispatcher has
none (auth is only the `SetupForm.tsx` UI). PARITY.md:43 claims all four Hosts
"ship word-for-word identical surface" — wire these into
`browser/src/client/lib/commands.ts` with matching `e2e-ui` coverage, then
reconcile PARITY.md:43.

**B.3** MCP and subagent slashes are missing from the cli INTERACTIVE REPL. The
REPL routes every line through `handleCommand`
(`test-apps/cli/src/client/acp/repl.ts:117` → `…/lib/commands.ts`), which has no
`/mcp`, `/mcps`, `/agents`, or `/subagent` case — those live only in the headless
dispatcher `test-apps/cli/src/client/acp/headless.ts:39,82-90,124`. Route REPL
unknown-commands through the headless dispatcher or add the cases.

**B.4** `/session` is overloaded inside cli: `…/lib/commands.ts:353` = session
stats; `…/acp/headless.ts:53` = `new|switch|list` registry management. Same token,
incompatible semantics. Pick one verb and align both cli dispatchers.

---

## Batch C — Lifecycle events: wiring decision + coverage (Commit 3)

**C.1** acp.md sequence diagrams promise clients three events the code never
delivers. Diagram 2 draws `ED-->>C: branch_summary_created` and
`ED-->>C: session_navigate`; diagram 4 draws `ED-->>C: compaction_end`. The sole
wire-translation surface `src/acp/event-wiring.ts` (`wireInternalEventHandlers`)
forwards only `mcp_status_change`, `mcp_tools_change`, `mcp_oauth_status_change`,
`subagent_start`, `subagent_end`. (`session_fork` and `compaction_start` are
correctly emit-only.) Source is in-process-only today, so the default fix is to
drop those three `ED-->>C` arrows from acp.md (Batch E); if remote clients must
observe them, instead add the forwarders to `event-wiring.ts` plus wire tests.
Decide explicitly and align spec to code.

**C.2** Wire-forwarded MCP events have no wire-level test — the failure mode the
"both rails" rule (and the `bafdb900` retro-fix) warns about; each runtime's
forwarder must yield the canonical event set once, and drift here is invisible.
Only `subagent_start`/`subagent_end` assert `harness.extNotifications`
(`test/subagents-wire-events.test.ts`). `mcp_status_change` is asserted in-process
only (`test/mcp.test.ts`, the `pi.on` handler); `mcp_tools_change` (emitted in
`src/mcp/mcp-connection-lifecycle.ts`, `emitToolsBroadcast`) and
`mcp_oauth_status_change` (emitted in `src/mcp/mcp-connection-lifecycle.ts`) are
asserted on neither rail. Add `extNotifications` assertions for all three,
including the `sessionId === ""` oauth-callback edge.

**C.3** In-process compaction/branch-summary events are emitted but untested.
`compaction_start`/`compaction_end` (`src/sessions/compaction-orchestrator.ts`,
the `runAndPersistCompaction` path) and `branch_summary_created`
(`src/sessions/session-graph-service.ts`) have zero event assertions;
`test/compaction.test.ts` and `test/branch-summary.test.ts` check side-effects
only. The in-process event is the contract extensions consume — add
`recorder()`-based assertions covering the `reason:
"manual"|"proactive"|"recovery"` discriminant and the `compaction_end`
failure-path `errorMessage`.

---

## Batch D — Source health (Commit 4)

**D.1** Dead code: `src/acp/agent.ts` `_resolveProviderStreamOptions` duplicates
the exported `resolveProviderStreamOptions` (`src/models/registry.ts`) and has
zero callers (one occurrence in the file — the definition). Delete it and trim
the now-unused `ProviderOptionsEntry` / `ResolvedRetryOptions` imports.

**D.2** Unsafe `as unknown as` casts that defeat type-checking on wire/event
boundaries: `src/acp/event-wiring.ts` (five
`e as unknown as Record<string,unknown>` in the lifecycle forwarders — fix while
extending for C.1/C.2 via a typed `lifecycleParams(event)` mapper);
`src/mcp/mcp-tool-adapter.ts` (`as unknown as AgentTool` on a fully-known shape);
`src/mcp/mcp-oauth-state-kv.ts` and `src/mcp/mcp-oauth-provider.ts`
(`as JsonValue` — tighten `serializeMcpServerEntry`'s return type instead);
`src/mcp/mcp-client.ts` (remote MCP `inputSchema`/`content` passed through
unvalidated); `src/models/registry.ts` (`as KnownProvider` is redundant —
`getProviders()` already returns `KnownProvider[]`).

**D.3** Duplicated guard: `requireKv`/`requireKvStore` are identical impls with
the same `-32601` message in `src/kv/kv-service.ts` and `src/mcp/mcp-store.ts`.
Extract one shared `requireKvStore(kv, method)`.

**D.4** Magic numbers next to named siblings:
`src/subagents/subagent-service.ts` hardcodes `160` (twice, the progress-snippet
cap) while `SUBAGENT_SUMMARY_MAX_CHARS`/`SUBAGENT_PROGRESS_TOOL_PREVIEW_CHARS` are
named; `src/sessions/compaction.ts` hardcodes `4800` (per-image token estimate in
`estimateTokens`). Name both.

**D.5** Long method: `src/subagents/subagent-service.ts` `spawn` (~165 lines)
concentrates child-record creation, link/complete persistence, fork-slice
computation, state build, MCP hydrate, abort wiring, prompt-loop run, status
mapping, and two event emits. Extract `appendLinkEntry`/`appendCompleteEntry` and
the status-derivation.

---

## Batch E — Spec freshness vs source (Commit 5, lands last)

Code is the source of truth; refresh specs after the code-fix batches so they
describe the corrected behavior. e2e/e2e-ui/integration tests remain the
verification layer.

**E.1** `ai-docs/specs/bodhi-pi/testing.md` documents per-host e2e/test
directories that do not exist (`test-apps/{cli,http,browser,chrome-ext}/e2e/*`,
`test-apps/browser/src/ui-lib/`). Actual: e2e lives centrally in
`packages/bodhi-pi/e2e/{shared,cli-headless}` + `packages/bodhi-pi/e2e-ui/shared`,
parametrized by `e2e/setup/*.ts`; the browser host is
`test-apps/browser/src/{host,client}`. Rewrite the section to the centralized
layout.

**E.2** `ai-docs/specs/bodhi-pi/client-sdk-seed.md` cites pre-split host paths
(`src/frontend`, `src/ui-lib`, `src/repl`). Actual:
`http/src/client/acp/acp-http-client.ts`, `browser/src/client/lib/commands.ts`,
`cli/src/client/acp/{repl,headless}.ts` + `cli/src/client/lib/commands.ts`.
Update the paths.

**E.3** `ai-docs/specs/bodhi-pi/mcp.md` cites the per-user MCP store at
`src/server/mcp/server-mcp-store.ts`; actual is
`test-apps/http/src/host/mcp/server-mcp-store.ts` (hosts.md has it right). Fix.

**E.4** Purge every numeric line citation from the specs and replace with
`file:symbol` (method/function/class/interface) — line numbers go stale
immediately (the current `src/acp/agent.ts:NNN` cites are already off by ~40-60
lines after the class grew). Ten of twelve files carry numeric cites: `acp.md`,
`architecture.md`, `client-sdk-seed.md`, `configuration.md`, `lifecycle.md`,
`mcp.md`, `mcp-gaps.md`, `extensions-skills-commands.md`, `hosts.md`, `index.md`.
Convert e.g. `src/acp/agent.ts:256-264` → `src/acp/agent.ts:extHandlers`,
`agent.ts:314` → `agent.ts:initialize`. Encode the rule ("no line numbers in
`ai-docs/specs/`; cite `file:symbol`") in `packages/bodhi-pi/CLAUDE.md`'s
"Specs are living docs" section so it stays enforced.

**E.5** `packages/bodhi-pi/e2e/CLAUDE.md` says "Same `e2e/shared/*.e2e.ts` files
run under four Vitest projects" with a four-row table; `vitest.e2e.config.ts`
defines SIX projects (adds `browser` and `chrome-ext`; the config comment itself
says "all 6 projects"). Update the table to six.

---

## Batch F — Test architecture (Commit 6)

**F.1** `test/subagents-llm-invocation.test.ts` is misnamed — it uses
`registerFauxProvider` + scripted `fauxToolCall("subagent", …)`, so it proves
schema enforcement, not that a real model invokes the tool. The
`*-llm-invocation` convention means "real LLM" (real proof is
`e2e/shared/subagents*.e2e.ts`). Rename to `subagents-schema-rejection.test.ts`.

**F.2** The faux-provider helper `scriptSubagentRun` (`test/helpers/`) is used in
2 files while the same hand-rolled faux pattern repeats in
`test/subagents-llm-invocation.test.ts`, `test/subagents-spawn.test.ts`,
`test/new-events.test.ts`, `test/events.test.ts`; 14 `subagents-*.test.ts` files
redeclare identical `providers=[]`/`beforeEach`/`afterEach`/`newProvider()`
boilerplate. Promote a `test/helpers/faux-provider.ts` fixture and adopt it.

**F.3** Brittle assertions: `test/compaction.test.ts` asserts on rigged aimock
canned `"rigged-summary-text"` (proves the mock echoed, not that compaction ran) —
also assert the `CompactionEntry` appended to the session (type +
`firstKeptEntryId` resolving to a real entry). `test/name-stats-export.test.ts`
uses loose `>= 2` lower bounds that pass on almost any non-empty session —
tighten to the exact seeded count.

**F.4** Clarify the stub-strategy rule in `packages/bodhi-pi/CLAUDE.md` (and
`DEVELOPMENT.md`): aimock is acceptable in `e2e/` and `e2e-ui/`; faux-provider is
preferred in `packages/bodhi-pi/test/` for tool-call rounds (aimock SSE isn't
reliably parsed for tool-call rounds). The current wording reads as a blanket
preference and caused a false "aimock misuse" reading of `test/chat.test.ts`
(whose aimock path is a text round-trip, not a tool-call round — legitimate).
State the e2e-OK / test-faux split explicitly.

---

## Batch G — Comments: necessity (Commit 7)

The repo rule: comments only for quirks/hackiness, never to restate code.
Quirk-explaining comments and the 3 `seam-exception:` markers are legitimate.
Violations:

**G.1** Stale cross-references (trunk-based dev — no PRs/plans/slices):
`src/mcp/mcp-oauth-provider.ts:105` "Per the prompt's locked decisions";
`test/helpers/env.ts:6` "at PR time"; `test-apps/http/src/host/acp/handler.ts:119`
"(see plan)"; `test-apps/http/src/host/acp/inflight.ts:14` "see plan doc";
`test-apps/node-adapters/kv-store.test.ts:10` + `test-apps/http/src/host/server.ts:71`
"slice 4"; `e2e/shared/mcp-session-resume.e2e.ts:18` "slice 3". Reword each to
describe the behavior; drop the PR/plan/slice reference.

**G.2** Restating comments (delete): `test-apps/http/src/host/acp/handler.ts:95`
"// Auth at the seam.", `:104` "// Parse body.";
`test-apps/http/src/host/acp/sse.test.ts:57`;
`test-apps/cli/src/client/lib/render.ts:55`.

**G.3** Test step/phase narration restating the next call (strip):
`e2e-ui/shared/session-tree.spec.ts:7,15,20,29,41,47` ("// Step N:");
`test/chat.test.ts:150,158,222,227,232,236,241`; `test/mcp.test.ts:206-207`;
`e2e-ui/shared/mcp-multi.spec.ts:51,55,59,63`. Keep only lines that add a
rationale; drop the bare restatements.

**G.4** Section-divider banners above self-named symbols: `src/events/types.ts`
~22 `// === Foo ===` banners (each above an `export interface FooEvent`),
`src/events/dispatcher.ts:74`, `src/client/types.ts:98`. Collapse to the few that
mark a non-obvious grouping; drop the rest.

---

## Batch H — e2e hygiene + adapter naming (Commit 8)

**H.1** Standardize all sub-agent e2e/e2e-ui specs on
`claude-haiku-4-5-20251001` — it reliably emits parallel tool calls and is more
reliable for sub-agent runs generally. Only `e2e/shared/subagents-parallel.e2e.ts:17`
uses haiku today; `e2e/shared/{subagents,subagents-builtin,subagents-fork,
subagents-list}.e2e.ts` use `gpt-4o-mini`, and
`e2e-ui/shared/subagents-parallel.spec.ts` runs on the fixtures default
`gpt-4o-mini` (`e2e-ui/fixtures.ts:62`) with a loosened `>= 2` assertion masking
the resulting flakiness. Switch them all to haiku
(`e2e-ui/helpers/prompts.ts:3` already exports `SWITCH_TARGET_MODEL =
"claude-haiku-4-5-20251001"`), and note the sub-agent haiku exception to the
"per-feature e2e uses gpt-4o-mini" rule in `packages/bodhi-pi/CLAUDE.md` +
`testing.md`.

**H.2** Stale "batch" naming survived the scrub commit `0c88ce3b`. The fixture
dir `scenarios/subagents-batch/` is still referenced by
`e2e/shared/subagents-parallel.e2e.ts` (`loadScenarioFiles("subagents-batch")`)
and `e2e-ui/shared/subagents-parallel.spec.ts`
(`scenarioSeedXml("subagents-batch")`). Rename to `scenarios/subagents-parallel`
and update both call sites.

**H.3** Adapter swap-parity divergence. `createNodeScriptExecutor()`
(`test-apps/node-adapters/script-executor.ts`) takes no args while
`createBrowserScriptExecutor(opts: { filesystem })`
(`test-apps/browser/src/host/script-executor/browser-script-executor.ts`)
requires `filesystem`; and both
`test-apps/node-adapters/sessions/{multi,single}-tenant/store.ts` export the
identical symbol `createSqliteSessionStore`, distinguished only by the `index.ts`
re-export aliases. Align the option shapes / rename at source to the documented
public names (`createMultiTenantSqliteSessionStore` etc.), or record the
deliberate divergence in `hosts.md`'s adapter table.

---

## Suggested commit grouping

Each batch is independently gate-checkable. Code fixes land first; the spec
refresh (Batch E) lands last so specs are regenerated against corrected code.

1. **Commit 1 — Batch A** — eliminate runtime skips: just-bash in-memory terminal
   (bash gate), consistent per-request/worker-reload session hydration (settings +
   MCP restore + resume gates); SKIPPED.md documents only the residual stdio
   capability boundary + PARITY.md deferrals.
2. **Commit 2 — Batch B** — browser-family client parity for session-management +
   settings/auth commands with `e2e-ui/shared` coverage; cli REPL mcp/subagent +
   `/session` disambiguation.
3. **Commit 3 — Batch C** — decide in-process-vs-wire for compaction/navigate/
   branch-summary; add the missing wire + in-process event tests.
4. **Commit 4 — Batch D** — source health: dead code, unsafe casts, dup guard,
   magic numbers, `spawn` extraction.
5. **Commit 5 — Batch F** — test architecture: rename, fixture adoption, brittle
   assertions; CLAUDE.md aimock/faux rule clarification.
6. **Commit 6 — Batch G** — comment removals.
7. **Commit 7 — Batch H** — sub-agent specs → haiku, scenario rename, adapter
   naming.
8. **Commit 8 — Batch E** — spec refresh against the now-corrected code: layout
   + path fixes, line-numbers → `file:symbol` across all specs (+ CLAUDE.md rule),
   e2e/CLAUDE.md 4→6 projects.

Highest-impact: **Batch A + B** — bring http/ws and browser/chrome-ext to true
behavioral parity (session hydration + client command surface) so the
runtime-specific skips disappear and `e2e`/`e2e-ui/shared` exercise every feature
on every runtime.
