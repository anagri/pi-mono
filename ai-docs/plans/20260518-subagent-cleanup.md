# Plan — bodhi-pi sub-agents cleanup followups

> Suggested final filename per kickoff convention: `2026-05-18-bodhi-pi-sub-agents-cleanup-followups.md`. Plan-mode allowed only this auto-generated path; rename on first commit if desired.

## Context

V1, V2, and P2a of the subagent feature all landed 2026-05-18. P2b (parallel batch) is next. Before P2b, four small-cleanup items from the V1/V2/P2a retrospectives need to land so P2b inherits cleaner test scaffolding and observable discovery:

1. Discovery silently drops malformed profile/skill/command files. A 2026-05-18 debug session lost ~20 minutes to indented YAML frontmatter with zero feedback. Three loaders share the silent-drop pattern.
2. The four spawn-related tests each hand-script `faux.setResponses([...])`. P2b multiplies this; off-by-one queue bugs are inevitable without a helper.
3. The Playwright specs use `chat.root.locator(...).last()` to find subagent system messages — race documented in v1 retrospective; the fork spec already chains `[data-subagent-event][data-subagent-name]` manually.
4. `SubagentService.config` was added in V1 for symmetry; v2 retrospective deferred. P2a confirmed no consumer. YAGNI wins.

All four are independently shippable, bisectable, no user-visible behavior change.

## Goal — quoted from kickoff

1. **C1 — Diagnostic warnings on dropped profiles/skills/commands** — `loadProjectSubagents`, `loadProjectSkills`, `loadProjectCommands` warn (via a runtime-neutral logging hook) when a file is found but rejected by validation. The warning carries the file path + a one-line reason (parse error vs missing field vs invalid value).
2. **C2 — `scriptSubagentRun` test helper** — `test/helpers/script-subagent-run.ts` exporting a typed helper that constructs the faux-provider response queue for a parent-spawns-child flow. Refactor at least 2 existing tests to use it.
3. **C3 — `ChatPanelPage.systemMessageWithEvent` Playwright helper** — `e2e-ui/pages/ChatPanel.ts` gains the helper; refactor at least 2 existing subagent specs to use it.
4. **C4 — Drop `SubagentService.config` unused field** — remove the field from `SubagentServiceDeps`, the constructor capture, and any test-fixture code that passes it. Verify no consumer.

## Open-question resolutions (user-confirmed 2026-05-18)

| Question | Recommended default | User answer |
| --- | --- | --- |
| C1 — where does the warning go? | `console.warn` direct | **Extend `BodhiPiLogger` with `warn()`** — thread an optional logger param into the three discovery functions; fall back to `console.warn` when absent. |
| C1 — verbosity | Every drop logs | Every drop logs (kickoff default — no override needed). |
| C1 — warning shape | `[bodhi-pi <area> discovery] dropped <path>: <reason>` | Same prefix structure; tests assert it. |
| C2 — coverage scope | cancellation + fork | **cancellation + fork** (confirmed). |
| C2 — helper signature | Single builder returning `(faux) => void` | Single builder; takes `faux` directly to keep tests in control of lifecycle (see §C2 design). |
| C3 — helper signature | `systemMessageWithEvent(eventName)` only | **`systemMessageWithEvent(eventName, {name?})`** — fork spec narrows by `data-subagent-name`, so a typed second-arg is worth it. |
| C3 — race handling | Playwright built-in retry | Confirmed — return Locator; caller calls `expect(...).toBeVisible({timeout})`. |
| C4 — scope of drop | Full drop | **Full drop** of interface field + private field + assignment + any fixture passing `config`. |

## Locked-scope summary

| Cleanup | Locked answer | File:line that anchors it |
| --- | --- | --- |
| C1 (logger surface) | Extend `BodhiPiLogger` with `warn()`; thread optional logger param into 3 discovery functions; fall back to `console.warn` when unset. Same `warn()` added to `RunnerLogger` for shape parity. | `src/acp/agent.ts:133-135` (interface); `src/extensions/runner.ts:54-56` (sibling); `src/sessions/session-bootstrap.ts:74-78` (thread point). |
| C1 (drop sites — subagents) | Warn at validator-null return + I/O catch + parse-throw catch. | `src/subagents/discovery.ts:14-16, 18-24, 44-51` and `src/subagents/_validate.ts:30, 31, 33, 35, 46`. |
| C1 (drop sites — skills) | Same. | `src/skills/discovery.ts:26-29, 31-32, 33, 35, 49, 52-55, 60, 63, 65-68, 71`. |
| C1 (drop sites — commands) | Same (note: commands only drop on YAML parse error). | `src/commands/discovery.ts:19-22, 53-56, 64-67, 70`. |
| C1 (warning format) | `[bodhi-pi <area> discovery] dropped <path>: <reason>` where `<area>` ∈ `{subagent, skill, command}`. Tested literally. | New test files (see §file inventory). |
| C2 (helper API) | `scriptSubagentRun(faux, {parentToolCalls, childResponses, finalText, asyncDelay?}): void`. Internally calls `faux.setResponses([...])`. Refactors `subagents-cancellation.test.ts` + `subagents-fork.test.ts`. | New helper: `test/helpers/script-subagent-run.ts`. |
| C3 (helper API) | `systemMessageWithEvent(eventName: string, options?: { name?: string }): Locator` on `ChatPanelPage`. Refactors `subagents.spec.ts` + `subagents-fork.spec.ts`. | `e2e-ui/pages/ChatPanel.ts`. |
| C4 (drop scope) | Remove `config: BodhiPiConfig` from `SubagentServiceDeps` (interface); remove `private readonly config` field and assignment from `SubagentService`; sweep any harness/fixture passing `config`. | `src/subagents/subagent-service.ts:33, 73, 85`; check `test/helpers/harness.ts` for callers. |

## File-level inventory

### C1 — new files
- `packages/bodhi-pi/test/subagents-discovery-warnings.test.ts` — new. Asserts `loadProjectSubagents` calls `logger.warn` with the expected prefix for each rejection mode (malformed YAML, missing description, invalid name, empty body, invalid context, parse-throw, I/O error). Uses spy logger fixture (`vi.fn()` matching `BodhiPiLogger` shape).
- `packages/bodhi-pi/src/skills/discovery-warnings.test.ts` — sibling of `discovery.test.ts`. Same shape for skills.
- `packages/bodhi-pi/src/commands/discovery-warnings.test.ts` — sibling of `discovery.test.ts`. Same shape for commands.

### C1 — touched files
- `packages/bodhi-pi/src/acp/agent.ts` — add `warn(message, ...args): void` to `BodhiPiLogger`.
- `packages/bodhi-pi/src/extensions/runner.ts` — add `warn(message, ...args): void` to `RunnerLogger`.
- `packages/bodhi-pi/src/subagents/discovery.ts` — add `logger?: BodhiPiLogger` param to `loadProjectSubagents` + internal `loadProfile`. Warn at every drop site with the prefixed format.
- `packages/bodhi-pi/src/subagents/_validate.ts` — change `validateAndNormalizeProfile` to return `{profile: SubagentProfile} | {reason: string}` so the caller has a one-line reason for the warning. Caller wraps the reason into the warn message; tests already in `subagents-discovery.test.ts` keep asserting the null-equivalent behavior via the higher-level discovery output.
- `packages/bodhi-pi/src/skills/discovery.ts` — same threading pattern; same `{skill | reason}` shape for the skill-validate helper.
- `packages/bodhi-pi/src/commands/discovery.ts` — only the YAML-parse catch needs a warning (commands don't have rich validation). Same threading.
- `packages/bodhi-pi/src/sessions/session-bootstrap.ts` — at lines 76-78, extract `config.logger` and pass through to all three loaders.

### C2 — new files
- `packages/bodhi-pi/test/helpers/script-subagent-run.ts` — exports `scriptSubagentRun(faux, opts)`. Composes `faux.setResponses([...])` from typed inputs.

### C2 — touched files
- `packages/bodhi-pi/test/subagents-cancellation.test.ts` — replace inline `faux.setResponses([...])` (lines 44-53) with `scriptSubagentRun(faux, {...})`.
- `packages/bodhi-pi/test/subagents-fork.test.ts` — replace the four `faux.setResponses([...])` invocations (lines 47-55, 101, 125, 155) with `scriptSubagentRun(faux, {...})`. Keep the context-capture factory expressed via `childResponses` accepting `(AssistantMessage | FauxResponseFactory)[]`.

### C3 — touched files
- `packages/bodhi-pi/e2e-ui/pages/ChatPanel.ts` — add `systemMessageWithEvent(eventName, options?)` method. Returns `this.root.locator(...)` filtered by `[data-message-role="system"][data-{subagent|tool|...}-event="${eventName}"]` + optional `[data-subagent-name="${options.name}"]`. (Use `data-subagent-event` as the only attribute family today; widen if a new event family appears.)
- `packages/bodhi-pi/e2e-ui/specs/subagents.spec.ts` — replace direct `chat.root.locator('[data-subagent-event="list"]')` + `'[data-subagent-event="run-result"]'` with the helper.
- `packages/bodhi-pi/e2e-ui/specs/subagents-fork.spec.ts` — replace `chat.root.locator('[data-subagent-event="run-result"][data-subagent-name="reviewer"]').last()` with `chat.systemMessageWithEvent("run-result", { name: "reviewer" })`.

### C4 — touched files
- `packages/bodhi-pi/src/subagents/subagent-service.ts` — remove `config: BodhiPiConfig` from `SubagentServiceDeps`, remove `private readonly config: BodhiPiConfig` and the `this.config = deps.config` constructor line.
- `packages/bodhi-pi/src/acp/agent.ts` — drop the `config: this.config` arg from the `new SubagentService({...})` call site (`agent.ts:290` per exploration). Grep for any other instantiation.
- `packages/bodhi-pi/test/helpers/harness.ts` — drop any `config` key passed to a `SubagentService` constructor in fixture wiring.

## Per-commit slice

### C1 — `bodhi-pi sub-agents cleanup: warn on dropped profile/skill/command files`

TDD steps:
1. **Red** — add `BodhiPiLogger.warn` to interface in `src/acp/agent.ts`; add `RunnerLogger.warn` in `src/extensions/runner.ts`. Compile fails for any place asserting the interface shape (probably none — both are duck-typed `console`).
2. **Red** — write `test/subagents-discovery-warnings.test.ts` with cases:
   - malformed YAML → `[bodhi-pi subagent discovery] dropped /proj/.bodhi-pi/agents/bad.md: parse error: <yaml err>`
   - missing description → `... dropped <path>: missing description`
   - description > 1024 → `... dropped <path>: description exceeds 1024 chars`
   - invalid name → `... dropped <path>: invalid name "Bad Name"`
   - empty body → `... dropped <path>: empty body`
   - invalid context → `... dropped <path>: invalid context "weird"`
   - I/O read error → `... dropped <path>: read error: <msg>`
   - I/O list error → `... dir scan failed for /proj/.bodhi-pi/agents: <msg>`
   Each case wires a `vi.fn()` logger via `loadProjectSubagents(fs, "/proj", { logger })`.
3. **Green** — change `validateAndNormalizeProfile` return to `{ profile } | { reason }`; thread `logger?` through `loadProfile` + `loadProjectSubagents`; call `logger?.warn(...)` at each drop site with the spec'd prefix. Default missing logger to `console.warn`.
4. **Refactor** — same shape for skills (`src/skills/discovery-warnings.test.ts` + `src/skills/discovery.ts` + skill validator). For commands, only the YAML-parse catch warns (commands don't validate description/name post-V2 simplification — confirm before writing).
5. **Thread** — `src/sessions/session-bootstrap.ts:74-78`, extract `config.logger` and pass to all three loaders.
6. **Gate** — `npx vitest run packages/bodhi-pi/test/subagents-discovery-warnings.test.ts packages/bodhi-pi/src/skills/discovery-warnings.test.ts packages/bodhi-pi/src/commands/discovery-warnings.test.ts packages/bodhi-pi/test/subagents-discovery.test.ts packages/bodhi-pi/src/skills/discovery.test.ts packages/bodhi-pi/src/commands/discovery.test.ts` then `npm run check`.

Commit:
```
git reset > /dev/null 2>&1 && \
  git add packages/bodhi-pi/src/acp/agent.ts \
           packages/bodhi-pi/src/extensions/runner.ts \
           packages/bodhi-pi/src/subagents/discovery.ts \
           packages/bodhi-pi/src/subagents/_validate.ts \
           packages/bodhi-pi/src/skills/discovery.ts \
           packages/bodhi-pi/src/skills/_validate.ts \
           packages/bodhi-pi/src/commands/discovery.ts \
           packages/bodhi-pi/src/sessions/session-bootstrap.ts \
           packages/bodhi-pi/test/subagents-discovery-warnings.test.ts \
           packages/bodhi-pi/src/skills/discovery-warnings.test.ts \
           packages/bodhi-pi/src/commands/discovery-warnings.test.ts && \
  git commit -m "bodhi-pi sub-agents cleanup: warn on dropped profile/skill/command files"
```
(Adjust path list once skill validator helper location is confirmed during execution.)

### C2 — `bodhi-pi sub-agents cleanup: scriptSubagentRun test helper + 2 refactored tests`

TDD steps:
1. **Red** — write `test/helpers/script-subagent-run.ts` with the signature below. Smoke-test in a one-off test if needed; otherwise rely on existing test green.
   ```ts
   export type SubagentRunScript = {
     parentToolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
     childResponses?: (AssistantMessage | FauxResponseFactory)[];
     finalText: string;
   };
   export function scriptSubagentRun(
     faux: FauxProviderRegistration,
     script: SubagentRunScript,
   ): void;
   ```
   The helper composes: `[fauxAssistantMessage(parentToolCalls?, {stopReason:"toolUse"}), ...childResponses, fauxAssistantMessage(finalText)]`. If `parentToolCalls` is undefined, skip that turn; if `childResponses` is empty, skip those turns.
2. **Green** — refactor `test/subagents-cancellation.test.ts` first (1 setResponses call, async factory case). Verify the test still asserts cancellation timing.
3. **Green** — refactor `test/subagents-fork.test.ts` (4 setResponses calls; context-capture factories pass through as `childResponses` entries). Verify all assertions still hold.
4. **Gate** — `npx vitest run packages/bodhi-pi/test/subagents-cancellation.test.ts packages/bodhi-pi/test/subagents-fork.test.ts` then `npm run check`.

Commit:
```
git reset > /dev/null 2>&1 && \
  git add packages/bodhi-pi/test/helpers/script-subagent-run.ts \
           packages/bodhi-pi/test/subagents-cancellation.test.ts \
           packages/bodhi-pi/test/subagents-fork.test.ts && \
  git commit -m "bodhi-pi sub-agents cleanup: scriptSubagentRun test helper + 2 refactored tests"
```

### C3 — `bodhi-pi e2e-ui cleanup: ChatPanelPage.systemMessageWithEvent helper + 2 refactored specs`

TDD steps:
1. **Green-first** (specs already pass) — add `systemMessageWithEvent` to `ChatPanelPage`:
   ```ts
   systemMessageWithEvent(eventName: string, options?: { name?: string }): Locator {
     let selector = `[data-testid="chat-message"][data-message-role="system"][data-subagent-event="${eventName}"]`;
     if (options?.name) selector += `[data-subagent-name="${options.name}"]`;
     return this.root.locator(selector);
   }
   ```
2. **Refactor** `e2e-ui/specs/subagents.spec.ts` — replace the two `chat.root.locator('[data-subagent-event="..."]')` lines with helper calls.
3. **Refactor** `e2e-ui/specs/subagents-fork.spec.ts` — replace the `chat.root.locator('[data-subagent-event="run-result"][data-subagent-name="reviewer"]').last()` with `chat.systemMessageWithEvent("run-result", { name: "reviewer" }).last()`. (Keep `.last()` if needed — helper returns locator, caller chains as before.)
4. **Gate** — `npm run check` covers TS for specs. Playwright run only if API keys are present locally: `npx playwright test packages/bodhi-pi/e2e-ui/specs/subagents.spec.ts packages/bodhi-pi/e2e-ui/specs/subagents-fork.spec.ts`. If keys absent, note "Playwright not exercised locally" in the commit body.

Commit:
```
git reset > /dev/null 2>&1 && \
  git add packages/bodhi-pi/e2e-ui/pages/ChatPanel.ts \
           packages/bodhi-pi/e2e-ui/specs/subagents.spec.ts \
           packages/bodhi-pi/e2e-ui/specs/subagents-fork.spec.ts && \
  git commit -m "bodhi-pi e2e-ui cleanup: ChatPanelPage.systemMessageWithEvent helper + 2 refactored specs"
```

### C4 — `bodhi-pi sub-agents cleanup: drop unused SubagentService.config field`

TDD steps:
1. **Verify** — grep `SubagentService` constructor callers + any `.config` access on the service instance. Already mapped (no readers), but re-verify before deleting in case anything landed since.
2. **Green** — remove `config: BodhiPiConfig` from `SubagentServiceDeps` interface; remove the private field + constructor assignment.
3. **Sweep** — find `new SubagentService({...})` callers, drop the `config:` key. Same for any test harness fixture.
4. **Gate** — `npx vitest run packages/bodhi-pi/` (full subagent test sweep) then `npm run check`.

Commit:
```
git reset > /dev/null 2>&1 && \
  git add packages/bodhi-pi/src/subagents/subagent-service.ts \
           packages/bodhi-pi/src/acp/agent.ts \
           packages/bodhi-pi/test/helpers/harness.ts && \
  git commit -m "bodhi-pi sub-agents cleanup: drop unused SubagentService.config field"
```

## Verification matrix

| Cleanup | Test commands | Notes |
| --- | --- | --- |
| C1 | `npx vitest run packages/bodhi-pi/test/subagents-discovery-warnings.test.ts packages/bodhi-pi/src/skills/discovery-warnings.test.ts packages/bodhi-pi/src/commands/discovery-warnings.test.ts packages/bodhi-pi/test/subagents-discovery.test.ts packages/bodhi-pi/src/skills/discovery.test.ts packages/bodhi-pi/src/commands/discovery.test.ts` | Existing tests must stay green after validator return-shape change. |
| C1 (full) | `npm run check` from repo root | Type + lint sweep across the workspace. |
| C2 | `npx vitest run packages/bodhi-pi/test/subagents-cancellation.test.ts packages/bodhi-pi/test/subagents-fork.test.ts packages/bodhi-pi/test/subagents-spawn.test.ts packages/bodhi-pi/test/subagents-llm-invocation.test.ts` | Spawn + llm-invocation included as regression check (not refactored but must still pass). |
| C3 | `npm run check` + (if API keys) `npx playwright test packages/bodhi-pi/e2e-ui/specs/subagents.spec.ts packages/bodhi-pi/e2e-ui/specs/subagents-fork.spec.ts packages/bodhi-pi/e2e-ui/specs/subagents-builtin.spec.ts` | builtin spec is regression-only. |
| C4 | `npx vitest run packages/bodhi-pi/` + `npm run check` | Full bodhi-pi sweep catches any hidden consumer of `config`. |

End-to-end gate after all four commits: `npm run check` + `npx vitest run packages/bodhi-pi/`. Confirm clean bisect by `git bisect` would land cleanly on any of the four commits.

## Risk register

| # | Risk | Likelihood | Mitigation |
| --- | --- | --- | --- |
| R1 | C1 validator return-shape change (`null` → `{profile} \| {reason}`) breaks an unmapped caller. | Low — exploration mapped the only consumer in each loader. | TDD: existing `subagents-discovery.test.ts` is the safety net (asserts post-load output). Run full bodhi-pi vitest sweep before commit. |
| R2 | C1 warn calls fire frequently in healthy projects (e.g., scratch markdown in the dir). | Low — discovery happens once per session bootstrap, not in a hot loop. | Only warns on actually-rejected files; healthy directories produce zero warnings. |
| R3 | C2 helper signature can't express one of the queue shapes (e.g., parent without leading tool call). | Medium — `subagents-fork.test.ts` line 155 has `[parent text, child factory]` shape (no parent tool call). | Helper makes `parentToolCalls` optional and skips that prelude turn when absent. Spawn test lines 46-53 has 4 turns including a child tool call — helper's `childResponses` accepts both `AssistantMessage` and factories so this composes. Document in helper JSDoc-equivalent (one-line type doc) once written. |
| R4 | C3 helper's hard-coded `data-subagent-event` attribute won't generalize to future event families. | Medium — fine for today's two specs. | If a new event family (`data-tool-event`?) emerges later, widen the helper to take an `attribute?: string` option. Out of scope for this commit. |
| R5 | C4 drops a field someone reads via duck-typing (`(service as any).config`). | Very low — grep negative. | Re-grep at commit time. Revert is one-liner. |
| R6 | Concurrent `bodhi-pi-coding-agent` WIP stages files between our `git add` calls. | Medium — known per `feedback_atomic_commit_with_reset`. | Use the chained `git reset && git add && git commit` pattern shown in each commit block. Never two-step add+commit. |

## Out of scope

- `subagents-doctor` slash command (separate, larger feature).
- P2b parallel batch — comes after this cleanup pass.
- P3d skill inheritance — separate future phase.
- Profile-orphan-lint logic — not part of these four items.
- Widening `BodhiPiLogger` beyond `warn()` (no `info`/`debug` added).
- Changing the validator-return shape outside what C1 requires.
- Refactoring `subagents-spawn.test.ts` or `subagents-llm-invocation.test.ts` to use `scriptSubagentRun` in this pass — incremental adoption per C2 scope.
- Adding `systemMessageWithEvent` callers in `subagents-builtin.spec.ts` — incremental adoption per C3 scope (regression-only here).

## References

- Kickoff: `ai-docs/prompts/2026-05-18-bodhi-pi-sub-agents-cleanup-followups.md`.
- Retrospectives: `ai-docs/sub-agents/v2-retrospective.md`, `ai-docs/sub-agents/p2a-retrospective.md`.
- V1 commits: `f7d7d421`, `532ee5fc`, `c8e06bf1`, `62486bfa`.
- V2 commits: `4d07c27b`, `9b67f7b4`, `e2a3e93d`, `cea50e87`, `ea70a10e`, `121ba066`, `d2a2fc51`, `d963a049`, `2756e5eb`, `bf4d5937`.
- P2a commits: `bb17df96`, `87ab9b2e`, `7d5bfd18`, `764cb275`, `0200ffda`, `50c3ca45`.
- Memory referenced: `feedback_no_low_value_comments`, `feedback_atomic_commit_with_reset`, `feedback_bodhi_pi_e2e_strategy`.

## When done (executor checklist)

1. Print the plan path actually executed against.
2. List commits in order with their SHAs.
3. Note any Playwright runs that were skipped because API keys were absent (per `feedback_bodhi_pi_e2e_strategy`).
4. Note any tests added beyond the planned `*-warnings` set.
5. Confirm `npm run check` + `npx vitest run packages/bodhi-pi/` both green at the tip.
