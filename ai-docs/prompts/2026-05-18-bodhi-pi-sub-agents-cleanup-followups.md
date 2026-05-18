# Kickoff: bodhi-pi sub-agents cleanup — diagnostic warnings + test/Playwright helpers + dead-field drop

**Output**: an exploratory plan written to `ai-docs/plans/YYYY-MM-DD-bodhi-pi-sub-agents-cleanup-followups.md` AFTER you've grilled the user on the open questions below. Read code first, batch decision points via `AskUserQuestion` (each option marked with your recommended answer), get plan approval before any code edits. Same shape as the P2a kickoff workflow.

## Status going in

V1 (`f7d7d421` → `62486bfa`), V2 (`4d07c27b` → `bf4d5937`), and P2a (`bb17df96` → `50c3ca45`) all landed 2026-05-18. The subagent feature is functionally complete for foreground single-child spawn with `context: "fresh" | "fork"`, bundled built-ins, extension-registered profiles, and lifecycle lineage. P2b (parallel batch) is the next big phase; this kickoff is the **small-cleanup pass** that should run BEFORE P2b so the helpers exist when P2b's tests need them.

Four discrete items from the v1+v2+P2a retrospectives, each independently useful, each a single-commit slice:

1. **Diagnostic warnings on dropped profiles** — `loadProjectSubagents` silently drops markdown files that fail validation (parse error, missing description, empty body, unknown `context` value, invalid name). Today's `2026-05-18` debug session lost ~20 minutes to indented YAML frontmatter that returned no warning. Same silent-drop pattern in `loadProjectSkills` and `loadProjectCommands`. Add a single `console.warn`-style hook (or runtime-neutral equivalent) at the drop site so the user has SOMETHING to inspect.
2. **`scriptSubagentRun` test helper** — every spawn-related faux-provider test (`subagents-spawn.test.ts`, `subagents-fork.test.ts`, `subagents-cancellation.test.ts`, `subagents-llm-invocation.test.ts`) hand-scripts `faux.setResponses([...])` with a per-test queue of `(parentToolCall, childResponse, finalText)`. P2b will multiply this — each parallel child needs its own queue. A `scriptSubagentRun({parentToolCalls, childToolCalls, finalText})` helper kills off-by-one bugs and shrinks every spawn test.
3. **`ChatPanelPage.systemMessageWithEvent(event)` Playwright helper** — every subagent Playwright spec (including the new `subagents-fork.spec.ts`) uses `chat.root.locator(...).last()` after `waitForIdle()` to find the relevant system message. The race documented in the v1 retrospective is real. A helper that polls for "system message whose `data-*-event` attribute matches" is one extraction.
4. **`SubagentService.config` unused field drop** — declared in v1 for symmetry with other services, never read. v2 retrospective noted "keep for symmetry, drop in cleanup if YAGNI wins". YAGNI has won. Remove the field + the constructor parameter that fills it. Verify no consumer depends on the shape.

**Read first** (in this order):

1. [`ai-docs/sub-agents/v2-retrospective.md`](../sub-agents/v2-retrospective.md) — items #2-#5 in the "Items for v3 / future" section.
2. [`ai-docs/sub-agents/p2a-retrospective.md`](../sub-agents/p2a-retrospective.md) — confirms #3 + #4 still deferred post-P2a; the diagnostic-warnings finding originated mid-P2a (see "Process notes" + the negative-control debug episode).
3. Source: `packages/bodhi-pi/src/subagents/discovery.ts` (drop site for #1), `packages/bodhi-pi/src/subagents/_validate.ts` (where validation returns `null`), `packages/bodhi-pi/src/skills/discovery.ts` + `packages/bodhi-pi/src/commands/discovery.ts` (sibling silent-drop patterns), `packages/bodhi-pi/src/subagents/subagent-service.ts` (the unused `config` field for #4), `packages/bodhi-pi/test/helpers/` (where #2's helper lands), `packages/bodhi-pi/e2e-ui/pages/ChatPanel.ts` (where #3's helper lands).

## Goal

Land four single-commit cleanups, each individually green, none of which change user-visible behavior:

1. **C1 — Diagnostic warnings on dropped profiles/skills/commands** — `loadProjectSubagents`, `loadProjectSkills`, `loadProjectCommands` warn (via a runtime-neutral logging hook) when a file is found but rejected by validation. The warning carries the file path + a one-line reason (parse error vs missing field vs invalid value).
2. **C2 — `scriptSubagentRun` test helper** — `test/helpers/script-subagent-run.ts` exporting a typed helper that constructs the faux-provider response queue for a parent-spawns-child flow. Refactor at least 2 existing tests to use it as a smoke proof.
3. **C3 — `ChatPanelPage.systemMessageWithEvent` Playwright helper** — `e2e-ui/pages/ChatPanel.ts` gains the helper; refactor at least 2 existing subagent specs to use it.
4. **C4 — Drop `SubagentService.config` unused field** — remove the field from `SubagentServiceDeps`, the constructor capture, and any test-fixture code that passes it. Verify no consumer.

## What still exists (don't reimplement)

- `loadProjectSubagents` / `loadProjectSkills` / `loadProjectCommands` discovery functions. Don't change behavior — only add a warn-on-drop log call at the existing `return null` / `continue` sites.
- `parseFrontmatter` in `src/_internal/frontmatter.ts` — throws on malformed YAML (caught by callers); returns `{frontmatter: {}}` when the leading `---` isn't found. Don't change parser semantics; add observability AT the caller.
- Existing test patterns (faux provider response queues, harness wiring) — `scriptSubagentRun` builds ON these, doesn't replace them.
- `BodhiPiLogger` interface (if it exists; otherwise just `console.warn` is the runtime-neutral default — same default as `ExtensionRunner` uses at `runner.ts:76`).

## Open exploration questions to resolve before designing

Resolve these by reading source first, then `AskUserQuestion` (with your recommended answer per question) before writing the plan. Batched per area:

### Logging surface

- **Where does the warning go?** Options: (a) `console.warn` direct (simplest, matches existing `ExtensionRunner` fallback); (b) thread `BodhiPiLogger` through to the discovery functions (requires plumbing); (c) collect drops into a returned `{profiles, errors[]}` shape so the caller surfaces them via the existing initialize `_meta` rail. **Recommend** (a) — direct `console.warn` matches `ExtensionRunner.logger` fallback and avoids plumbing a logger into pure functions. Hosts that want to capture stderr already do so.
- **Warn verbosity** — every drop logs (today's case = 1 file = 1 warning), or aggregate at session-boot end? **Recommend** every drop logs — they're rare (zero in healthy projects) and the per-file path is the actionable signal.
- **Warning shape** — `[bodhi-pi <area> discovery] dropped <path>: <reason>` for grep-ability. **Recommend** that exact prefix structure so the test for #1 can assert it.

### `scriptSubagentRun` helper shape

- **Input signature** — `{parentToolCalls: Array<{name, args}>, childResponses: AgentMessage[], finalText: string}` vs separate `forParent` and `forChild` faux-provider builders. **Recommend** a single builder that returns `(faux: FauxProviderRegistration) => void` so the test stays in control of when `setResponses` is called. The helper composes the queue; the test owns the lifecycle.
- **Coverage** — refactor 2 tests or all of them? **Recommend** refactor `subagents-fork.test.ts` + `subagents-cancellation.test.ts` as proof-of-fit; leave the rest for incremental adoption.

### `ChatPanelPage.systemMessageWithEvent` helper shape

- **Lookup contract** — query by event name string, return the matched Playwright locator; or query by event name + status (e.g. `"subagent-event:list"`), return the locator. **Recommend** `systemMessageWithEvent(eventName: string)` returning the locator; the test asserts further attributes on top.
- **Race-handling** — polling for the attribute presence with the standard Playwright `expect(locator).toBeVisible({timeout})` semantics, or manual loop? **Recommend** Playwright's built-in retry — let the framework own the wait.

### `SubagentService.config` drop

- **Field is declared but unused** per the v2 retrospective. Confirm by grep before changing. **Recommend** remove unconditionally; revert if a hidden consumer surfaces.
- **Constructor param shape** — `SubagentServiceDeps` has a `config: BodhiPiConfig` field. Remove from the interface + from the harness fixture that constructs it.

## Locked scope decisions (user-confirmed)

> Empty — fill in via the AskUserQuestion batch. Recommended defaults are the **Recommend** markers above.

## Process — iterative TDD across the matrix

Per `feedback_e2e_coverage_keeps_feature` and `packages/bodhi-pi/CLAUDE.md` 6-step workflow. Each cleanup is independently shippable.

Recommended cadence:

1. **C1 first** — write `test/discovery-warnings.test.ts` (asserts `console.warn` called with the expected prefix when a malformed profile/skill/command is in the workspace). Stub `console.warn` per-test. Implement. Same shape across the three loaders.
2. **C2 next** — write `scriptSubagentRun` helper; refactor `subagents-cancellation.test.ts` first (smallest); refactor `subagents-fork.test.ts` second; confirm no behavior change.
3. **C3 next** — add the helper to `ChatPanelPage`; refactor `subagents.spec.ts` + `subagents-builtin.spec.ts` (or `subagents-fork.spec.ts`); run Playwright if API keys available.
4. **C4 last** — remove the field; run full suite to confirm no consumer broke.

Each commit ends green on `npm run check` + relevant test slices.

## Gate-check + commit cadence

Suggested commit shape:

- C1: `bodhi-pi sub-agents cleanup: warn on dropped profile/skill/command files`
- C2: `bodhi-pi sub-agents cleanup: scriptSubagentRun test helper + 2 refactored tests`
- C3: `bodhi-pi e2e-ui cleanup: ChatPanelPage.systemMessageWithEvent helper + 2 refactored specs`
- C4: `bodhi-pi sub-agents cleanup: drop unused SubagentService.config field`

Use the **single chained-commit pattern** per `feedback_atomic_commit_with_reset`:
`git reset > /dev/null 2>&1 && git add <explicit-paths> && git commit -m "..."`
to avoid mixing with concurrent `bodhi-pi-coding-agent` WIP.

## Plan structure (mandatory sections)

When you write the plan after grilling the user, include:

1. **Goal restatement** — the four cleanup items quoted.
2. **Locked-scope summary** — table: cleanup → user-locked answer → file:line where it lands.
3. **Open-question resolutions** — table: question → recommended answer → user-answer (filled during planning).
4. **File-level inventory** — new files, touched files. Per file: one-line purpose.
5. **Per-commit slice** — 4 commits, each with TDD steps + validation gate.
6. **Verification matrix** — per cleanup: which `npx vitest run <files>` / `npm run check` / Playwright command to run.
7. **Risk register** — most likely regressions: (a) C1's warn calls in hot loops if discovery happens often; (b) C2 helper shape forces a refactor of more tests than planned; (c) C4 drops a field someone uses via duck-typing (unlikely but grep-check).
8. **Out of scope** — explicitly: `subagents-doctor` slash (separate, larger feature); parallel batch (P2b); skill inheritance (P3d); profile-orphan-lint logic.

## Anti-patterns to avoid

- Don't add source comments — WHY goes in commit messages per `feedback_no_low_value_comments`.
- Don't plumb a `BodhiPiLogger` into pure discovery functions unless option (b) wins in grilling. Direct `console.warn` is the runtime-neutral default.
- Don't refactor more tests than the smoke proof needs in C2/C3. Incremental adoption is fine.
- Don't combine the four cleanups into one commit — they're bisectable for a reason.
- Don't use the multi-step `git add` then `git commit` pattern — per memory `feedback_atomic_commit_with_reset`, chain `git reset && git add && git commit` as a single Bash call.
- Don't expand scope to include `subagents-doctor` — that's its own multi-commit feature.

## References

- V1 commits: `f7d7d421` (C1), `532ee5fc` (C2), `c8e06bf1` (C3), `62486bfa` (retrospective+roadmap).
- V2 commits: `4d07c27b` (plan), `9b67f7b4` (C0), `e2a3e93d` (C1), `cea50e87` (C2), `ea70a10e` (e2e refresh), `121ba066` (C3a), `d2a2fc51` (C3b), `d963a049` (C3c), `2756e5eb` (C4), `bf4d5937` (C5).
- P2a commits: `bb17df96` (plan), `87ab9b2e` (C1), `7d5bfd18` (C2), `764cb275` (C3), `0200ffda` (C4), `50c3ca45` (C5).
- Retrospectives: `ai-docs/sub-agents/v2-retrospective.md`, `ai-docs/sub-agents/p2a-retrospective.md`.
- Memory: `feedback_no_low_value_comments`, `feedback_atomic_commit_with_reset`, `feedback_bodhi_pi_e2e_strategy`.

## When done

Print: the plan path, the count of open questions resolved during the session, and the proposed commit subjects in order. Do not start executing the plan in this round — the plan IS the deliverable. Implementation runs in a separate session, ideally guided by `superpowers:executing-plans` or `superpowers:subagent-driven-development`.
