# Skills (+ optional script execution) — milestone plan

## Context

`bodhi-pi` now has the foundations Phase 7 needs: a host-injected `Filesystem`, a `systemPrompt` config field, and a slash-command resolver with FS-driven discovery. The natural next slice is **skills** — folder-per-skill markdown bundles that the model can advertise unsolicited (system prompt) or be invoked explicitly (`/skill:name`).

Coding-agent skills are markdown-only (`packages/coding-agent/src/core/skills.ts:75-82`); sibling scripts have no special handling — the model is told "use `./script.js arg`" via the SKILL.md body and is expected to call `bash`. We don't have `bash` (Node-only) and want cross-runtime support, so script execution is a separate concern with its own host-injected interface.

This plan splits the work into **two commits** that land back-to-back:

- **M-A: Skills (markdown-only).** Discovery, frontmatter, `<available_skills>` system-prompt augmentation, `/skill:name` invocation, ACP advertising. No execution. Sibling files (scripts, references, assets) are loadable by the existing `read` tool.
- **M-B: `ScriptExecutor` + `run_script` tool.** Cross-runtime JS execution as a host-injected interface (no default helper — `vm.runInNewContext` isn't browser-portable). Tool registered only when injected. Test harness uses an unsandboxed `new Function`-based executor (fine — scripts come from project disk, same trust level as FS).

The combined slice gives us an end-to-end scripted skill (`days-since-birthday`) we can verify with a real LLM.

---

## Confirmed scope

| Decision | Choice |
|---|---|
| Skill layout | `<cwd>/.bodhi-pi/skills/<name>/SKILL.md` only — folder-per-skill. Drop coding-agent's "loose `<name>.md` in dir" mode. |
| Discovery scope | Project-only (mirrors slash commands); no global path. |
| Recursion | Single-level: list direct subdirs of `.bodhi-pi/skills/`, look for `SKILL.md` in each. No deeper walk; no `.gitignore` parsing. |
| Frontmatter | `name?`, `description` (required), `disable-model-invocation?`, `allowed-tools?` (parsed, NOT enforced — matches coding-agent v1). |
| System prompt | Auto-append `<available_skills>` XML block to `config.systemPrompt` at session hydration. Skills with `disable-model-invocation: true` excluded from the block. |
| ACP advertising | Every skill (including hidden) advertised as `skill:<name>` in the existing `available_commands_update` notification, alongside slash commands. |
| Invocation | `/skill:<name> args` — joined-text prefix detection. Body wrapped in `<skill name="..." location="...">…</skill>`; args appended as separate paragraph (NOT `$1`-substituted). Unknown name → pass through verbatim. |
| `ScriptExecutor` | Host-injected, no default helper, no fallback. Optional in `BodhiPiConfig`. Test harness ships a non-sandboxed reference executor under `test/helpers/`. |
| `run_script` tool | Registered only when `BodhiPiConfig.scriptExecutor` is provided (capability-conditional). TypeBox schema `{ path: string, args?: string[], timeout?: number }`. Path resolved against session cwd (same as `read`/`write`). ACP `tool_call.kind: "execute"`. |
| Public API additions | `ScriptExecutor` type + `BodhiPiConfig.scriptExecutor?` optional field. No reference helper exported. |

---

# Milestone A — Skills (markdown-only)

## Files to create

### `packages/bodhi-pi/src/_internal/frontmatter.ts` (~40 lines)

Extract the YAML frontmatter parser currently inlined in `src/commands/discovery.ts` so both commands and skills share it.

Exports:
- `function parseFrontmatter<T>(raw: string): { frontmatter: T; body: string }` — generic; if no `---\n…\n---\n` block, returns `{ frontmatter: {} as T, body: raw }`. Throws on malformed YAML so callers can decide to skip the file.

### `packages/bodhi-pi/src/skills/skill.ts` (~30 lines)

Type definitions only.

Exports:
- `interface Skill { name: string; description: string; disableModelInvocation: boolean; allowedTools?: string[]; baseDir: string; filePath: string; body: string }`
- `interface SkillFrontmatter { name?: string; description?: string; "disable-model-invocation"?: boolean; "allowed-tools"?: string[]; }`

### `packages/bodhi-pi/src/skills/discovery.ts` (~110 lines)

Discovery via injected `Filesystem`. Mirrors `src/commands/discovery.ts`'s structure.

Exports:
- `const SKILLS_SUBDIR = ".bodhi-pi/skills"`.
- `async function loadProjectSkills(fs: Filesystem, cwd: string): Promise<Skill[]>`:
  1. `dir = path.join(cwd, SKILLS_SUBDIR)`. Empty list if `!await fs.exists(dir)` or `list` throws.
  2. For each entry where `isDirectory`: check `<dir>/<entry.name>/SKILL.md` exists; read; parse frontmatter; build `Skill`.
  3. Validation: `description` is required (skip with no error if missing — matches coding-agent's behavior of skipping invalid skills); `name` from frontmatter or fallback to folder name.
  4. Sort by `name` ascending.
- Internal `loadSkill(filePath, baseDir, raw): Skill | null` — uses `parseFrontmatter<SkillFrontmatter>`. Returns null on missing description or parse error.

### `packages/bodhi-pi/src/skills/system-prompt.ts` (~50 lines)

Build the `<available_skills>` block. Pure function, no I/O.

Exports:
- `function formatSkillsForPrompt(skills: Skill[]): string` — returns `<available_skills>\n  <skill>...</skill>\n</available_skills>` with `name`, `description`, `location` per skill. Excludes skills where `disableModelInvocation === true`. Returns `""` if no eligible skills.
- `function composeSystemPrompt(base: string | undefined, skills: Skill[]): string | undefined` — `base` from `config.systemPrompt`. If `formatSkillsForPrompt(skills) === ""`, return `base` unchanged. Else return `base ? `${base}\n\n${block}` : block`. (Returning `undefined` when base is undefined and no skills means pi-agent-core's default applies.)

### `packages/bodhi-pi/src/skills/invocation.ts` (~40 lines)

Pure function for `/skill:` expansion.

Exports:
- `function expandSkillCommand(text: string, skills: Skill[]): string` — if `text` doesn't start with `/skill:`, return unchanged. Parse name (between `/skill:` and first space) + args (rest, trimmed). If skill not found → return text unchanged (pass-through). Else return `<skill name="${name}" location="${filePath}">\nReferences are relative to ${baseDir}.\n\n${body}\n</skill>` followed by `\n\n${args}` if args non-empty.

### Co-located unit tests (~250 lines total)

- `src/_internal/frontmatter.test.ts` — generic parsing: no frontmatter, empty frontmatter, well-formed, malformed (throws), CRLF.
- `src/skills/discovery.test.ts` — missing dir, empty dir, single skill folder, multiple sorted, missing-description skipped, malformed-YAML skipped, non-directory entries ignored, folder without SKILL.md ignored.
- `src/skills/system-prompt.test.ts` — empty list returns "", excludes hidden, returns full XML; `composeSystemPrompt` with/without base, skills/no-skills matrix.
- `src/skills/invocation.test.ts` — no `/skill:` prefix → unchanged; unknown skill → unchanged; known skill no args; known skill with args; known skill with multi-word args.

### `packages/bodhi-pi/test/skills.test.ts` (~250 lines)

Integration via `createTestHarness` + faux provider (mirrors `test/commands.test.ts` pattern). Capture user prompts that reach the LLM, plus emitted notifications.

Cases:
- `session/new` with no skills dir → `available_commands_update` has only previously-existing entries (no skill: entries).
- `session/new` with two visible skills → notification includes `{name: "skill:alpha", description: "..."}` and `{name: "skill:zeta", ...}`. System prompt sent to LLM contains `<available_skills>` block with both.
- Hidden skill (`disable-model-invocation: true`) → present in `available_commands_update` but **not** in the system prompt block.
- `session/load` re-emits the notification AND re-applies the augmented system prompt.
- `/skill:foo arg1 arg2` → faux captures expanded `<skill name="foo" location="...">BODY</skill>\n\narg1 arg2`.
- `/skill:unknown` → passes through verbatim.
- Skills + slash commands coexist: a session with one skill and one command file emits both as `AvailableCommand[]` in one notification.

### `packages/bodhi-pi/e2e/skills.e2e.ts` (~130 lines)

Real-LLM (gpt-4o-mini) verification:

- Pre-write `/proj/.bodhi-pi/skills/say-hello/SKILL.md`:
  ```
  ---
  description: Say hello to a person
  ---
  When the user asks you to greet someone, reply with exactly the words: hello, <name>
  Where <name> is the value the user provides after /skill:say-hello.
  ```
- Invoke `/skill:say-hello world` → assert `chunkedAgentText(...).toLowerCase()` contains `"hello, world"`.
- Optional second case: hidden skill with `disable-model-invocation: true` is invokable when the user types it explicitly (proves the ACP path works even though system prompt didn't mention it).

## Files to modify

### `packages/bodhi-pi/src/commands/discovery.ts`
Replace inline `parseFrontmatter` with the new shared helper. Keep `Frontmatter` interface local (typed pass-through to `parseFrontmatter<Frontmatter>`).

### `packages/bodhi-pi/src/acp/agent.ts`

| Anchor | Change |
|---|---|
| Imports | Add `loadProjectSkills`, `composeSystemPrompt`, `formatSkillsForPrompt` from `../skills/...`; `expandSkillCommand` likewise; `Skill` type. |
| `SessionState` | Add `skills: Skill[]`. |
| `newSession` | After cache set, in `discoverAndAdvertiseCommands`: also `await loadProjectSkills(...)`, store on session, include `skill:<name>` entries in `availableCommands`. The pi-agent-core `Agent` instance gets the augmented systemPrompt — see initial-state change below. |
| Initial-state systemPrompt | At every place we currently spread `config.systemPrompt !== undefined ? { systemPrompt: config.systemPrompt }` (in `newSession` and `rehydrateSession`), change to spread `composeSystemPrompt(config.systemPrompt, skills)` — with the same `!== undefined` guard. **Caveat:** discovery is async, but Agent construction is sync inside `newSession`. Either: (a) discover skills BEFORE constructing Agent, OR (b) reset `agent.state.systemPrompt` after discovery. (a) is cleaner — re-order so skills load first, then Agent is built with the composed prompt. Same restructuring in `rehydrateSession`. |
| `prompt` | After `text` joined and before `expandPromptTemplate`, run `text = expandSkillCommand(text, session.skills)`. Skills are tried first; if no `/skill:` match, the text falls through to slash-command expansion. (Order matters because both detect leading `/`.) |
| `discoverAndAdvertiseCommands` | Rename to `discoverAndAdvertiseSlashable` or split into two helpers. Now loads commands AND skills, advertises both in one notification. |

### `packages/bodhi-pi/src/index.ts`
Add `export type { Skill }` for hosts that want to introspect (optional — defer if not strictly needed; coding-agent doesn't expose Skill externally).

---

# Milestone B — ScriptExecutor + run_script tool

## Files to create

### `packages/bodhi-pi/src/script-executor/script-executor.ts` (~30 lines)

Interface only — no implementation.

Exports:
- `interface ScriptExecuteResult { stdout: string; stderr: string; exitCode: number }`
- `interface ScriptExecuteParams { scriptPath: string; cwd: string; args: string[]; timeout?: number }`
- `interface ScriptExecutor { execute(params: ScriptExecuteParams): Promise<ScriptExecuteResult> }`

### `packages/bodhi-pi/src/tools/run-script.ts` (~70 lines)

New built-in tool. Mirrors `src/tools/{read,write,edit,...}.ts`.

Exports:
- `function createRunScriptTool({ executor, cwd }: { executor: ScriptExecutor; cwd: string }): AgentTool` — TypeBox schema `Type.Object({ path: Type.String(), args: Type.Optional(Type.Array(Type.String())), timeout: Type.Optional(Type.Number()) })`. Implementation: resolve `params.path` against `cwd` via `resolvePath` (already in `tools/index.ts`); call `executor.execute({ scriptPath, cwd, args: params.args ?? [], timeout: params.timeout })`; return result formatted as text (stdout + stderr + exit code summary, truncated via `accumulateBounded`).

### `packages/bodhi-pi/test/helpers/script-executor.ts` (~40 lines)

Reference test executor — non-sandboxed, reads code via the test `Filesystem`, runs via `new Function`.

Exports:
- `function createTestScriptExecutor(fs: Filesystem): ScriptExecutor` — `execute({ scriptPath, args })`: `code = await fs.readTextFile(scriptPath); stdout = []; new Function("args", "console", code)(args, { log: (...xs) => stdout.push(xs.map(String).join(" ")) }); return { stdout: stdout.join("\n"), stderr: "", exitCode: 0 };`. Catches errors → returns `{ stdout: "", stderr: String(err), exitCode: 1 }`.

### Co-located unit tests (~120 lines)

- `src/tools/run-script.test.ts` — uses `createInMemoryFilesystem` + `createTestScriptExecutor`. Cases: simple stdout capture, args delivery, error → exit 1, missing file → exit 1.

### `packages/bodhi-pi/test/run-script.test.ts` (~150 lines)

Integration — agent invokes `run_script` tool via faux provider scripted tool calls. Cases:
- Tool registered only when `scriptExecutor` injected (negative case: faux model tries `run_script`, model never sees it in tool list).
- Tool registered + script call → `tool_call`/`tool_call_update` notifications shape.
- Stdout flows back into the next LLM turn.

### `packages/bodhi-pi/e2e/scripted-skill.e2e.ts` (~120 lines)

Pre-write a `days-since-birthday` skill folder via in-memory `Filesystem`:

```
/proj/.bodhi-pi/skills/days-since-birthday/SKILL.md
---
description: Compute days since a given birthday (YYYY-MM-DD)
---
You have a script at ./script.js. To compute days, call the run_script tool with:
  path: "/proj/.bodhi-pi/skills/days-since-birthday/script.js"
  args: ["<YYYY-MM-DD>"]
The script writes the integer day count to stdout. Reply with exactly that number and nothing else.
```

```
/proj/.bodhi-pi/skills/days-since-birthday/script.js
const ms = Date.UTC(2026, 4, 8) - new Date(args[0] + "T00:00:00Z").getTime();
console.log(Math.floor(ms / 86400000));
```

(The `2026, 4, 8` baseline is hardcoded in the script so the test is deterministic across runs — `Date.UTC` uses 0-indexed months, so `4` is May.)

E2E case: `/skill:days-since-birthday 2000-01-01` → assert response contains `"9624"` (or whatever the script returns for that date) AND `harness.updates` contains a `tool_call` with `kind: "execute"` and `toolCallId` for `run_script`.

Run with gpt-4o-mini (single tool-using turn — works fine with non-reasoning model per the M-A milestone learning).

## Files to modify

### `packages/bodhi-pi/src/index.ts`
Export `type { ScriptExecutor, ScriptExecuteParams, ScriptExecuteResult }`. (No `createDefaultScriptExecutor` — host-only.)

### `packages/bodhi-pi/src/acp/agent.ts`

| Anchor | Change |
|---|---|
| `BodhiPiConfig` | Add `scriptExecutor?: ScriptExecutor`. Mark optional in JSDoc; tool only registered when present. |
| `createBuiltinTools` callsite (in `newSession` and `rehydrateSession`) | Pass `scriptExecutor` through. |

### `packages/bodhi-pi/src/tools/index.ts`

| Anchor | Change |
|---|---|
| `createBuiltinTools` signature | Add `scriptExecutor?: ScriptExecutor`. |
| Body | If `scriptExecutor` provided, append `createRunScriptTool({ executor: scriptExecutor, cwd })` to the tool array. |
| `toolKindFor` | Add case `"run_script" → "execute"`. |

### `packages/bodhi-pi/src/tools/limits.ts`
Add `RUN_SCRIPT_MAX_BYTES` (e.g. 50_000) for stdout truncation.

### `packages/bodhi-pi/test/helpers/harness.ts`

Add optional `scriptExecutor?: ScriptExecutor` to `TestHarnessOptions`. Forward to `createBodhiPiAgent`. Don't default — leave undefined unless passed (preserves negative-case test where tool is unavailable).

---

## Type design (combined)

- `Skill` — internal cache shape; `SessionState.skills: Skill[]` populated at hydration.
- `ScriptExecutor` — public host interface, optional in `BodhiPiConfig`.
- ACP wire: `AvailableCommand` for skills uses `name: "skill:<name>"`, `description: <skill description>`. No `input.hint` (skills don't have one).
- `tool_call.kind: "execute"` for `run_script` — per ACP enum.

---

## Edge cases

| Case | Behavior |
|---|---|
| Skill folder exists but no SKILL.md | Ignored. |
| SKILL.md without `description` | Skipped silently (matches coding-agent — "warning diagnostic" we just drop for v1). |
| SKILL.md with malformed YAML | Skipped silently. |
| Skill name collision with slash-command name | Both advertised; `/foo` invokes the command, `/skill:foo` invokes the skill. Different prefixes → no actual collision. |
| `/skill:unknown` | Pass through verbatim to LLM. |
| `disable-model-invocation: true` skill | Excluded from system prompt; included in `available_commands_update`; invokable via `/skill:`. |
| Script execution requested but no `ScriptExecutor` injected | `run_script` tool not registered → model never sees it → can't invoke. Skill body that mentions it would be unusable in such a host. |
| Script throws | Test executor returns `exitCode: 1` + error in stderr. Tool returns the result; model decides what to do. |
| Path resolution in `run_script` | Resolved against session cwd via `resolvePath` — same rule as `read`/`write`. Model is responsible for absolute-or-cwd-relative paths. |
| Script tries to access `Filesystem`/agent internals | The test executor doesn't expose them. Real Node hosts that use `vm` or subprocess get the same isolation. Documented in `ScriptExecutor` JSDoc: "Implementations SHOULD NOT expose host capabilities to the script." |

---

## Test plan

| Layer | M-A files | M-B files |
|---|---|---|
| Unit | `src/_internal/frontmatter.test.ts`, `src/skills/{discovery,system-prompt,invocation}.test.ts` | `src/tools/run-script.test.ts` |
| Integration | `test/skills.test.ts` | `test/run-script.test.ts` |
| e2e | `e2e/skills.e2e.ts` (gpt-4o-mini, simple greeting skill) | `e2e/scripted-skill.e2e.ts` (gpt-4o-mini, days-since-birthday) |

Run:
```bash
npm --workspace @bodhiapp/bodhi-pi run test       # unit + integration
npm --workspace @bodhiapp/bodhi-pi run test:e2e   # real LLM (needs OPENAI_API_KEY)
```

Gate-checks per commit:
```bash
npm run check
npm --workspace @bodhiapp/bodhi-pi run build
npm --workspace @bodhiapp/bodhi-pi run test
```

---

## Sequencing (two commits, both on `main`)

### Commit 1 — `feat(bodhi-pi): land skills (markdown-only)`

1. Extract `parseFrontmatter` to `src/_internal/frontmatter.ts`; refactor `commands/discovery.ts` to use it; verify command tests still green.
2. Create `src/skills/{skill,discovery,system-prompt,invocation}.ts` + co-located unit tests; verify green.
3. Modify `src/acp/agent.ts`: extend `SessionState`, re-order to load skills before Agent construction so the augmented systemPrompt threads through, expand skills in `prompt()`, advertise alongside slash commands.
4. Add `test/skills.test.ts` integration tests; verify green.
5. Add `e2e/skills.e2e.ts`; run `npm run test:e2e`; verify green.
6. Update `packages/bodhi-pi/CHANGELOG.md` Unreleased section.
7. `npm run check` + commit.

### Commit 2 — `feat(bodhi-pi): land ScriptExecutor + run_script tool`

1. Create `src/script-executor/script-executor.ts` (interface only).
2. Create `src/tools/run-script.ts` + co-located unit tests (uses test helper executor); verify green.
3. Modify `src/tools/index.ts` (capability-conditional registration, `toolKindFor`); `src/tools/limits.ts` (`RUN_SCRIPT_MAX_BYTES`).
4. Modify `src/acp/agent.ts`: thread `scriptExecutor` from config through `createBuiltinTools` callsites.
5. Modify `src/index.ts`: export `ScriptExecutor` types.
6. Modify `test/helpers/harness.ts`: optional `scriptExecutor` opt-in; create `test/helpers/script-executor.ts` with `createTestScriptExecutor`.
7. Add `test/run-script.test.ts` integration; verify green.
8. Add `e2e/scripted-skill.e2e.ts` (days-since-birthday); run `npm run test:e2e`; verify green.
9. Update CHANGELOG.
10. `npm run check` + commit.

---

## Critical files

**To modify (both commits):**
- `packages/bodhi-pi/src/acp/agent.ts` — primary integration point for both milestones
- `packages/bodhi-pi/src/index.ts` — `Skill` (M-A optional), `ScriptExecutor` (M-B)
- `packages/bodhi-pi/src/commands/discovery.ts` — refactor to use shared frontmatter helper (M-A)
- `packages/bodhi-pi/src/tools/{index.ts,limits.ts}` — capability-conditional `run_script` (M-B)
- `packages/bodhi-pi/test/helpers/harness.ts` — optional scriptExecutor (M-B)
- `packages/bodhi-pi/CHANGELOG.md` — both commits

**To create (M-A):**
- `packages/bodhi-pi/src/_internal/frontmatter.ts` (+ `.test.ts`)
- `packages/bodhi-pi/src/skills/skill.ts`
- `packages/bodhi-pi/src/skills/discovery.ts` (+ `.test.ts`)
- `packages/bodhi-pi/src/skills/system-prompt.ts` (+ `.test.ts`)
- `packages/bodhi-pi/src/skills/invocation.ts` (+ `.test.ts`)
- `packages/bodhi-pi/test/skills.test.ts`
- `packages/bodhi-pi/e2e/skills.e2e.ts`

**To create (M-B):**
- `packages/bodhi-pi/src/script-executor/script-executor.ts`
- `packages/bodhi-pi/src/tools/run-script.ts` (+ `.test.ts`)
- `packages/bodhi-pi/test/helpers/script-executor.ts`
- `packages/bodhi-pi/test/run-script.test.ts`
- `packages/bodhi-pi/e2e/scripted-skill.e2e.ts`

**Reference (read-only, copy logic from):**
- `packages/coding-agent/src/core/skills.ts:75-82, 165-171, 228-276, 340-366, 405-504` (Skill interface, discovery rules, formatSkillsForPrompt)
- `packages/coding-agent/src/core/agent-session.ts:1147-1171` (`_expandSkillCommand`)
- `packages/coding-agent/docs/skills.md` (skill author contract, XML format)
- `packages/coding-agent/src/core/tools/bash.ts` (BashOperations pluggable pattern → mirror for ScriptExecutor)
- `/tmp/acp-sdk-inspect/package/dist/schema/types.gen.d.ts` (ACP `tool_call.kind` enum, `AvailableCommand` shape — already established in slash-commands milestone)

**Existing helpers to reuse:**
- `parseFrontmatter` (post-extraction) — `src/_internal/frontmatter.ts`
- `Filesystem.exists/list/readTextFile` — `src/filesystem/filesystem.ts:12-33`
- `resolvePath` + `toolKindFor` — `src/tools/index.ts`
- `accumulateBounded`, `truncationFooter` — `src/tools/_accumulate.ts`
- `createTestHarness` — `test/helpers/harness.ts`
- `expandPromptTemplate` (slash commands) — composition pattern for the `/skill:` extension

---

## Risks / open questions

1. **Re-ordering `newSession` to load skills before Agent construction** — currently the Agent is constructed sync; we need an `await loadProjectSkills(...)` before `new Agent(...)`. Easy refactor but worth testing the sequence: (a) `sessionStore.create`, (b) load skills, (c) construct Agent with composed systemPrompt, (d) cache session, (e) emit `available_commands_update`. Same pattern in `rehydrateSession`.
2. **`<available_skills>` block recomputation on `setSessionConfigOption(model)`** — model swaps mutate `state.model` but NOT `state.systemPrompt`. Skills are static per session, so the system prompt is stable across model swaps — no action needed.
3. **Skill body containing `</skill>`** — would break the XML wrapper. Coding-agent doesn't escape; we won't either. Documented as an author footgun.
4. **Reasoning models + `run_script` tool use** — same multi-turn `rs_*` 404 issue as before. e2e for scripted-skill uses gpt-4o-mini; non-issue.
5. **`allowed-tools` field is parsed but ignored** — same as coding-agent v1. Permissions milestone will be the natural place to enforce it.
6. **No live reload for skills** — skills cached at session hydration, like commands. `session/close` + `session/load` to refresh. Documented; can revisit when a use case demands it.
7. **Test executor uses `new Function` (no sandbox)** — explicit choice per user direction. Non-sandboxed execution is acceptable since scripts come from project disk (same trust as `Filesystem` access). Real-host implementations choose their own isolation strategy.
