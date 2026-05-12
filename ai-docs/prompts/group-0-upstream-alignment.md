# Phase 0 — Upstream alignment audit (post-0.74 sync)

**Read first:** `ai-docs/prompts/process.md` (working rules + retrospective).
**Source intent:** `ai-docs/research/upstream-sync-2026-05-11.md` — full
diff of `pi-ai` 0.73→0.74 and the new `pi-agent-core/harness/*` subtree.
**Reference impl (this phase only):** `packages/agent/src/harness/` —
the headline addition of the upstream window. Functionally overlaps
several bodhi-pi subsystems; the audit decides what to adopt.
**Current state:** `packages/bodhi-pi/PARITY.md`, plus the modules
under `packages/bodhi-pi/src/{sessions,skills,commands,acp}/`.

> **Why this phase exists.** Between commits `50993d74` (old base, 2026-05-07)
> and `f348a062` (new base, 2026-05-10) upstream landed an `AgentHarness`
> abstraction that re-implements primitives bodhi-pi has been building in
> parallel since Phase A: `session/*`, `compaction/*`, `skills`,
> `prompt-templates`, `system-prompt`, `messages`. The rebase was kept
> minimal — only the package rename + one subpath import + one test
> narrowing. **Before starting the next feature group**, decide which (if
> any) harness primitives bodhi-pi should adopt; running parallel
> implementations indefinitely is the worst of both worlds. This phase
> ships decisions, not a refactor.

---

## Functional outcomes

After this phase:

1. **Adopt-or-skip decision is recorded for each harness subsystem.** A
   short table in `PARITY.md` (or an appendix to the upstream-sync research
   doc) maps each `harness/*` module to one of: *adopt now*, *adopt later
   when the upstream churn settles*, *keep bodhi-pi's parallel impl
   permanently*. Reasons given for each.
2. **`AgentLoopConfig.prepareNextTurn` is adopted** for the post-compaction
   model/context swap path. Today bodhi-pi's `compaction.ts` mutates
   `AgentContext` after a compaction summary lands and re-runs `agent.loop()`;
   the new callback lets a single `agent.loop()` call swap context between
   turns within the same run, removing one external loop level.
3. **Fireworks compat flags are documented** in
   `BodhiPiConfig.models` example/README content:
   `compat.sendSessionAffinityHeaders: true` +
   `compat.supportsCacheControlOnTools: false`. No code change — pure
   docs — until a user actually configures Fireworks.
4. **`AgentMessage` widening is reflected in bodhi-pi's contract.** Either:
   - bodhi-pi's `CustomAgentMessages` augmentation is updated to opt out of
     the harness roles (declare them as `never` to keep `AgentMessage` =
     `Message` in bodhi-pi's TypeScript view), OR
   - bodhi-pi formally accepts the wider union and adds narrowing helpers
     (`isLlmMessage(m)`, etc.) plus a CLAUDE.md note.
   - The current state: one test (`build-context.test.ts`) already had to
     narrow with `"content" in m`; we patched it. The audit decides whether
     this narrowing pattern becomes the bodhi-pi convention or a one-off.
5. **The upstream module-augmentation bug is filed upstream** (or
   intentionally deferred). Today the harness augments `CustomAgentMessages`
   via the relative path `"../types.js"` while consumers (e.g.,
   `web-ui/example/custom-messages.ts`) augment via the package name
   `"@earendil-works/pi-agent-core"` — TypeScript treats these as different
   modules so the augmentations don't merge. We worked around it with one
   `as unknown as AgentMessage` cast. Decide: open an upstream issue, or
   keep the cast and revisit on next sync.

Each outcome is a recorded decision (PARITY.md table row, code change, or
research-doc appendix). No new user-visible feature ships in this phase —
the user-visible payoff is "future syncs are cheaper" and "post-compaction
model swap is simpler".

---

## Rough directional pointers

### Harness audit map

For each row, read both files, list overlapping APIs, decide adopt
status. Don't refactor in this phase — the goal is decisions.

| Harness module | bodhi-pi parallel | Notes |
|---|---|---|
| `harness/session/session.ts` + `harness/session/repo/{jsonl,memory,shared}.ts` + `harness/session/storage/{jsonl,memory}.ts` | `bodhi-pi/src/sessions/session-store.ts` (interface) + `bodhi-pi-node/src/sessions/sqlite-session-store.ts` (Node SQLite impl) + `bodhi-pi/src/sessions/in-memory-session-store.ts` (in-mem) + `bodhi-pi-browser`'s Dexie impl | bodhi-pi's `SessionEntry` is a discriminated union with branching/leaf semantics (DAG); harness `SessionTreeEntry` shares the shape but has a more general entry vocabulary. Risk: harness storage layout churned 7× during the bigrefactor branch. Adopting now means tracking churn. |
| `harness/compaction/compaction.ts` (`compact`, `prepareCompaction`, `shouldCompact`, `findCutPoint`, `serializeConversation`, `estimateContextTokens`, `DEFAULT_COMPACTION_SETTINGS`, `getLastAssistantUsage`) | `bodhi-pi/src/sessions/compaction.ts` (`runCompaction`, `prepareCompaction`, `calculateContextTokens`, `getLastAssistantUsage`) | Heavy overlap. Adopting could remove ~300 lines of bodhi-pi code, but `runCompaction` calls `agent.loop()` for the summarization step — adoption needs to keep that orchestration in bodhi-pi or migrate to `AgentHarness` wholesale. |
| `harness/compaction/branch-summarization.ts` (`generateBranchSummary`, `prepareBranchEntries`, `collectEntriesForBranchSummary`) | `bodhi-pi/src/sessions/branch-summary.ts` (`runBranchSummary`, `detectCrossBranch`) | Same pattern — adopt the pure helpers, keep our orchestration. |
| `harness/messages.ts` (`convertToLlm`, `bashExecutionToText`, plus the `BashExecutionMessage`/`CustomMessage`/`BranchSummaryMessage`/`CompactionSummaryMessage` types AND the `CustomAgentMessages` module augmentation) | bodhi-pi's `convertToLlm`-equivalent inlined in `acp/agent.ts` and `sessions/build-context.ts` | The augmentation is the load-bearing piece — see Functional outcome #4. |
| `harness/prompt-templates.ts` | `bodhi-pi/src/commands/prompt-templates.ts` + `bodhi-pi/src/commands/discovery.ts` | Compare argument hint syntax; harness may have adopted a different convention. |
| `harness/skills.ts` | `bodhi-pi/src/skills/` (multiple files: `discovery.ts`, `invocation.ts`, `system-prompt.ts`, `skill.ts`) | Skill `allowed-tools` enforcement (a Phase G outcome) — check if harness already does this. |
| `harness/system-prompt.ts` | bodhi-pi's `composeSystemPrompt` in `src/skills/system-prompt.ts`, called from `acp/agent.ts:_buildSessionState` | **Group 2 (Phase G) overlaps with this.** If we adopt harness here, Phase G's "default system prompt + tool descriptions" outcome is partly satisfied upstream. |
| `harness/execution-env.ts` + `harness/env/nodejs.ts` (`NodeExecutionEnv`) | bodhi-pi-node's `Filesystem` + `ScriptExecutor` adapters | bodhi-pi splits FS / shell / sessions into three injected interfaces; harness merges them into one `ExecutionEnv`. Wholesale adoption would change the `BodhiPiConfig` shape. |
| `harness/utils/shell-output.ts` (`executeShellWithCapture`, `sanitizeBinaryOutput`) | None — bodhi-pi has no shell tool yet | **Group 3 (Phase H) is "tooling excluding bash".** When the bash tool lands in a later phase, this is the reference. Out of scope today. |
| `harness/utils/truncate.ts` | `bodhi-pi/src/tools/_accumulate.ts` (`accumulateBounded`, `truncationFooter`) | Compare semantics — both bound output by bytes/lines. |

### `prepareNextTurn` adoption

Today `bodhi-pi/src/acp/agent.ts:prompt()` runs `agent.loop()` and on
context-overflow caught by the surrounding try/catch, runs
`runCompaction`, then re-runs `agent.loop()`. That's the
`overflowRecoveryAttempted` flag pattern.

`AgentLoopConfig.prepareNextTurn?: (ctx: PrepareNextTurnContext) =>
AgentLoopTurnUpdate | undefined | Promise<…>` fires after each `turn_end`
and before the next provider request inside the **same** `loop()` call.
Returning `{context, model, thinkingLevel}` swaps state for the next turn.

Concrete migration target: the post-compaction case where the compaction
summary becomes the new context. With `prepareNextTurn`, compaction can
land mid-loop without bodhi-pi orchestrating the second `loop()` call.

Read `packages/agent/src/agent-loop.ts` (search for `prepareNextTurn`)
to confirm the timing — specifically, whether the callback fires *before*
or *after* the host has appended the user's next message. If after, this
is a clean drop-in. If before, the wiring needs more thought.

### Fireworks compat (docs only)

Add to `packages/bodhi-pi/README.md` (or wherever model registration is
documented) a snippet showing the two flags for users who route bodhi-pi
through a Fireworks endpoint:

```ts
{
  id: "...",
  api: "anthropic-messages",
  baseUrl: "https://api.fireworks.ai/...",
  compat: {
    sendSessionAffinityHeaders: true,
    supportsCacheControlOnTools: false,
  },
}
```

No tests, no code — pure documentation. Skip if no user has asked.

### Module-augmentation upstream issue

See `packages/web-ui/example/src/custom-messages.ts` line 21: it augments
`"@earendil-works/pi-agent-core"`. The harness in
`packages/agent/src/harness/messages.ts` line 56 augments `"../types.js"`.
TypeScript merges declarations only when both target the same canonical
module — different specifiers means no merge. Result: third-party
augmentations of `CustomAgentMessages` are silently dropped.

Either file an issue upstream (preferred — Mario fixed similar things
quickly during the rebase window) or document the workaround in
bodhi-pi's CLAUDE.md ("if you augment `CustomAgentMessages`, you may need
a cast at the call site").

---

## Test signals to design for

This phase is mostly research + decisions. The only code-change-bearing
outcomes are #2 (`prepareNextTurn`) and possibly #4 (augmentation choice).

For `prepareNextTurn`:

- **Faux-provider integration test** (`bodhi-pi/test/`): rig a faux
  provider that returns a context-overflow error on turn 1 and a normal
  response on turn 2; with `prepareNextTurn` wired, assert the second
  turn's context contains the compaction summary message — without
  bodhi-pi having to call `agent.loop()` twice. (The existing
  `overflow-recovery.test.ts` already covers the user-visible behaviour;
  this new test asserts the wiring shape, so it can be a simple in-package
  test, not full ACP integration.)
- **Existing `overflow-recovery.test.ts` must still pass** — proves the
  user-visible behaviour is unchanged.
- **Per-host e2e:** unchanged. Compaction recovery is already covered by
  the existing overflow-recovery e2e in each host; the swap to
  `prepareNextTurn` is internal.

For `AgentMessage` widening (#4): if we choose to opt out via
`CustomAgentMessages` augmentation, add a tsgo check that asserts
`AgentMessage` resolves to `Message` only in bodhi-pi's types — a
type-only test using `expectTypeOf` from vitest works, or a `// @ts-expect-error`
comment in a sentinel file.

No real-LLM e2e is added in this phase.

---

## Open questions to confirm before coding

Use `AskUserQuestion` once the audit is done. Likely topics:

- **Adopt harness session/compaction primitives now or wait?** Risk: 7
  upstream refactors of session/repo layout in 3 days — pinning today
  means another rebase headache next week. Recommendation: wait; reuse
  harness only as a reference until upstream stabilises.
- **Adopt `prepareNextTurn` now?** Recommendation: yes — small, drop-in,
  removes one layer of orchestration. Confirm with a code-walk.
- **Should bodhi-pi opt out of `CustomAgentMessages` augmentation?**
  Bodhi-pi today uses `Message` only (no `bashExecution`, no
  `branchSummary`, no `compactionSummary`). The widened union is "wrong"
  for bodhi-pi's contract — every consumer has to narrow. Opting out
  (declaring those keys as `never` in bodhi-pi's own augmentation) would
  restore the narrow type. **But** that requires understanding TS module
  augmentation interaction with re-exports — non-trivial.
- **File the upstream module-augmentation bug?** Recommendation: yes,
  small reproducer + suggested fix (use the package-name specifier
  inside the package's own augmentations).
- **Is the Group 2 (Phase G) "default system prompt" outcome still in
  scope, or is it now satisfied by adopting `harness/system-prompt.ts`?**
  Probably still in scope — the harness composes a generic prompt; bodhi-pi
  needs a coding-agent-flavoured one with its specific tool descriptions.
  But re-read the harness output before deciding.

---

## Boundaries

In scope:

- Audit each `harness/*` module against bodhi-pi's parallel impl; record
  adopt/skip decisions.
- Adopt `AgentLoopConfig.prepareNextTurn` for post-compaction recovery.
- Document Fireworks compat flags in README.
- Decide and implement the `AgentMessage` widening response (opt out
  via augmentation OR formalise narrowing as bodhi-pi convention).
- File or defer the upstream module-augmentation bug.

Explicitly out of scope (defer):

- Full migration of bodhi-pi's `sessions/`, `skills/`, `commands/` to
  harness primitives. That's a separate large phase that follows this
  audit's recommendations — and only if the audit recommends it.
- Adopting the new pi-ai images API (output generation). Group 7 covers
  image *input*; the new APIs are for image *output* generation, which
  isn't a coding-agent feature.
- Adopting the Together provider — pure consumer-side opt-in, no bodhi-pi
  code change required.
- Restoring the lost `tsconfig.base.json` `paths` map. File-resolution
  through `node_modules` symlinks works fine; `paths` only mattered for
  the old monorepo source-mode layout.

---

## What "done" looks like

- A new appendix in `ai-docs/research/upstream-sync-2026-05-11.md`
  titled "Adoption decisions" with the harness module table filled in
  and one-line rationale per row.
- `packages/bodhi-pi/src/acp/agent.ts` (or `sessions/compaction.ts`) wired
  through `prepareNextTurn` for the overflow-recovery path; existing
  `overflow-recovery.test.ts` still green; new wiring-shape test added.
- `packages/bodhi-pi/README.md` (or appropriate doc) carries a Fireworks
  compat snippet.
- A single decision recorded for the `AgentMessage` widening (with
  whichever code change that decision implies).
- Upstream issue link captured in the research doc, OR a paragraph
  explaining why we deferred filing it.
- `just test` is green.
- Conventional commit: `chore(bodhi-pi): upstream alignment audit (Phase 0)`
  or `feat(bodhi-pi): adopt prepareNextTurn + audit harness (Phase 0)`,
  with the body summarising audit decisions + pointing at the research doc
  appendix.
