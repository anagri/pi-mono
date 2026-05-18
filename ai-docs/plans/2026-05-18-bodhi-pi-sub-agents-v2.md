# bodhi-pi sub-agents v2 — bundled built-ins + extension-registered profiles + v1 carry-forward

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan commit-by-commit. Trunk-based — each commit must be green on its own.
>
> **Naming note:** plan-mode forced the file path here; on approval, rename/move to `ai-docs/plans/2026-05-18-bodhi-pi-sub-agents-v2.md` to match the prompt's convention.

## Context

V1 of bodhi-pi sub-agents shipped 2026-05-18 (commits `f7d7d421` → `c8e06bf1` → `62486bfa`). V1 supports profiles discovered from `<cwd>/.bodhi-pi/agents/<name>.md` only — no built-ins shipped with the package, no way for extensions to contribute profiles. The v1 retrospective (`ai-docs/sub-agents/retrospective.md`) also flagged three carry-forward items: a missing cancellation test, an O(n) recursion-depth walk on every spawn, and an unconditional child-eviction step that will need to differ once background runs (P3a) land.

This plan covers P2c + P2d from `ai-docs/sub-agents/roadmap.md` plus the three carry-forwards. After v2, profiles flow from three sources merged at session bootstrap with precedence project > extension > built-in, the `subagent` tool registers off the merged list, and the runtime lifecycle is positioned for P3a without changing today's foreground semantics.

**Pre-existing v1 bug folded into v2 as C0:** a Chrome reproduction during plan-review surfaced a schema bug in the `subagent` LLM tool. `src/tools/subagent.ts:61-63` declares `context: Type.Optional(Type.Literal("fresh"))`, which compiles to a JSON-Schema `{const: "fresh"}`. LLMs treat `context` as an attractor field name and fill it with free text; validation then rejects the tool call with `Validation failed for tool "subagent":\n  - context: must be equal to constant`. The v1 e2e (`subagents.spec.ts`) exercises only the deterministic `/subagent` slash path that calls `_bodhi-pi/subagent/run` directly — the LLM-invocation path is uncovered, so v1 shipped this gap. The `context` field is also dead code: the tool's `execute` (line 36-44) never reads `params.context`; `SubagentProfile.context` is hardcoded at discovery (`discovery.ts:47`). v2's two new built-ins are explicitly designed to be LLM-invoked, so this must land **before** C1 or v2 ships broken end-to-end.

## Goal

Two new contribution sources for sub-agent profiles, plus three carry-forward fixes from v1 — and a pre-existing schema-bug fix folded in as C0:

0. **(C0, pre-flight)** Remove the dead-code `context` field from the `subagent` LLM tool schema (`src/tools/subagent.ts:61-63`). Land a faux-provider regression test that exercises the LLM-invocation path of the tool — would have caught the original bug and gates all future v2 work.
1. **Bundled built-in profiles** — `explore` + `planner`, shipped under `src/subagents/profiles/` as TS modules with template-literal bodies. Runtime-neutral (works in cli + http + browser Worker + MV3 chrome-ext with no per-bundler tricks). Ship user-locked: no `worker`/`execute` default.
2. **Extension-registered profiles** — new `ExtensionAPI.registerSubagentProfile(def)` peer of `registerTool`/`registerCommand`/`registerProvider`. Aggregated by `ExtensionRunner.getSubagentProfiles()`; merged into the registry at runner build time.
3. **Carry-forward triplet** (each its own slim commit):
   - Cancellation test (`test/subagents-cancellation.test.ts`)
   - `SessionState.subagentDepth` O(1) caching (replaces the per-spawn entry walk)
   - `SubagentService.evictChild` lifecycle move from unconditional `finally` to per-status branches (foreground=evict; background-future=preserve)

## Architecture

- `loadProjectSubagents` shape unchanged — gains `disabled?: boolean` frontmatter passthrough (not dropped at parse; the merger decides), stamps `source: "project"` on every returned profile.
- New `getBuiltinSubagentProfiles(): SubagentProfile[]` from `src/subagents/profiles/index.ts` — pure TS, two static entries, module-load assertion that no built-in self-declares `disabled:true`.
- New `mergeSubagentProfiles(project, extension, builtin): SubagentProfile[]` in `src/extensions/merge.ts` (sibling of `mergeTools`/`mergeCommands`). Precedence project > extension > built-in. After precedence dedup, entries where the winning entry has `disabled:true` are dropped from output.
- `ExtensionAPI` gains `registerSubagentProfile(def): () => void`. `ExtensionRunner` validates via a shared helper extracted from `discovery.ts` (name regex, body trim, maxTurns default, throw on `disabled:true`), then exposes via `getSubagentProfiles()`.
- `loadProjectArtifacts` in `session-bootstrap.ts` calls the merger and returns the merged list under the existing `subagentProfiles` slot.
- `SessionState.runtime.subagentDepth: number` populated by `buildSessionState` (=0) and `buildChildSessionState` (=depth-arg). `SubagentService.spawn` reads `parent.runtime.subagentDepth + 1`; local `computeChildDepth` walker is deleted.
- `SubagentService.spawn` finally → per-status branches: `evictChild` invoked explicitly on completed/cancelled/failed. The P3a seam (background mode will skip eviction) is captured in the commit message, not in source comments.

## Tech Stack

- TypeScript strict, ESM, **no `node:*` in `src/`** (per `packages/bodhi-pi/CLAUDE.md`).
- Vitest for unit/integration; Playwright for e2e-ui across all 4 reference Hosts.
- Faux provider for cancellation timing; gpt-4o-mini for the e2e LLM gate (per `feedback_bodhi_pi_e2e_strategy`).

---

## Locked-scope summary

| Decision | User-locked answer | Lands at |
|---|---|---|
| Built-in profiles count | `explore` + `planner` only | `src/subagents/profiles/{explore,planner}.ts` |
| Name precedence | project > extension > built-in | `src/extensions/merge.ts` |
| Disable mechanism | project markdown `disabled:true` overrides + hides | `src/subagents/types.ts`, `src/extensions/merge.ts` |
| Built-in delivery | TS modules with template-literal bodies | `src/subagents/profiles/*.ts` |
| Extension API shape | `SubagentFrontmatter`-like def (validated like markdown) | `src/extensions/types.ts:81-97` |
| `disabled` timing | Merge-time, post-precedence | `src/extensions/merge.ts:mergeSubagentProfiles` |
| `source` on `SubagentProfileSummary` | Add now: `"project" \| "extension" \| "builtin"` | `src/subagents/types.ts` + `acp.md` |
| Self-disabled at source | Extension throws at registration; built-in asserts at module load | `src/extensions/runner.ts`, `src/subagents/profiles/index.ts` |
| `subagentDepth` migration | None — no production yet, fresh sessions only; older child rehydrations get `subagentDepth: 0` (acceptable) | `src/sessions/session-bootstrap.ts`, `src/subagents/build-child-state.ts` |
| Cancellation pattern | Faux provider with `await sleep(N)` in response generator | `test/subagents-cancellation.test.ts` |
| Carry-forward triplet | All three land in v2 as own slim commits | C3a/b/c |
| Foreground evict semantics | Move from `finally` to status branches; behavior-preserving today | `src/subagents/subagent-service.ts:215-269` |

## Open-question resolutions

| Question | Resolution |
|---|---|
| Built-in delivery — TS vs `.md` imports | **TS modules with template literals** |
| Extension def shape — frontmatter vs full profile | **`SubagentFrontmatter`-like** |
| `disabled` timing — parse vs merge | **Merge-time post precedence** |
| `source` field on summary | **Add now** |
| Self-disabled extension/built-in | **Extension throws; built-in asserts** |
| `subagentDepth` migration | **None — no backfill, no production yet** |
| Cancellation test pattern | **Faux provider + `await sleep`** |

---

## File inventory

### New files

| Path | Purpose |
|---|---|
| `packages/bodhi-pi/src/subagents/profiles/index.ts` | `getBuiltinSubagentProfiles(): SubagentProfile[]`. Module-load assertion that no entry has `disabled:true`. Returns the two built-ins sorted by `byName`. |
| `packages/bodhi-pi/src/subagents/profiles/explore.ts` | `EXPLORE_PROFILE: SubagentProfile` — read-only investigator. `tools` allowlist: see "Built-in profile drafts" below. `source: "builtin"`, `filePath: "builtin:explore"`. |
| `packages/bodhi-pi/src/subagents/profiles/planner.ts` | `PLANNER_PROFILE: SubagentProfile` — planning prose only, same read-only `tools` allowlist. `source: "builtin"`, `filePath: "builtin:planner"`. |
| `packages/bodhi-pi/src/subagents/_validate.ts` | Extracted helper from `discovery.ts:loadProfile` — `validateAndNormalizeProfile(input, source, filePath): SubagentProfile \| null`. Reused by discovery + ExtensionRunner so all three contribution sources share validation. |
| `packages/bodhi-pi/test/subagents-llm-invocation.test.ts` | **C0 regression test.** Faux provider that emits a `tool_use` for `subagent` with `{agent: "<fixture>", task: "..."}` (no `context` field, since the schema no longer has one). Assert tool result is `isError: false`, child summary returned, parent gets a clean `subagent_result`. A second case sends a `tool_use` with an unknown `context` field and asserts it's rejected by `additionalProperties: false` — this guards against schema drift letting attractor fields back in. |
| `packages/bodhi-pi/test/subagents-builtin.test.ts` | Integration: harness without `.bodhi-pi/agents/`; assert (a) `subagent` tool registered, (b) `_bodhi-pi/subagent/list` returns `[explore, planner]` with `source:"builtin"`, (c) project markdown override flips `source:"project"` and replaces body, (d) project `disabled:true` markdown for `explore` drops it from the list. |
| `packages/bodhi-pi/test/subagents-extension-profile.test.ts` | Integration: faux extension registers `dummy`; assert (a) `source:"extension"`, (b) project `dummy.md` overrides → `source:"project"`, (c) extension calling `registerSubagentProfile({...,disabled:true})` throws, (d) extension overrides a built-in (project absent → extension wins → `source:"extension"`). |
| `packages/bodhi-pi/test/subagents-cancellation.test.ts` | Faux provider with `await sleep(1500)` in response generator; parent fires `client.cancel({sessionId})` at 200ms. Asserts `status:"cancelled"`, `subagent_complete{status:"cancelled"}` entry appended, parent tool-result text matches `<subagent_result status="cancelled">`. |
| `packages/bodhi-pi/test/subagents-depth-cache.test.ts` | Asserts (a) top-level `SessionState.runtime.subagentDepth === 0`, (b) spawned child gets `depth = 1`, (c) recursion to depth 2 reads from cached field (no `computeChildDepth` walker called), (d) attempted depth 3 throws with the existing message. |
| `packages/bodhi-pi/e2e/subagents-builtin.e2e.ts` | gpt-4o-mini round-trip: seed `<cwd>/SENTINEL.md` with a known phrase; spawn `explore` with task "find the sentinel phrase"; assert summary contains the sentinel. No `.bodhi-pi/agents/` seed. |
| `packages/bodhi-pi/test-apps/cli/e2e/subagents-builtin.e2e.ts` | cli Host e2e mirror of the above. |
| `packages/bodhi-pi/test-apps/http/test/integration/subagents-builtin.test.ts` | http per-turn-rebuild integration: list returns built-ins after rehydration; spawn round-trips through agent rebuild. |
| `packages/bodhi-pi/test-apps/browser/e2e/subagents-builtin.spec.ts` | Playwright spec (browser + chrome-ext via shared spec mechanism; http variant if Playwright matrix runs there). `/agents` lists `explore` + `planner`; `/subagent explore find SENTINEL` round-trips and renders `subagent_complete`. |
| `ai-docs/sub-agents/v2-retrospective.md` | Mirror v1 retrospective shape — what shipped, surprises, carry-forward. |

### Touched files

| Path | Change |
|---|---|
| `src/tools/subagent.ts:50-73` | **(C0)** Delete the `context: Type.Optional(Type.Literal("fresh"))` field from `buildSubagentSchema`. Dead code (execute never reads `params.context`); attracts free-text from LLMs and fails validation. `SubagentProfile.context: "fresh"` (the internal type) is unchanged. Description text on the tool already mentions "Default context is fresh" — keep that sentence; it's prose, not schema. |
| `src/subagents/types.ts:1-39` | Add `disabled?: boolean` to `SubagentFrontmatter`, `SubagentProfile`. Add `source: "project" \| "extension" \| "builtin"` to `SubagentProfile` + `SubagentProfileSummary`. Update `profileToSummary` to carry `source`. |
| `src/subagents/discovery.ts:24-87` | Stamp `source: "project"` on returned profiles. Pass `disabled` frontmatter through to the profile (do not drop at parse). Extract the validation/normalization body into `_validate.ts` and re-import. |
| `src/subagents/build-child-state.ts:9-91` | Set `runtime.subagentDepth = args.depth` on the child SessionState. (The `depth` arg already exists in the function signature.) |
| `src/subagents/subagent-service.ts:139-279` | (C3b) Replace `computeChildDepth(parentRecord?.entries)` with `parent.runtime.subagentDepth + 1`; remove the local `computeChildDepth` function and the `parentRecord` load it depended on. (C3c) Move `this.evictChild(childSessionId)` out of the `finally` block into per-status branches (completed/cancelled/failed all evict in v2; no source comments — P3a-seam WHY lives in the commit message). |
| `src/sessions/session-state.ts` | Add `subagentDepth: number` to `SessionState.runtime` (set unconditionally — never undefined). |
| `src/sessions/session-bootstrap.ts:60-326` | `buildSessionState`: set `runtime.subagentDepth = 0`. `loadProjectArtifacts`: call `mergeSubagentProfiles(project, extension, builtin)` where `extension = extensionRunner?.getSubagentProfiles() ?? []` and `builtin = getBuiltinSubagentProfiles()`; return the merged list under the existing `subagentProfiles` slot. |
| `src/extensions/types.ts:81-97` | Add `registerSubagentProfile(def: ExtensionSubagentProfileDef): () => void` to `ExtensionAPI`. Define `ExtensionSubagentProfileDef` (mirrors `SubagentFrontmatter` with `name`/`description`/`body` required; optional `model`, `tools`, `maxTurns`, `context`, `disabled`). |
| `src/extensions/runner.ts:55-223` | Track `subagentProfiles: SubagentProfile[]` (stamped `source: "extension"`). Validate at registration via `validateAndNormalizeProfile`; throw `RequestError` (or domain error) if `disabled === true` was supplied. Expose `getSubagentProfiles(): SubagentProfile[]`. |
| `src/extensions/merge.ts` | Add `mergeSubagentProfiles(project, extension, builtin): SubagentProfile[]` — precedence dedup, then drop entries where the winning has `disabled:true`. Sort by `byName`. |
| `ai-docs/specs/bodhi-pi/subagents.md` | New sub-sections: "Built-in profiles", "Extension-registered profiles", "Precedence + disabled-aware merge". Frontmatter table gains `disabled?: boolean`. C2/C3 sketches → mark as landed; phase labels refreshed. |
| `ai-docs/specs/bodhi-pi/extensions-skills-commands.md` | Sub-agent row: note three contribution sources, link to subagents.md merge section. Mark `Can register tools` row: still implicit, conditional on merged list `length > 0`. |
| `ai-docs/specs/bodhi-pi/acp.md` | `_bodhi-pi/subagent/list` response: `SubagentProfileSummary` summary now includes `source`. |
| `ai-docs/sub-agents/roadmap.md` | Mark P2c + P2d landed; refresh remaining ordering. |
| `ai-docs/sub-agents/pending.md` | Remove rows for "Bundled profiles" + "Extension-registered profiles". |

---

## Built-in profile drafts (iterate via C4 e2e)

> **Tool allowlist verification first.** Before settling these, read `packages/bodhi-pi/src/tools/index.ts` and confirm the actual built-in tool names. The prompt suggested `read, ls, find, grep`; the lock-in list is whatever `createBuiltinTools` registers for the read-only set, named exactly. If the names differ (e.g., `fs_read`), use the actual names — wrong names = silent allowlist mismatch.

### `explore` body (terse starting draft; tighten via e2e)

```
You are explore — a read-only investigator.

Your only job: read the workspace and report findings. You MUST NOT modify
files, run scripts, or change state in any way. The parent agent will use
your report to decide next steps.

Available tools are read-only (file read, list, find, grep). You have no
write/edit/bash. Do not attempt to use any other tool.

Workflow:
1. Re-read the task. State the specific question.
2. Investigate. Read what's needed; do not boil the ocean.
3. Report findings as plain prose. Cite file paths and line numbers for
   every concrete claim; quote short snippets when relevant.

Do not propose changes. Do not editorialize. Report what you found, where
you found it, and let the parent decide.
```

### `planner` body (terse starting draft; tighten via e2e)

```
You are planner — design plans, do not execute them.

Your job: produce a numbered implementation plan another agent can execute.
You MUST NOT edit files, run scripts, or change state. Read the codebase
as needed to ground your plan in reality — vague plans waste downstream
effort.

Available tools are read-only (file read, list, find, grep). You have no
write/edit/bash.

Workflow:
1. Re-read the task. State the deliverable in one line.
2. Read the relevant code. Skim, do not memorize.
3. Output a numbered plan. Each step: one action, a file path, a one-line
   verification check.

Plans must be concrete. Do not write "add appropriate error handling" —
say what error, where. Do not propose abstractions without naming the
existing pattern they mirror.
```

---

## Per-commit slice

### C0 — Drop `context` from `subagent` tool schema + LLM-invocation regression test

**Scope:** fix the pre-existing v1 schema bug surfaced in Chrome reproduction. Locks the LLM-invocation path before v2 lands two new built-ins that depend on it.

**Files:** modify `src/tools/subagent.ts` (delete `context` from `buildSubagentSchema`); create `test/subagents-llm-invocation.test.ts`; modify `ai-docs/specs/bodhi-pi/subagents.md` (drop the `context` row from the LLM tool params section).

**Steps:**
1. Write failing `test/subagents-llm-invocation.test.ts`. Use the faux provider per `feedback_bodhi_pi_e2e_strategy` — emit one `tool_use` for `subagent` with `{agent, task}` (no `context` field), then a follow-up `end_turn` after the tool result. Seed one fixture profile (`.bodhi-pi/agents/extractor.md` with a body that read-summarizes the seeded file). Assert: (a) the tool_result is `isError: false`, (b) `details.kind === "subagent_result"`, (c) summary text is non-empty.
2. Write a second test in the same file: faux provider emits `tool_use` for `subagent` with `{agent, task, context: "some free text"}`. Assert: tool_result is `isError: true` and matches `/additionalProperties|unknown/i`. This guards against schema drift re-introducing an attractor field.
3. Run `npm test --workspace=packages/bodhi-pi -- subagents-llm-invocation` → expect FAIL on (a)+(b)+(c): tool_result is currently `isError: true` with `Validation failed for tool "subagent":\n  - context: must be equal to constant`.
4. Delete `context: Type.Optional(Type.Literal("fresh", ...))` (lines 61-63) from `src/tools/subagent.ts`. Do not touch `SubagentProfile.context` in `types.ts` — that internal field is consumed elsewhere.
5. Run the new test → green. Run existing `test/subagents-spawn.test.ts` + `subagents-list-extmethod.test.ts` → green (they never used `params.context`).
6. Update `ai-docs/specs/bodhi-pi/subagents.md` — drop the `context` row from the documented `subagent` LLM tool parameters; add a one-sentence note that context fixed at `"fresh"` is internal until P2a introduces a real mode discriminator.
7. Run `npm run check` → green.
8. Commit: `bodhi-pi sub-agents v2: C0 — drop context attractor from subagent tool schema + LLM-invocation test`. Commit body cites the Chrome reproduction and the exact validation error string so future bisect lands here directly.

### C1 — Built-in delivery + `disabled?` + `source` + merger (project + builtin only)

**Scope:** bundle the two built-ins, add `disabled?`/`source` to the schema, ship the merger with 2-arity (extension arg lands in C2).

**Files:** create `src/subagents/profiles/{index,explore,planner}.ts`, `src/subagents/_validate.ts`; modify `src/subagents/types.ts`, `src/subagents/discovery.ts`, `src/subagents/build-child-state.ts`, `src/extensions/merge.ts`, `src/sessions/session-bootstrap.ts`. Test: `test/subagents-builtin.test.ts`. Specs: `ai-docs/specs/bodhi-pi/subagents.md`, `ai-docs/specs/bodhi-pi/acp.md`.

**Steps:**
1. Write failing `test/subagents-builtin.test.ts` covering the four assertions in the file inventory.
2. Run `npm test --workspace=packages/bodhi-pi -- subagents-builtin` → expect FAIL.
3. Extract `validateAndNormalizeProfile` into `_validate.ts` (refactor only; existing discovery tests must stay green).
4. Add `disabled?` + `source` to `SubagentFrontmatter`/`SubagentProfile`/`SubagentProfileSummary`; update `profileToSummary`.
5. Write `src/subagents/profiles/{explore,planner}.ts` with bodies from "Built-in profile drafts" above; verify tool names against `src/tools/index.ts`.
6. Write `src/subagents/profiles/index.ts` with `getBuiltinSubagentProfiles()` + module-load `assert(!p.disabled)` per entry.
7. Write `mergeSubagentProfiles(project, builtin)` (2-arity) in `src/extensions/merge.ts`. Drop disabled-winning entries; sort by name.
8. Wire merger into `loadProjectArtifacts`; stamp `source` in discovery.
9. Update `subagents.md` (new sub-sections, frontmatter table) + `acp.md` (`source` field).
10. Run `npm test --workspace=packages/bodhi-pi` + `npm run check` → all green.
11. Commit: `bodhi-pi sub-agents v2: C1 — bundled built-ins + disabled-aware merge`.

### C2 — `ExtensionAPI.registerSubagentProfile` + runner aggregation

**Scope:** add the extension contribution path; extend the merger to 3-arity.

**Files:** modify `src/extensions/types.ts`, `src/extensions/runner.ts`, `src/extensions/merge.ts`, `src/sessions/session-bootstrap.ts`, `ai-docs/specs/bodhi-pi/extensions-skills-commands.md`, `ai-docs/specs/bodhi-pi/subagents.md`. Test: `test/subagents-extension-profile.test.ts`.

**Steps:**
1. Write failing `test/subagents-extension-profile.test.ts` covering the four assertions in the file inventory.
2. Run → FAIL.
3. Add `ExtensionSubagentProfileDef` type + `registerSubagentProfile` method to `ExtensionAPI`.
4. In `ExtensionRunner`: track `subagentProfiles: SubagentProfile[]`; validate via `validateAndNormalizeProfile(def, "extension", "extension:" + def.name)`; throw `RequestError(-32603, ...)` if `def.disabled === true`. Expose `getSubagentProfiles()`.
5. Extend `mergeSubagentProfiles` to 3-arity `(project, extension, builtin)`.
6. Bootstrap: pass `extensionRunner?.getSubagentProfiles() ?? []` as second arg.
7. Update `extensions-skills-commands.md` sub-agent row + add "Extension-registered" sub-section to `subagents.md`.
8. Run `npm test` + `npm run check` → green.
9. Commit: `bodhi-pi sub-agents v2: C2 — ExtensionAPI.registerSubagentProfile`.

### C3a — Cancellation test

**Scope:** lock down the v1-deferred cancellation behavior in a regression test.

**Files:** create `test/subagents-cancellation.test.ts`.

**Steps:**
1. Build a faux provider whose response generator awaits `setTimeout(r, 1500)` before returning a regular assistant turn.
2. Test harness: spawn an `explore` (or fixture) profile; fire `client.cancel({sessionId})` via `setTimeout(..., 200)`.
3. Assert: `result.status === "cancelled"`; loaded child SessionRecord ends with `subagent_complete{status:"cancelled"}`; parent `subagent` tool result text starts with `<subagent_result status="cancelled">`.
4. Run → green (the underlying cancel path already works; this is a missing-test gap, not a behavior gap).
5. Commit: `bodhi-pi sub-agents v2: C3a — cancellation regression test`.

### C3b — `SessionState.subagentDepth` caching

**Scope:** replace per-spawn O(n) walk with cached field. Pure perf + correctness; no behavior change visible to consumers.

**Files:** modify `src/sessions/session-state.ts`, `src/sessions/session-bootstrap.ts`, `src/subagents/build-child-state.ts`, `src/subagents/subagent-service.ts`. Test: `test/subagents-depth-cache.test.ts`.

**Steps:**
1. Write failing `test/subagents-depth-cache.test.ts` covering the four assertions in the file inventory.
2. Add `subagentDepth: number` to `SessionState.runtime`; populate `0` in `buildSessionState`; populate `args.depth` in `buildChildSessionState`.
3. In `SubagentService.spawn`: replace `const depth = computeChildDepth(parentRecord?.entries)` with `const depth = parent.runtime.subagentDepth + 1`; drop the `parentRecord` load if not otherwise used; delete the local `computeChildDepth` function.
4. Verify existing `test/subagents-spawn.test.ts` + new depth-cache test pass; verify `MAX_DEPTH` enforcement at depth=3 still throws with the same message.
5. Run `npm test` + `npm run check` → green.
6. Commit: `bodhi-pi sub-agents v2: C3b — subagentDepth cached on SessionState`. Note in commit body: pre-v2 SessionStore child records rehydrated post-v2 will read `subagentDepth: 0` (acceptable; no production release).

### C3c — `evictChild` lifecycle per-status

**Scope:** prep seam for P3a; behavior-preserving in v2.

**Files:** modify `src/subagents/subagent-service.ts:215-269`.

**Steps:**
1. Move `this.evictChild(childSessionId)` out of the unconditional `finally` block. Invoke explicitly in each terminal branch (status==="completed" path, status==="cancelled" path, status==="failed" path) just before the return. **No code comments** — per repo rule, the WHY (foreground evicts; background-future P3a will skip) goes in the commit message body, not in source.
2. Verify existing `test/subagents-spawn.test.ts` + `test/subagents-cancellation.test.ts` (from C3a) both pass — all three terminal paths still evict.
3. Run `npm test` + `npm run check` → green.
4. Commit: `bodhi-pi sub-agents v2: C3c — evictChild lifecycle per-status`. Body explains the P3a seam.

### C4 — e2e + e2e-ui across all four runtimes

**Scope:** prove the built-in path reaches a real LLM and a real Host UI in every reference Host.

**Files:** create `e2e/subagents-builtin.e2e.ts`, `test-apps/cli/e2e/subagents-builtin.e2e.ts`, `test-apps/http/test/integration/subagents-builtin.test.ts`, `test-apps/browser/e2e/subagents-builtin.spec.ts` (chrome-ext via shared-spec mechanism per `feedback_bodhi_pi_e2e_layout`).

**Steps:**
1. Direct-ACP e2e: gpt-4o-mini spawns `explore` over a seeded `SENTINEL.md`; assert the summary contains the sentinel keyword.
2. cli e2e: same scenario through the cli Host; no `.bodhi-pi/agents/` seed.
3. http integration: faux-provider per-turn-rebuild scenario — list returns built-ins after agent rehydration; spawn round-trips.
4. Playwright spec, slash-dispatch path: `/agents` lists `explore` + `planner`; `/subagent explore find SENTINEL` round-trips and renders `subagent_complete`. Share spec body across browser + chrome-ext.
5. **Playwright spec, natural-language LLM-invocation path** (the gap that would have caught the C0 bug pre-merge): send a free-text prompt like "Use the explore sub-agent to find the SENTINEL keyword in this workspace" through `session/prompt`. Assert (a) the wire shows a `tool_call` with `toolName === "subagent"` (the LLM picked the tool, not a fallback to `read`), (b) the corresponding `tool_result` is `isError: false`, (c) the sentinel keyword reaches the final assistant message. Uses gpt-4o-mini per `feedback_bodhi_pi_e2e_strategy`.
6. Run `just test-e2e` then `just test-e2e-ui` → all green.
7. Commit: `bodhi-pi sub-agents v2: C4 — e2e + e2e-ui across four Hosts (slash + LLM-invocation paths)`.

### C5 — Retrospective + roadmap

**Files:** create `ai-docs/sub-agents/v2-retrospective.md`; modify `ai-docs/sub-agents/roadmap.md`, `ai-docs/sub-agents/pending.md`.

**Steps:**
1. Write `v2-retrospective.md` (mirror v1 shape): what shipped, surprises, what to carry forward into v3.
2. Update `roadmap.md`: mark P2c + P2d landed; promote next candidate per the existing ordering (`P2a` per `roadmap.md:5`).
3. Update `pending.md`: remove the rows for "Bundled profiles" + "Extension-registered profiles".
4. Commit: `bodhi-pi sub-agents v2: C5 — retrospective + roadmap refinement`.

---

## Verification matrix

Run after each commit; final commit additionally runs the full e2e juicers.

| Slice | Per-Host command |
|---|---|
| C0 | `npm test --workspace=packages/bodhi-pi -- subagents-llm-invocation subagents-spawn subagents-list-extmethod` + `npm run check` |
| C1 | `npm test --workspace=packages/bodhi-pi -- subagents-builtin subagents-discovery` + `npm run check` |
| C2 | `npm test --workspace=packages/bodhi-pi -- subagents-extension-profile subagents-builtin` + `npm run check` |
| C3a | `npm test --workspace=packages/bodhi-pi -- subagents-cancellation` |
| C3b | `npm test --workspace=packages/bodhi-pi -- subagents-spawn subagents-depth-cache` |
| C3c | `npm test --workspace=packages/bodhi-pi -- subagents-spawn subagents-cancellation` |
| C4 direct-ACP + cli e2e | `just test-e2e` (filter `subagents-builtin` for fast iteration) |
| C4 http integration | `npm test --workspace=packages/bodhi-pi-test-app-http -- subagents-builtin` |
| C4 Playwright | `just test-e2e-ui` (asserts across browser + chrome-ext + http) |
| Final gate | `npm run check` + `npm test` (all workspaces) + `just test-e2e` + `just test-e2e-ui` |

---

## Risk register

1. **Cross-runtime bundling.** TS template literals are runtime-neutral by construction (no bundler-specific imports). Risk: someone adds a `node:fs.readFileSync` shortcut to read a sibling `.md` from `profiles/`. Mitigation: rule already enforced by `packages/bodhi-pi/CLAUDE.md` ("no `node:*` in `src/`"); reviewable in commit.
2. **Tool-name allowlist mismatch.** `explore`/`planner` lock `tools: [...]` to specific names — if those names don't match `createBuiltinTools` output, the child receives an empty tool set and silently does nothing. Mitigation: C1 step 5 explicitly verifies tool names against `src/tools/index.ts` before locking.
3. **Validation drift between sources.** Markdown loader and extension registration must apply identical name regex, body trim, maxTurns default. Mitigation: extract `_validate.ts` as a shared helper in C1 step 3.
4. **`disabled:true` silent no-op.** A `disabled:true` markdown that doesn't match any extension/built-in name produces zero effect. Mitigation: document the semantics in `subagents.md`; the C1 test exercises the matching-name case so a regression on the override path can't slip in.
5. **`evictChild` regression on one terminal path.** Moving from `finally` to three branches risks missing one. Mitigation: existing spawn tests cover completed + failed; the C3a cancellation test covers cancelled. All three are gated before C3c lands.
6. **`subagentDepth` rehydration of pre-v2 children.** Pre-v2 child SessionRecords rehydrated post-v2 will get `subagentDepth: 0` (the field is set unconditionally on hydration). For a third-level rehydrated spawn this would incorrectly allow it. User-locked: no production yet, so no backfill. Mitigation: C3b commit message calls this out; if a developer's local SQLite carries pre-v2 children, wipe-and-reseed is the workaround.
7. **Spec drift.** `packages/bodhi-pi/CLAUDE.md` mandates same-commit spec updates when ACP surface changes. C0/C1/C2 each must update `subagents.md` (and `acp.md`/`extensions-skills-commands.md` where relevant) in the same commit — do not defer to C5.
8. **Tool-schema fields the LLM cannot satisfy.** Any optional-but-constrained-to-a-constant parameter is hostile to LLMs (they fill it). When a future phase (e.g. P2a) reintroduces a `context`-mode discriminator, pick a non-attractor name (`isolation`, `mode`) and either provide a real union of ≥2 values or no schema entry at all. **Reviewer rule:** any `Type.Literal(...)` inside `Type.Optional(...)` in a tool's `parameters` MUST be accompanied by an LLM-invocation faux-provider test (not just an ext-method or slash test) that asserts the LLM-shaped call actually validates. C0 establishes both the fix and the test template (`subagents-llm-invocation.test.ts`).

---

## Out of scope

Explicitly deferred to later kickoffs:

- **P2a — Forked context** (`context: "fork"`): separate kickoff.
- **P2b — Parallel batch**: needs per-child UI accumulator design.
- **P3a — Background runs**: `evictChild` per-status refactor in C3c is *prep only*; no actual background lifecycle implemented.
- **P3c — MCP allow/deny for children** + **P3d — Skill inheritance for children**: child profile schema unchanged.
- **P4a — Worktree isolation**.
- **ChatPanelPage Playwright helpers** + **`scriptSubagentRun` test helper**: deferred cleanup, not part of this phase (user explicitly distinguished "carry-forward triplet" from the helper-creation work).
- **`subagents.disableBuiltins` setting**: explicitly rejected; markdown-override is the disable path.
- **Vite import-glob delivery for built-ins**: rejected — must work in cli + Node http server too.

---

## When done

Print the plan path, the count of resolved open questions (7), and the proposed commit subjects in order:

1. `bodhi-pi sub-agents v2: C0 — drop context attractor from subagent tool schema + LLM-invocation test`
2. `bodhi-pi sub-agents v2: C1 — bundled built-ins + disabled-aware merge`
3. `bodhi-pi sub-agents v2: C2 — ExtensionAPI.registerSubagentProfile`
4. `bodhi-pi sub-agents v2: C3a — cancellation regression test`
5. `bodhi-pi sub-agents v2: C3b — subagentDepth cached on SessionState`
6. `bodhi-pi sub-agents v2: C3c — evictChild lifecycle per-status`
7. `bodhi-pi sub-agents v2: C4 — e2e + e2e-ui across four Hosts (slash + LLM-invocation paths)`
8. `bodhi-pi sub-agents v2: C5 — retrospective + roadmap refinement`

Plan IS the deliverable. Implementation runs in a separate session, ideally guided by `superpowers:executing-plans` or `superpowers:subagent-driven-development`.
