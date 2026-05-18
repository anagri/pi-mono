# Kickoff: bodhi-pi sub-agents v2 — bundled built-ins + extension-registered profiles + v1 carry-forward

**Output**: an exploratory plan written to `ai-docs/plans/YYYY-MM-DD-bodhi-pi-sub-agents-v2.md` AFTER you've grilled the user on the open questions below. Read code first, batch decision points via `AskUserQuestion` (each option marked with your recommended answer), get plan approval before any code edits. Same shape as v1's kickoff workflow.

## Status going in

Sub-agents v1 shipped 2026-05-18 across four commits:

- `f7d7d421` — C1 discovery scaffold (profile loader, SubagentService skeleton, `_bodhi-pi/subagent/*` extmethods, conditional `subagent` tool registration, SessionStore `parentSessionId` + `subagent` field plumbing across all 4 runtimes)
- `532ee5fc` — C2 spawn + foreground run (full SubagentService.spawn, child SessionState build, runPromptLoop wiring, progress mirroring, recursion guard at depth 2, `subagent_link`/`subagent_complete` SessionEntry types, `subagent_start`/`subagent_end` events)
- `c8e06bf1` — C3 slash UX + Playwright (`/agents`, `/subagent <name> <task>`, `/subagent children` across cli + browser commands.ts shared by http/browser/chrome-ext)
- `62486bfa` — retrospective + roadmap refinement

V1 surface today:

- 479 unit/integration tests passing; 12 vitest e2e tests across in-memory/cli/http/ws; 4 Playwright tests across http/ws/browser/chrome-ext.
- Profiles discovered from `<cwd>/.bodhi-pi/agents/<name>.md` (markdown only).
- `subagent` tool registered iff `≥1 profile` exists; throws "spawn path lands in C2" never reachable now.
- Child sessions durable in SessionStore, tagged with `subagent: { profileName }`, filtered out of default `listSessions()`.
- Recursion hard-capped at depth 2; children never receive the `subagent` tool.
- No MCP / extension / skill inheritance for child (deliberate v1 cut; deferred to P3c/P3d).

**Read first** (in this order):

1. [`ai-docs/sub-agents/retrospective.md`](../sub-agents/retrospective.md) — what shipped, what surprised, what carries forward.
2. [`ai-docs/sub-agents/design.md`](../sub-agents/design.md) — architecture rationale.
3. [`ai-docs/sub-agents/v1-plan.md`](../sub-agents/v1-plan.md) — commit boundaries v1 followed.
4. [`ai-docs/sub-agents/roadmap.md`](../sub-agents/roadmap.md) — refined post-v1 ordering (P2c → P2d is what this prompt covers).
5. [`ai-docs/sub-agents/pending.md`](../sub-agents/pending.md) — deferred items inventory.
6. [`ai-docs/specs/bodhi-pi/subagents.md`](../specs/bodhi-pi/subagents.md) — current spec; will need amendments.
7. Source: `packages/bodhi-pi/src/subagents/`, `packages/bodhi-pi/src/tools/subagent.ts`, `packages/bodhi-pi/src/sessions/session-bootstrap.ts` (load + bootstrap call sites), `packages/bodhi-pi/src/extensions/types.ts` (ExtensionAPI shape).
8. Upstream research (the harness folder is intentionally not committed but the report is): `ai-docs/research/sub-agents/` — especially how cc / Mastra / pi-subagents define their bundled profiles (`explore`, `plan`, `audit-tests` / `scout/planner/reviewer`). Inspect bodies; pick what fits bodhi-pi's terser house style.

## Goal

Two contribution sources for sub-agent profiles in addition to the existing markdown discovery:

1. **Bundled built-in profiles** shipped in `src/subagents/profiles/` (or equivalent). Ship `explore` and `planner` in v2 (user-locked). The mechanism must be runtime-neutral — bundles must work in cli, http, browser, chrome-ext without any FS scan for the built-ins themselves.
2. **Extension-registered profiles** via a new `ExtensionAPI.registerSubagentProfile(def)` method. Peer with `registerTool`/`registerCommand`/`registerProvider`. Captured at runner build time per the existing extension contract.

Plus three small carry-forward items from the v1 retrospective:

3. **Cancellation test** (`test/subagents-cancellation.test.ts`) — deferred from C2 because testing cancellation with faux providers is awkward. Find a pattern (faux provider with `await sleep(ms)` in the response generator? signal-based abort path test that doesn't require streaming?). Cover at least: parent cancel → child returns `cancelled`, `subagent_complete{status:"cancelled"}` is appended, parent's tool result reflects cancellation.
4. **`SessionState.subagentDepth` caching** — `SubagentService.computeChildDepth` currently re-loads parent's session log on every spawn (O(n entries)). Populate `subagentDepth` on the child SessionState at `buildChildSessionState` time so deep recursion lookups are O(1). Top-level sessions get `subagentDepth: 0`.
5. **`SubagentService.evictChild` lifecycle prep for P3a** — currently eviction runs unconditionally in `spawn()`'s finally block. For future background runs, the child must stay alive across parent turns. Move eviction into the "completion" branch only (foreground always evicts; background — once it exists — skips eviction). Behavior-preserving in v2; sets up the seam for P3a without implementing background.

## Locked scope decisions (user-confirmed)

- **Two built-in profiles**: `explore` (read-only investigator) + `planner` (planning prose, no edits). Skip `worker`/`execute` — too generic, easy to ship a bad default.
- **Name precedence**: project markdown > extension-registered > built-in. The "most local / most specific" source wins. Matches cc/pi-subagents.
- **Disable mechanism**: no top-level setting. Users disable a built-in by creating `.bodhi-pi/agents/<name>.md` with `disabled: true` in frontmatter — that requires adding a new `disabled?: boolean` field to the profile frontmatter schema (and `loadProjectSubagents` drops disabled profiles from the registry).
- **Carry-forward items**: all three small fixes above land in this phase, each as their own slim commit alongside the P2c/P2d work.

## What still exists (don't reimplement)

- `loadProjectSubagents(filesystem, cwd)` in `src/subagents/discovery.ts` — the markdown loader. Returns `SubagentProfile[]`. Extend (don't rewrite) to merge built-ins + extension-registered + disabled-aware.
- `SubagentService` constructor wires `events`, `conn`, `config`, `logger`, `mcpService`, `bootstrapDeps`, `promptLoopDeps`. Its `spawn()` is fully working.
- `createBuiltinTools` in `src/tools/index.ts` accepts `subagent: { sessionId, profiles, service }` and conditionally registers the tool. Same call site can pass the merged list.
- `SubagentFrontmatter` / `SubagentProfile` / `SubagentProfileSummary` in `src/subagents/types.ts`. Grow them with `disabled?: boolean` and (optionally) a `source: "project" | "extension" | "builtin"` field for inspectability.
- `loadProjectArtifacts` in `src/sessions/session-bootstrap.ts:58` — the insertion point for the merge step. Mirror the `mergeCommands`/`mergeTools` pattern from `src/extensions/merge.ts`.
- `ExtensionAPI` shape in `src/extensions/types.ts:81-97` — add `registerSubagentProfile(def): () => void` alongside the existing register methods. ExtensionRunner aggregates and exposes via `runner.getSubagentProfiles()`.

## Open exploration questions to resolve before designing

Resolve these by reading source first, then `AskUserQuestion` (with your recommended answer per question) before writing the plan. Batched per area:

### Built-in delivery mechanism

- **TS string imports vs `src/subagents/profiles/<name>.md` files** — bundling `.md` as imports requires a build step or Vite-style import. TS modules with template-literal bodies work everywhere with no build magic. **Recommend** TS modules to keep src/ runtime-neutral and avoid build-tool divergence; the marginal authoring-pain (no syntax highlighting on the body) is minor. Validate the chosen path doesn't break any of the four reference Hosts.

### Extension API shape

- **`registerSubagentProfile(def: ExtensionSubagentProfileDef): () => void`** — what's the shape of `def`? Mirror `SubagentFrontmatter` minus `name` (passed separately)? Or take the full `SubagentProfile` shape directly (no parser between extension code and runtime)? **Recommend** the SubagentFrontmatter-like shape so extensions can't bypass validation that markdown goes through (name regex, body trimming, maxTurns default).
- **Where does the registered profile live?** `runner.getSubagentProfiles()` mirrors the existing `runner.getTools()`/`runner.getCommands()` pattern. Bootstrap calls this and merges into the final list. Verify there's no hot-reload story for extensions (there isn't for tools/commands either — captured at runner build).

### Merge logic + name collision

- **`mergeSubagentProfiles(builtins, extensionProfiles, projectProfiles)`** — output: deduped by name, precedence project > extension > built-in. Disabled markdown entries drop the corresponding built-in or extension entry from output. **Recommend** sharing the `byName` sort with markdown discovery so order is deterministic regardless of source.
- **What if an extension registers a `disabled: true` profile?** Probably an error at registration. Confirm with the user.
- **What if a built-in is `disabled: true` in its own definition?** Probably a bug we should fail loud on. The `disabled` field is meaningful only on overriding entries.

### Frontmatter schema additions

- **New `disabled?: boolean` field** on `SubagentFrontmatter`. Loader drops profiles where `disabled === true` AFTER the precedence merge (so a project `disabled: true` markdown entry overrides + hides the built-in). Decide whether the loader drops at parse time OR the merger drops post-merge. The latter is more flexible (extension authors can ship a "stub disabled" profile that users can re-enable by re-defining without `disabled`).
- **Optional `source: "project" | "extension" | "builtin"`** on `SubagentProfileSummary` so `_bodhi-pi/subagent/list` surfaces lineage. Useful for the host UI to render "(built-in)" badges. **Recommend** adding it now — small wire change, easy to leave out in the e2e if not asserted.

### Built-in profile bodies

- The two profile bodies are short markdown blocks. Pre-research what cc/Mastra/pi-subagents ship for `explore` and `planner`/`plan` — don't copy verbatim (different tool surface, different terse house style), but borrow structure. **Iterate** the body via the e2e: assert the explore agent reads a file and finds something specific; assert the planner agent produces a numbered plan with N steps. The e2e is the contract.
- `explore` constraint: `tools: [read, ls, find, grep]`. No `write`/`edit`/`bash`/`run_script`. Strongly worded "do not modify state" in the prompt.
- `planner` constraint: `tools: [read, ls, find, grep]` (same as explore — planning is investigation + prose, never editing). Body says "produce a numbered implementation plan; do NOT edit files".

### Carry-forward implementation details

- **Cancellation test pattern**: pi-ai's faux provider supports response functions; one option is `async (ctx) => { await new Promise(r => setTimeout(r, 1000)); return fauxAssistantMessage("ok"); }` to simulate a slow turn. The parent fires `client.cancel({sessionId})` mid-flight via `setTimeout` from the test. Verify this pattern works against pi-agent-core's abort propagation.
- **`SessionState.subagentDepth` caching**: top-level sessions populate via `buildSessionState` (always 0). Child sessions populate via `buildChildSessionState` (depth arg already in the function signature). `SubagentService.spawn` then reads `parent.runtime.subagentDepth + 1` instead of walking session log. Mind the persisted-state migration — what happens for old sessions loaded from SessionStore that pre-date this field? Read from `subagent_link` entry as fallback once at hydration.
- **`evictChild` lifecycle move**: today it runs in `SubagentService.spawn`'s finally block (always). Move it to the success / failure / cancellation branches explicitly. Foreground = evict; background (future) = don't evict. The C2 spawn flow is sync (always foreground), so behavior is preserved. The change is purely structural — a comment block describing the post-P3a semantics earns its keep.

### Test apps + Playwright

- **e2e-ui test for built-in profile (no seed needed)**. Drop the agents fixture from the test setup; assert `/agents` lists `explore` and `planner` from the built-ins. Then `/subagent explore <task>` runs and returns a sensible result. This is a new shared spec (e.g., `subagents-builtin.spec.ts`) that runs across all 4 Playwright projects.
- **Existing `subagents.spec.ts` should still pass** — it seeds an `extractor.md` profile that overrides nothing. Verify the merge logic doesn't break it.
- **Cli e2e** — add a focused test that asserts `_bodhi-pi/subagent/list` returns built-in profiles without any agents/ directory present.

## Process — iterative TDD across the matrix

Per `feedback_e2e_coverage_keeps_feature` and the `packages/bodhi-pi/CLAUDE.md` 6-step workflow: a variant is "done" only when it has at least one of `{e2e, cli-headless, Playwright}` per supported runtime. Integration-only is not enough.

Recommended cadence (depth-first per runtime per memory `phasing: depth-first per runtime`):

1. **Integration first**. `packages/bodhi-pi/test/` — write a failing `subagents-builtin.test.ts` that constructs a harness with no agents/ fixture, expects `subagent` tool registered with `explore` profile available. Implement built-in delivery to make it pass.
2. **Extension-registered tests**. Faux extension factory registers a `dummy` profile; assert it appears in `/list` after project markdown but before built-ins (per locked precedence). Test override scenarios for all 4 combinations (project only, extension only, built-in only, all-three-with-disabled).
3. **Carry-forward tests in parallel** — they don't depend on the bundling work. Land them as separate commits to stay bisectable.
4. **e2e direct-ACP** (in-memory + cli + http + ws). `subagents-builtin.e2e.ts` asserts the built-in `explore` returns a real read summary on gpt-4o-mini. Should pass everywhere without any agents/ seed.
5. **e2e-ui Playwright** across all 4 projects. `subagents-builtin.spec.ts` mirrors the v1 spec but without the `seedXml` payload for the profile.

Each commit ends green on `npm run check` + the relevant test slices. Each Host runtime gets its own validation gate before moving on.

## Gate-check + commit cadence

Suggested commit shape (NOT prescriptive — slice however makes commits bisectable):

- C1: built-in delivery mechanism + `explore` + `planner` profiles + frontmatter `disabled?` field + merge logic + integration tests + spec updates (`subagents.md`, `extensions-skills-commands.md`).
- C2: `ExtensionAPI.registerSubagentProfile` + ExtensionRunner aggregation + merge into bootstrap + integration tests + spec updates.
- C3: cancellation test + `subagentDepth` caching + `evictChild` lifecycle restructure.
- C4: e2e + e2e-ui across all 4 runtimes (built-in profile scenario).
- C5: retrospective + roadmap refinement (`retrospective.md` for v2, update `roadmap.md`).

Each runtime gated through CLAUDE.md 6-step. After all commits land green, write `ai-docs/sub-agents/v2-retrospective.md` capturing surprises + carry-forward.

## Plan structure (mandatory sections)

When you write the plan after grilling the user, include:

1. **Goal restatement** — quote the two contribution sources + carry-forward triplet.
2. **Locked-scope summary** — table: decision → user-locked answer → file:line where it lands.
3. **Open-question resolutions** — table: question → recommended answer → user-answer (filled during planning session).
4. **File-level inventory** — new files, touched files, spec docs amended. Per file: one-line purpose.
5. **Per-commit slice** — propose commits + the validation gate per commit (npm run check + which test files + which e2e/e2e-ui specs).
6. **Verification matrix** — per runtime: which npm/vitest/playwright command to run after each commit lands. Include both unit and e2e suites.
7. **Risk register** — bundling mechanism cross-runtime gotchas (Vite vs cli vs Node http vs MV3 chrome-ext bundling differences), name-collision edge cases (case sensitivity? trailing whitespace?), child-session eviction regression for foreground (the move must preserve current behavior).
8. **Out of scope** — explicitly: forked context (P2a), parallel batch (P2b), background runs (P3a), MCP/extension/skill inheritance for child (P3c/P3d), worktree (P4a), ChatPanelPage helpers + scriptSubagentRun helper (deferred to a future cleanup).

## Anti-patterns to avoid

- Don't reimplement v1 surfaces — extend `loadProjectSubagents`, `SubagentService`, `buildChildSessionState` rather than fork them.
- Don't add `node:*` imports to `src/subagents/profiles/` — runtime-neutrality rule from `packages/bodhi-pi/CLAUDE.md`.
- Don't expand the open-question list beyond what's actionable for v2 — defer real design calls (forked context, parallel) to their own kickoffs.
- Don't fold the ChatPanelPage Playwright helpers into this phase — user explicitly chose "fold small items in" referring to the retrospective triplet, not the helper-creation work.
- Don't ship a `subagents.disableBuiltins` setting — user chose the override-only approach.
- Don't propose the built-in delivery mechanism as a Vite import-glob — must work in cli and Node http server too.

## References

- v1 commits: `f7d7d421` (C1), `532ee5fc` (C2), `c8e06bf1` (C3), `62486bfa` (retrospective+roadmap).
- v1 plan: `ai-docs/plans/sounds-good-current-in-moonlit-flame.md`.
- v1 design + retrospective + roadmap + pending: under `ai-docs/sub-agents/`.
- Upstream research: `ai-docs/research/sub-agents/` (especially the Manus report + `cc`/`Mastra`/`pi-subagents` profile bodies).
- Spec to amend: `ai-docs/specs/bodhi-pi/subagents.md`, `ai-docs/specs/bodhi-pi/extensions-skills-commands.md`, `ai-docs/specs/bodhi-pi/acp.md` (the list response gets a `source` field if you ship it).
- Extension API shape reference: `src/extensions/types.ts:81-97` + `src/extensions/runner.ts` (aggregation point).
- Merge pattern reference: `src/extensions/merge.ts` (commands + tools merge — sibling pattern).

## When done

Print: the plan path, the count of open questions resolved during the session, and the proposed commit subjects in order. Do not start executing the plan in this round — the plan IS the deliverable. Implementation runs in a separate session, ideally guided by `superpowers:executing-plans`.
