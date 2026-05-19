# Milestone 020 — Profile sources + precedence (V2)

> **Status:** ☑ shipped (V2 phase, 2026-05-18 — eight commits: `9b67f7b4` → `2756e5eb`).
> **Prerequisite reading:** [`005-architecture-decisions.md`](005-architecture-decisions.md), `../v2-retrospective.md`.

## Goal

Extend the profile system from "project markdown only" (milestone 010) to a layered set of three sources — project markdown, extension-registered, bundled built-in — with a deterministic merge order and a way to disable lower-precedence profiles. Ship two bundled built-ins (`explore`, `planner`) so every project gets useful sub-agents out of the box.

Functionally this milestone makes the sub-agent feature **usable without authoring any markdown**, and gives extension authors a first-class way to register profiles alongside their tools / slash commands / skills.

## Functional scope

### IN

- **Bundled built-in profiles** — `explore` (read-only investigator, tools restricted to `read`/`ls`/`find`/`grep`) and `planner`. Both default to `context: "fresh"`. Both ship in `src/subagents/profiles/` as TypeScript modules with template-literal bodies.
- **`ExtensionAPI.registerSubagentProfile(def)`** — extensions can register profiles at registration time. Returns an unregister function. The shape of `def` mirrors the discovery-time `SubagentProfile` minus `filePath` and `source` (which are synthesised by the runner).
- **`source` field on every profile** — `"project" | "extension" | "builtin"`. Visible in `_bodhi-pi/subagent/list` results so hosts/clients can render the source per-profile.
- **`disabled` flag** — frontmatter or extension definition may set `disabled: true`. A disabled higher-precedence entry causes the merger to fall through to lower precedence rather than dropping the name entirely.
- **Three-way merge** — `mergeSubagentProfiles(projectProfiles, extensionProfiles, builtinProfiles)` resolves name collisions by **project wins > extension wins > builtin wins**. The merger lives in `src/subagents/` (recommendation: keep it pure and runtime-neutral).
- **C0 schema-bug fix** — the `context` parameter on the LLM `subagent` tool (left over from V1's optimistic per-call-override exploration) was removed in V2 because it became an attractor. Per Decision 2, `context` is profile-bound. Documented here because it landed in the V2 wave.
- **V1 carry-forwards** that piggy-backed on the V2 commits: a cancellation regression test, a depth-cache test, per-status lifecycle-eviction logic (paving the way for milestone 050 background mode).

### OUT

- **User-level (global) markdown profiles** at `~/.bodhi-pi/agents/` — not implemented. Only project-scoped markdown is discovered.
- **Profile inheritance / extends** — a profile cannot reference another. Each profile is fully self-contained.
- **Per-extension MCP/skill inheritance** for child sessions — out by Decision 6, tracked in milestone 070.

## Critical interfaces

### Bundled built-in shape
Each built-in is a `SubagentProfile` constant with `source: "builtin"` and a synthetic `filePath` like `"builtin:explore"`. Bodies are written as template-literal strings so they can be diffed and version-controlled. Recommendation: keep them runtime-neutral (no `node:*` imports), and keep their behaviour conservative (e.g. `explore` restricts `tools` to a read-only set so it cannot mutate state even if the parent's profile allows more).

### `ExtensionAPI.registerSubagentProfile`
Signature recommendation:
```
registerSubagentProfile(def: ExtensionSubagentProfileDef): () => void
```
The runner converts `def` into a `SubagentProfile` with `source: "extension"` and a synthesised `filePath` like `"extension:<extension-name>:<profile-name>"`. The unregister function removes the profile (extensions that re-register must call unregister first).

### Merge function
Recommendation: a pure function `mergeSubagentProfiles(projects, extensions, builtins): SubagentProfile[]` that:
1. Indexes each input list by name.
2. Walks `projects` first — for each, if `disabled: true` skip (fall through), else include.
3. Walks `extensions` next — for each name not yet present in the merged set, apply the same disabled-fall-through rule.
4. Walks `builtins` last — same rule.
5. Returns a stable-ordered list (recommendation: sort by name to keep tool-schema enums deterministic for prompt-cache stability).

### Storage on `SessionState`
Merged profile list is held on `SessionState.subagentProfiles[]`, populated at bootstrap time. It does not change mid-session — re-loading requires a fresh session boot (or future hot-reload extension).

## Behaviour rules (invariants)

1. **Precedence is fixed:** project > extension > builtin. Not configurable.
2. **`disabled: true` falls through, never erases.** Disabling a project-level `explore` causes the builtin `explore` to surface; disabling the builtin `explore` removes it entirely from that session.
3. **Built-in profiles ship enabled by default.** A host that wants to suppress them must register a disabled project-level override.
4. **The `source` field is informational, not policy.** The tool-schema enum and the spawn behaviour are identical regardless of source.
5. **An extension cannot register a profile with `source: "project"` or `source: "builtin"`** — those are synthesised, not author-set.
6. **The bundled `explore` profile sets `tools: ["read", "ls", "find", "grep"]`** as a hard policy expression — its body also instructs the LLM to be read-only, but the tool restriction is the enforcement.
7. **Built-in bodies are stable strings** — they ship with the package, no runtime template substitution.

## Where this sits in the research spectrum

Milestone 020 implements the **multi-source registry** pattern from cc (`.claude/agents/`), MastraCode (typed specialist registry), and Goose (Rust config-bound agents). Bodhi-pi's twist is the three-way precedence with disabled-fall-through — a pattern that lets project authors override extension-provided defaults without touching extension code.

Relative to the spectrum:
- **Profile definition axis:** code-defined (built-ins) + markdown-defined (project) + runtime-discovered (extensions) — covers all three positions from the research, where most harnesses pick one or two.
- **Specialist persona axis:** the bundled `explore` + `planner` set bodhi-pi alongside Mastra (which ships explore / plan / execute) and OpenHands (which ships several role personas).

The choice not to ship global markdown profiles (`~/.bodhi-pi/agents/`) is a deliberate scope cut — extensions cover that use case and have a richer authoring model.

## Tests / coverage

- Unit: `subagents-builtin.test.ts` (built-ins surface in `list`), `subagents-extension-profile.test.ts` (registration + unregister), discovery tests extended.
- e2e: `subagents-builtin.e2e.ts` — verifies a built-in profile actually runs and returns a sensible result via gpt-4o-mini.
- e2e-ui (Playwright): `subagents-builtin.spec.ts` — verifies built-ins appear in `/agents` output in the browser/chrome-ext/http hosts.

## Per-runtime impact

| Runtime | What changed |
|---|---|
| **cli** | `/agents` now always lists at least `explore` and `planner` even with no project profiles. |
| **http** | Same. Per-turn-rebuild re-loads built-ins on each request, but list contents are identical. |
| **browser** | Built-ins available without any ZenFS-backed `.bodhi-pi/agents/` directory. |
| **chrome-ext** | Same as browser. |

All four runtimes share the bundled built-in source files — no per-runtime divergence in `src/subagents/profiles/`.

## Follow-ups / open knobs

- Forked context for built-ins → `planner` is a natural candidate to default to fork once milestone [030](030-forked-context.md) lands, but currently stays fresh. Profile authors override.
- Per-profile MCP/skill inheritance → milestone [070](070-mcp-and-skill-inheritance.md). Until then, even an extension-registered profile that conceptually needs an MCP tool cannot get one.
- Global (user-home) markdown profiles → not in any pending milestone. If demand surfaces, it slots in here as a "fourth source" with lowest precedence (below built-in? or between extension and built-in?) — that's a design choice deferred until then.
- Hot-reload of profiles mid-session → not in any pending milestone. Currently requires fresh session boot.
