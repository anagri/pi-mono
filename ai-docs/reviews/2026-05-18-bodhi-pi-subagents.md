# bodhi-pi review — sub-agents (v1 + v2 + P2a)

**Snapshot:** 2026-05-18, range `f7d7d4219^..HEAD` (24 commits, 80 files, entirely inside `packages/bodhi-pi/`). Sub-agents v1 (discovery + spawn + slash UX), v2 (built-in profiles + extension API + cancellation + depth cache + eviction + LIFECYCLE_EVENT_METHOD forwarder), P2a (`context: "fresh" | "fork"` + cloneTranscriptSlice). Reference Hosts touched: `test-apps/{cli,http,browser,node-adapters}`; `test-apps/chrome-ext` inherits via the shared AppShell import (`test-apps/chrome-ext/src/client/react/App.tsx:1`).

Coding-agent drift comparison skipped per `feedback_no_more_coding_agent_compare`. Angle E (matrix parity) found no host-wiring or slash-command gaps; all four reference Hosts and the four Vitest e2e projects (`in-memory`, `cli`, `http`, `ws`) exercise every shipped feature. Brittle-LLM-assert findings against `e2e/shared/subagents-*.e2e.ts` were dropped because each `toContain(...)` is paired with a structural `_bodhi-pi/subagent/children` lookup that verifies the child session was actually created (e.g. `e2e/shared/subagents.e2e.ts:39-44`, `subagents-fork.e2e.ts:44-48`). Two Angle F spec-staleness claims (registerSubagentProfile row missing; sub-agent profiles column missing) were dropped — both are already in `extensions-skills-commands.md:9-18,36`.

---

## Batch A — Architecture: missing capability advertisement + extension-fork asymmetry (Commit 1)

**A.1** The `_bodhi-pi/subagent/*` extension methods are not advertised on `agentCapabilities._meta["bodhi-pi"]`, violating architecture pillar 3 ("Non-spec features advertised via `agentCapabilities._meta["bodhi-pi"]`"). `computeAvailability()` returns `kv`/`mcp`/`terminal`/`scriptExecutor`/`settings`; `subagent` is absent. Remote ACP clients have no protocol-level way to detect whether the agent registered any subagent profiles — they must `extMethod` `_bodhi-pi/subagent/list` and infer from a non-empty result. This is the same failure mode that commit `bafdb900` retro-fixed for the wire forwarder: invisible from the agent's own tests, surfaces only as missing-UI-affordance bugs in third-party hosts.
- `packages/bodhi-pi/src/acp/agent.ts:372-387` (computeAvailability)
- Add `subagent: session.subagentProfiles.length > 0` to the returned shape and thread it into the `agentCapabilities._meta["bodhi-pi"]` payload at initialize/newSession time. Since profiles are per-session (project markdown + extension + built-in), the flag must be computed against the merged registry, not at agent construction. If per-session capabilities don't fit the initialize-time shape, add a `subagentProfileCount: number` to `_bodhi-pi/subagent/list`'s response and document that as the canonical discovery surface in `acp.md`.

**A.2** `ExtensionSubagentProfileDef.context` is typed as the single literal `"fresh"` and `runner.ts` hardcodes `context: "fresh"` when normalising — extensions cannot register fork-mode profiles, only project markdown and bundled built-ins can. `SubagentProfile.context: "fresh" | "fork"` is the union everywhere else. No commit message and no spec sentence documents this restriction; the P2a context-mode work (commits `7d5bfd18`, `764cb275`) landed three commits after `ExtensionAPI.registerSubagentProfile` (`cea50e87`) and did not widen the extension surface.
- `packages/bodhi-pi/src/extensions/types.ts:66` (`context?: "fresh"`)
- `packages/bodhi-pi/src/extensions/runner.ts:171` (`context: "fresh"` hardcoded)
- Widen to `context?: "fresh" | "fork"`, pass `def.context` through in `runner.ts:171`, add a test under `test/subagents-extension-profile.test.ts` registering a fork-mode profile and asserting `SubagentProfile.context === "fork"` reaches the merged registry. If the restriction is intentional, document the rationale in `subagents.md` § "Extension-registered profiles" and throw at registration time when `def.context === "fork"` is supplied rather than silently coercing.

---

## Batch B — Test coverage gaps (Commit 2)

**B.1** `e2e-ui/shared/subagents-fork.spec.ts` is the only fork-mode UI assertion and it never inspects the collapsible transcript group that commit `86453552` shipped. The spec asserts `[data-subagent-event="run-result"][data-subagent-name="reviewer"]` and the run's status attribute, both of which existed before the v2 grouping fix. A regression that removes `<details data-testid="subagent-group">` or breaks the LIFECYCLE_EVENT_METHOD → group wiring would not fail this spec.
- `packages/bodhi-pi/e2e-ui/shared/subagents-fork.spec.ts:13-26`
- Add `await expect(chat.root.locator('[data-testid="subagent-group"][data-subagent-name="reviewer"]')).toBeVisible({ timeout: 120_000 })` after the slash dispatch, plus a check on `[data-subagent-group-body]` containing the inherited-transcript marker. `subagents-builtin.spec.ts:27-31` already does this for the `explore` profile — mirror the shape.

**B.2** No integration test exercises depth=2 (child-of-child) spawn or the depth-cap rejection at depth=3. `subagents-depth-cache.test.ts` only repeats spawn from the same top-level parent (all assertions `depth === 1`); `subagents-spawn.test.ts:88` is the only other `depth` reference. The cap is `SUBAGENT_MAX_DEPTH = 2` (`src/subagents/subagent-service.ts:24`) and the rejection branch lives at `src/subagents/subagent-service.ts:148-151`, but no test reaches it.
- `packages/bodhi-pi/test/subagents-depth-cache.test.ts:31-83`
- `packages/bodhi-pi/src/subagents/subagent-service.ts:148-151` (rejection branch)
- Add two cases to `subagents-depth-cache.test.ts` (or a new `subagents-depth-cap.test.ts`): (1) nested spawn child→grandchild, assert grandchild's `subagent_link.depth === 2`; (2) attempt grandchild→great-grandchild, assert spawn rejects with the depth-cap error and no SessionRecord was created.

**B.3** No test asserts the conditional registration of the `subagent` tool when zero profiles are discovered. `subagents.md:25` and `subagents.md:152-169` both state the tool is registered "ONLY when at least one profile is discovered" — the conditional `subagent: merged.length > 0 ? {...} : undefined` lives in the wiring. Built-in `explore` + `planner` always make `merged.length ≥ 2` in practice, so the conditional branch is effectively unreachable today. Either the conditional is dead (delete it) or there's a path that produces zero profiles (test it).
- `packages/bodhi-pi/src/subagents/subagent-service.ts` (createBuiltinTools call site)
- `packages/bodhi-pi/src/subagents/profiles/index.ts` (`getBuiltinSubagentProfiles()` always returns ≥1)
- Either add a test that disables both built-ins (project markdown with `disabled: true` for `explore` AND `planner`, no extension profiles, no project profiles) and asserts `session.tools` excludes `subagent`; or remove the conditional and document built-ins as a hard floor in `subagents.md`.

**B.4** No test exercises the failed-status eviction branch. `subagents-cancellation.test.ts` covers `"cancelled"`, several tests cover `"completed"`, and `subagents-llm-invocation.test.ts:125` observes `status === "failed"` on the LLM update stream but does not assert the child was removed from the `sessions` map. The 3-arm switch in `subagent-service.ts:292-302` calls `evictChild` identically for all three statuses; the "failed" leg is reachable only via thrown exceptions inside the child's `runPromptLoop` and is currently untested at the integration boundary.
- `packages/bodhi-pi/src/subagents/subagent-service.ts:292-302`
- Add a `subagents-failed-eviction.test.ts` that registers a faux provider whose response throws, spawns the subagent, asserts the parent receives a `<subagent_error>...</subagent_error>` tool result AND that `sessions.get(childSessionId)` returns `undefined` after the spawn returns.

**B.5** `e2e/helpers/load-scenario.ts` (async, `fs.promises`-based, returns `Promise<Record<string,string>>`, exported as `loadScenarioFiles`) and `e2e-ui/helpers/load-scenario.ts` (sync, `fs`-based, returns `Record<string,string>`, exported as `loadScenario`) are duplicate implementations of "walk `data/<name>/` and produce a flat path→content map". The two `data/subagents-*` fixture trees (e2e + e2e-ui) are also duplicated verbatim; a profile-body edit must land in both trees or one runner will silently diverge.
- `packages/bodhi-pi/e2e/helpers/load-scenario.ts:1-22`
- `packages/bodhi-pi/e2e-ui/helpers/load-scenario.ts:1-21`
- `packages/bodhi-pi/e2e/data/subagents-*/`, `packages/bodhi-pi/e2e-ui/data/subagents-*/`
- Pick one async loader (the e2e shape is the more general one), publish it from a shared location reachable by both runners (`packages/bodhi-pi/test-apps/app-utils/` or a sibling `e2e-shared/helpers/`), and make `data/subagents-*` a single tree symlinked or path-aliased into both runners. Per `e2e/CLAUDE.md` "Blackbox boundary", the chosen home cannot be `test-apps/` directly without a path-alias workaround — `app-utils/` is the natural fit.

---

## Batch C — Code health cleanups (Commit 3)

**C.1** The terminal-status switch collapses to a single call. All three arms do `this.evictChild(childSessionId); break;`.
- `packages/bodhi-pi/src/subagents/subagent-service.ts:292-302`
- Replace the switch with `this.evictChild(childSessionId);` after the loop.

**C.2** `SubagentLinkEntry` persists the profile as `profileName: string` (`src/sessions/entries.ts:97`) and the session-store record uses the same key (`subagent: { profileName }`), but `subagent_start` / `subagent_end` events and the tool-result `details` object use `profile: string`. Grep for "profile" in `subagent-service.ts` returns both forms across `:103, :121, :125, :156, :166, :226, :283, :351`. Searches like "all the places we record which profile spawned this child" miss half the call sites depending on which key you grep for.
- `packages/bodhi-pi/src/sessions/entries.ts:97`
- `packages/bodhi-pi/src/subagents/subagent-service.ts:222-231, 279-290, 338-358`
- Pick one (`profile` aligns with the event payload spec at `acp.md:129-130`; `profileName` aligns with the SessionStore field), rename the other site to match, update `subagents-wire-events.test.ts` if it asserts the key by name. The wire shape is the binding contract — if you keep `profile` on events, rename the entry field.

**C.3** `buildToolResult` formats three different wrapper tags (`<subagent_result>`, `<subagent_result status="cancelled">`, `<subagent_error>`) via nested ternaries on `result.status` with no exhaustiveness check. Adding a fourth terminal status (e.g. a future "timeout") would compile cleanly while silently falling into the `else` branch (`<subagent_error>`).
- `packages/bodhi-pi/src/subagents/subagent-service.ts:338-348`
- Replace with a `Record<SubagentSpawnResult["status"], (r) => string>` formatter map + `assertExhaustive(status)` fallback, or a switch that throws on unknown status. The `SubagentSpawnResult["status"]` union is already typed; lean on it.

**C.4** Magic constants `SUMMARY_MAX_CHARS = 4000` and `PROGRESS_TOOL_PREVIEW_CHARS = 80` are file-local while `SUBAGENT_MAX_DEPTH = 2` is exported. The two private ones gate user-visible truncation behaviour (parent's progress UI snippet length + child's summary captured into the parent's transcript) — both deserve either docstrings explaining the user-facing impact, or named exports if the value is part of the contract Hosts may want to inspect/override.
- `packages/bodhi-pi/src/subagents/subagent-service.ts:24-26`
- Either: (a) inline both `4000` and `80` at their single call sites with a brief comment naming the UX trade-off, or (b) keep them as exported constants alongside `SUBAGENT_MAX_DEPTH` and document them in `subagents.md` § "Tunables" so Host authors aren't guessing.

---

## Batch D — Spec staleness: subagents.md + PARITY.md + architecture.md + CONTEXT.md (Commit 4)

`acp.md`, `lifecycle.md`, `extensions-skills-commands.md`, `hosts.md`, `testing.md`, `index.md` are already current for the shipped surface; the staleness is concentrated in `subagents.md` (phase markers + a dead "what arrives later" section) and four ancillary spots that still cite phase labels for landed work.

**D.1** `ai-docs/specs/bodhi-pi/subagents.md:5` says "This spec describes the public surface and the **C1** (discovery scaffold) implementation. **C2** (spawn + foreground run) and **C3** (slash UX + Playwright) extend the same shape" — every cited phase has shipped, plus v2 (built-in profiles + extension API + cancellation + depth cache + eviction + wire forwarder) and P2a (fork mode). The same file carries phase markers at `:13` (`(P2d)`), `:19` (`(C2)`), `:80` (`(P2d)`), `:152` (`## Wiring summary (C1)`), `:178-179` (`## C2/C3 sketch (what arrives later)` — the entire two-bullet "later" section is now history). Living-docs rule per `CLAUDE.md`: "Stale specs are a regression by default."
- `ai-docs/specs/bodhi-pi/subagents.md:5, 13, 19, 80, 152, 176-179`
- Drop every `(C\d)` / `(P\d\w?)` marker; replace `:5` opening with one sentence ("This spec covers the full sub-agents surface: discovery, spawn, slash UX, built-in + extension-registered profiles, cancellation, the depth cap, lifecycle eviction, the wire-event forwarder, and fork-mode context inheritance."); delete the `:176-179` "C2/C3 sketch" section entirely; rename `:152` to `## Wiring summary`. See-also links at `:197-198` reference `ai-docs/sub-agents/v1-plan.md` and `ai-docs/sub-agents/roadmap.md` — verify those still exist, or update to the current plan files under `ai-docs/plans/`.

**D.2** `packages/bodhi-pi/PARITY.md:65` says `| Sub-agents (`.claude/agents/`) | Not on the bodhi-pi roadmap. |`. Sub-agents shipped across three milestones in this branch (v1 + v2 + P2a, 24 commits) with parity in all four reference Hosts.
- `packages/bodhi-pi/PARITY.md:65`
- Replace the row with the shipped status: e.g. `| Sub-agents (`.bodhi-pi/agents/<name>.md` + bundled built-ins + extension-registered) | Shipped across cli, http (per-turn rebuild), browser (Web Worker), chrome-ext (MV3); see [specs/bodhi-pi/subagents.md](ai-docs/specs/bodhi-pi/subagents.md). |`. If PARITY.md has a "shipped" column or status legend, use that convention; otherwise drop the row entirely (the spec is the canonical source).

**D.3** `ai-docs/specs/bodhi-pi/architecture.md:72` lists `SubagentService` as `_bodhi-pi/subagent/{list,run,children} + in-process child-session spawn + progress mirroring + recursion guard` — accurate for v1 but omits the v2/P2a surface that this branch shipped: built-in profile registry, extension-registered profiles (`ExtensionAPI.registerSubagentProfile`), the LIFECYCLE_EVENT_METHOD wire forwarder for `subagent_start`/`subagent_end`, the per-status `evictChild` lifecycle, and `context: "fresh" | "fork"` with `cloneTranscriptSlice`. Other Service rows on the same table list their full surface (e.g. McpService at `:69`) — keep the table consistent.
- `ai-docs/specs/bodhi-pi/architecture.md:72`
- Extend to: `_bodhi-pi/subagent/{list,run,children}` + in-process child-session spawn + progress mirroring + recursion guard + bundled + extension-registered profile registry + `subagent_start`/`subagent_end` lifecycle events forwarded over `LIFECYCLE_EVENT_METHOD` + `context: "fresh" | "fork"` (fork uses `cloneTranscriptSlice` to inherit a filtered parent transcript).

**D.4** `packages/bodhi-pi/CONTEXT.md:84-92` glossary entries for "Sub-agent profile", "Sub-agent Session", and "Sub-agent depth" carry stale `(C2)` markers and say "Hard-capped at 2 in v1 (C2)". v1, v2, P2a are all shipped and on `main`.
- `packages/bodhi-pi/CONTEXT.md:84, 88, 92, 146`
- Strip every `(C2)` / `in v1 (C2)` reference. Replace the depth-cap sentence with "Hard-capped at `SUBAGENT_MAX_DEPTH = 2` (`src/subagents/subagent-service.ts`); `SubagentService.spawn` rejects deeper recursion." Note the addition of context modes in the "Sub-agent profile" entry: `context: "fresh"` (default) vs `"fork"` (child inherits a filtered parent transcript slice).

---

## Suggested commit grouping

Each batch is independently gate-checkable; A and B carry the architectural weight, C is mechanical cleanup, D is the same-commit living-docs fix that the v1/v2/P2a commits should have shipped inline.

1. **Commit 1 — Batch A** — capability advertisement + extension fork-mode decision (widen + test, or document + reject). Touches `src/acp/agent.ts`, `src/extensions/{types,runner}.ts`, `test/subagents-extension-profile.test.ts`, and `ai-docs/specs/bodhi-pi/{acp,subagents,extensions-skills-commands}.md`.
2. **Commit 2 — Batch B** — five test additions: fork UI collapsible group, depth=2 + depth-cap rejection, conditional-registration (or its removal), failed-status eviction, helper consolidation. Touches `e2e-ui/shared/subagents-fork.spec.ts`, `test/subagents-depth-*.test.ts`, `test/subagents-failed-eviction.test.ts` (new), `e2e/helpers/load-scenario.ts`, `e2e-ui/helpers/load-scenario.ts`, and the two `data/subagents-*` trees.
3. **Commit 3 — Batch C** — code cleanups in `src/subagents/subagent-service.ts` and `src/sessions/entries.ts` (collapse switch, naming alignment, exhaustiveness guard, magic-constant policy).
4. **Commit 4 — Batch D** — spec refresh: `ai-docs/specs/bodhi-pi/subagents.md`, `ai-docs/specs/bodhi-pi/architecture.md`, `packages/bodhi-pi/PARITY.md`, `packages/bodhi-pi/CONTEXT.md`.
