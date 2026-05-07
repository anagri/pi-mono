# Slash commands / prompt templates — milestone plan

## Context

Now that `bodhi-pi` has a host-injected `Filesystem` (M3.1) and a `systemPrompt` config field (M3.2), the natural next slice is **filesystem-driven user configuration**. The lightest, most user-visible vertical slice in Phase 7 is **prompt-template slash commands**: a user invokes `/<name> args...` in `session/prompt`, the agent looks up a markdown file in the project, expands argument substitutions, and forwards the expanded body to the LLM.

This both lights up the FS for non-tool purposes and lands ACP's `available_commands_update` notification — a wire surface needed by every future config-loading feature (skills layer on top of the same resolver).

We mirror coding-agent's prompt-template feature (`packages/coding-agent/src/core/prompt-templates.ts`) — verbatim grammar, verbatim test cases — and wire it through ACP per `docs/protocol/slash-commands.mdx`.

### Confirmed scope

| Decision | Choice |
|---|---|
| Discovery scope | **Project-only**, fixed at `<cwd>/.bodhi-pi/commands/*.md`. No global path. No `BodhiPiConfig` knob. |
| Frontmatter parser | Add `yaml` (`^2.6.0`) as a runtime dep; mirrors coding-agent. |
| Unknown `/foo` | Pass through verbatim to the LLM (matches coding-agent). |
| Recursion | Non-recursive (matches coding-agent). |
| Live reload | None — discover once per session at hydration; cache in `SessionState`. |
| Empty list | Always emit `available_commands_update` (lets clients drop stale lists). |
| Multi-text-block prompt | Existing code already joins all text blocks into one string; expansion runs against the joined string. |
| Public API | No new exports — slash commands are an internal feature, surfaced over the ACP wire. |

---

## Design summary

1. **Discover** — at `newSession` / `loadSession` / `resumeSession`, walk `<cwd>/.bodhi-pi/commands/*.md` via the injected `Filesystem`. Parse YAML frontmatter (`description`, `argument-hint`) + body. Cache as `PromptTemplate[]` in the per-session `SessionState`.
2. **Advertise** — immediately after caching, emit a `session/update` notification with `sessionUpdate: "available_commands_update"`. Map each `PromptTemplate` to ACP's `AvailableCommand`.
3. **Expand** — inside `prompt()`, after the existing text-block-join, run `expandPromptTemplate(text, session.commands)`. The function returns the expanded body when the joined text starts with `/<known-name>`, otherwise the original string. Pass the result to `piAgent.prompt(...)`.

---

## Files to create

### `packages/bodhi-pi/src/commands/prompt-templates.ts` (~120 lines)

Pure string functions + the `PromptTemplate` type. Mirrors `coding-agent/src/core/prompt-templates.ts:24-102, 282-296` *verbatim* (drop the `sourceInfo` field — that's a coding-agent CLI concern).

Exports:
- `interface PromptTemplate { name: string; description: string; argumentHint?: string; content: string; filePath: string }`
- `function parseCommandArgs(argsString: string): string[]` — quote-aware tokenizer; copy of coding-agent lines 24-55.
- `function substituteArgs(content: string, args: string[]): string` — supports `$1`/`$2`/…, `$@`, `$ARGUMENTS`, `${@:N}`, `${@:N:L}`. Copy of lines 68-102.
- `function expandPromptTemplate(text: string, templates: PromptTemplate[]): string` — copy of lines 282-296. Returns expanded body on match; original `text` otherwise (no-slash *or* unknown name).

### `packages/bodhi-pi/src/commands/discovery.ts` (~110 lines)

I/O against the host-injected `Filesystem`. `Filesystem.exists()` already returns `false` on any error (`filesystem/filesystem.ts:26`); `Filesystem.list()` returns `DirEntry[]` with `{name, isFile, isDirectory}`.

Exports:
- `const COMMANDS_SUBDIR = ".bodhi-pi/commands"`.
- `async function loadProjectCommands(fs: Filesystem, cwd: string): Promise<PromptTemplate[]>`:
  1. `dir = path.join(cwd, COMMANDS_SUBDIR)`.
  2. `if (!await fs.exists(dir)) return []`.
  3. `entries = await fs.list(dir)` — try/catch → `[]` on error.
  4. For each `entry.isFile && entry.name.endsWith(".md")`: read text, call `loadTemplate`, push if non-null.
  5. Sort by `name` ascending for stable advertisement order.
- Internal `loadTemplate(filePath: string, raw: string): PromptTemplate | null` — replicates `coding-agent` lines 104-133 against in-memory text. Frontmatter-less files are valid: `description` falls back to first non-empty body line, truncated to 60 chars + `"…"` if longer. Malformed YAML → `null` (file silently skipped).
- Internal `parseFrontmatter(raw: string): { frontmatter: Record<string,string>; body: string }` — uses `yaml.parse`. Detects leading `---\n…\n---\n`; absent → `{ frontmatter: {}, body: raw }`.

### `packages/bodhi-pi/src/commands/prompt-templates.test.ts` (~250 lines)

Unit tests for the pure functions. Mirror cases from `coding-agent/test/prompt-templates.test.ts:22-354`:
- `parseCommandArgs`: empty / single / multiple / single-quoted / double-quoted / mixed quotes / tabs.
- `substituteArgs`: `$1`/`$2` positional; missing positional → empty; `$@`; `$ARGUMENTS`; `${@:N}`; `${@:N:L}`; `${@:0}` treated as 1; argument value containing `$1` is **not** re-substituted; mixed forms.
- `expandPromptTemplate`: no leading `/` → unchanged; unknown name → unchanged; known name no args; known name with args; known name with extra whitespace before/around args.

### `packages/bodhi-pi/src/commands/discovery.test.ts` (~150 lines)

Drives `loadProjectCommands` against `createInMemoryFilesystem()`:
- Missing dir → `[]`.
- Empty dir → `[]`.
- One full-frontmatter `.md` → 1 template, all fields populated.
- One frontmatter-less `.md` → description = first body line (truncated rule).
- One malformed-YAML `.md` → skipped, sibling valid files still loaded.
- Non-`.md` files ignored.
- Subdirs ignored (non-recursive).
- Sort order by name.

### `packages/bodhi-pi/test/commands.test.ts` (~250 lines)

Integration via `createTestHarness` + aimock:
- `session/new` with no commands dir → emits `available_commands_update` with `availableCommands: []`.
- `session/new` with two command files → emits notification, name-sorted, frontmatter mapped (`description`, `input.hint` from `argument-hint`).
- `session/load` re-emits the notification on rehydrate.
- `session/resume` re-emits the notification on rehydrate.
- `session/prompt` with `/foo arg1 arg2` → mock model receives the expanded body (assert via aimock recorded request).
- `session/prompt` with `/unknown arg` → mock model receives `"/unknown arg"` verbatim.
- `session/prompt` with plain text → unchanged.
- `session/prompt` with image-only blocks → unchanged (no text, nothing to expand).

### `packages/bodhi-pi/e2e/commands.e2e.ts` (~180 lines)

Real-LLM verification that the slash-command pipeline reaches the model with **expanded** text — mirrors the structure of `e2e/chat.e2e.ts` and `e2e/fs.e2e.ts`. Each test runs against both Anthropic Haiku and OpenAI gpt-5-mini for cross-model parity (matching existing chat e2e shape).

Test fixtures — pre-write into the in-memory `Filesystem` under `<cwd>/.bodhi-pi/commands/`:

```
say-tuesday.md
---
description: Say tuesday
---
Reply with exactly the single word "tuesday" and nothing else.
```

```
echo.md
---
description: Echo a word
argument-hint: <word>
---
Reply with exactly the single word: $1
And nothing else.
```

```
write-file.md
---
description: Write a fixed line into a file
argument-hint: <path>
---
Use the write tool to create the file $1 with exactly the text: hello world
```

Test cases (each model × each fixture):

1. **No-args expansion** — `/say-tuesday` → assert `chunkedAgentText(...).toLowerCase().includes("tuesday")`. Proves discovery + advertisement + expansion + LLM-saw-expanded-text. The literal `/say-tuesday` is meaningless to the model, so a "tuesday" reply is only possible if expansion ran.
2. **Single-arg substitution** — `/echo banana` → assert reply contains `"banana"` (case-insensitive). Substituting `$1` from the user's text into the template proves the substitution path. Run with two distinct values (`banana`, `42`) so a hard-coded fallback can't pass.
3. **Tool-call via expanded prompt (side-effect)** — `/write-file /out.txt` → assert `await harness.filesystem.readTextFile("/out.txt")` contains `"hello world"`. Combines slash-command expansion + write tool + filesystem; side-effect-asserted (no LLM-text dependency).
4. **available_commands_update notification** — `session/new` then assert `updates` contains a notification with `sessionUpdate: "available_commands_update"` and `availableCommands` matching the three fixtures (sorted, hint mapped). No model call needed; this could also live in integration, but cheap to verify here once a session is open.
5. **Pass-through verifies non-expansion** — send a plain-text prompt `"Reply with exactly the single word 'tuesday'."` (no slash) and assert the same outcome. Acts as a control: ensures the `/say-tuesday` test isn't passing because the model is just guessing "tuesday" from any prompt.

Conventions reused from existing e2e tests:
- `requireEnv("ANTHROPIC_API_KEY")` / `requireEnv("OPENAI_API_KEY")`.
- `createTestHarness` with single model + matching `getApiKey`.
- `chunkedAgentText(updates).toLowerCase()` for text assertions.
- Substring containment, never exact match — real LLMs vary phrasing.
- Run against both Haiku and gpt-5-mini in parallel test cases, mirroring `chat.e2e.ts`.

Determinism notes for cheap models:
- Forced-choice phrasing in templates (`Reply with exactly the single word "X"`) — same pattern as `chat.e2e.ts:87`.
- Side-effect assertions (file content) wherever possible — survives any LLM phrasing.
- Two distinct echo values per run guard against false-positive memorisation.
- Per-test retry budget: add `{ retry: 1 }` only if a specific test goes flaky in the first CI run; do not pre-emptively retry-everything.

---

## Files to modify

### `packages/bodhi-pi/package.json`
Add `"yaml": "^2.6.0"` to `dependencies`. Run `npm install` to update lockfile.

### `packages/bodhi-pi/src/acp/agent.ts`

| Anchor | Change |
|---|---|
| New imports at top | `import { loadProjectCommands } from "../commands/discovery.js"` and `import { type PromptTemplate, expandPromptTemplate } from "../commands/prompt-templates.js"`; ACP type `AvailableCommand` from `@agentclientprotocol/sdk`. |
| `SessionState` (lines 55-62) | Add `commands: PromptTemplate[]`. |
| `newSession` (lines 117-140) | After `this.sessions.set(...)`, call `await this.discoverAndAdvertise(record.id)`. Then `return ...`. |
| `loadSession` (lines 142-212) | After the history-replay loops (just before the `return` at line 209), call `await this.discoverAndAdvertise(params.sessionId)`. |
| `resumeSession` (lines 214-220) | After `rehydrateSession`, before `return`, call `await this.discoverAndAdvertise(params.sessionId)`. |
| `prompt` (lines 287-380) | After computing `text` (line 296), call `const expanded = expandPromptTemplate(text, session.commands)`; pass `expanded` (not `text`) to `session.piAgent.prompt(...)` at line 367. |
| New private method | `private async discoverAndAdvertise(sessionId: string): Promise<void>` — reads `session.cwd`, calls `loadProjectCommands(this.config.filesystem, session.cwd)`, writes into `session.commands`, then awaits `this.conn.sessionUpdate({ sessionId, update: { sessionUpdate: "available_commands_update", availableCommands: session.commands.map(toAvailableCommand) } })`. |
| New private helper (file-local, not on the class) | `function toAvailableCommand(t: PromptTemplate): AvailableCommand` — returns `{ name, description, ...(t.argumentHint ? { input: { hint: t.argumentHint } } : {}) }`. |

`rehydrateSession` (lines 409-435) does **not** itself need to know about commands — discovery is wired in the callers (`loadSession`, `resumeSession`), keeping `rehydrateSession`'s responsibility narrow.

### `packages/bodhi-pi/src/index.ts`
**No changes.** Slash commands are internal; only the ACP wire surface is public.

---

## Type design

- `PromptTemplate` — internal cache shape (defined in `commands/prompt-templates.ts`).
- `SessionState.commands: PromptTemplate[]` — populated at session hydration; read on every `prompt`.
- Wire payload — `AvailableCommand` from `@agentclientprotocol/sdk` (per `/tmp/acp-sdk-inspect/package/dist/schema/types.gen.d.ts:427-450`). Direct object literals — no `as` casts.
- Notification kind — `"available_commands_update"` per `types.gen.d.ts:4343-4344`.

---

## Edge cases & decisions

| Case | Behavior |
|---|---|
| `<cwd>/.bodhi-pi/commands/` missing | Empty list. Still emit notification with `availableCommands: []`. |
| `Filesystem.list` throws | Empty list (try/catch in discovery). |
| `.md` file with no frontmatter | Valid command; description = first non-empty body line truncated to 60 chars. |
| `.md` file with malformed YAML | Skipped silently; siblings still loaded. |
| Non-`.md` files in dir | Ignored. |
| Subdirectories under dir | Ignored (non-recursive). |
| `/cmd` with no args, body uses `$1` | Empty-string substitution. |
| `${@:N:L}` non-numeric | Regex requires digits; non-matching pattern is left as literal text. |
| Joined-text starts with `/` but template name unknown | Pass through verbatim. |
| Prompt has only image blocks (no text) | `text === ""`, expansion is a no-op, behavior unchanged. |
| Notification ordering vs `session/new` response | We `await sessionUpdate` before returning the response. ACP spec doesn't pin ordering of notifications relative to that response, and the client already knows the sessionId is in the imminent response. |

---

## Test plan

Three layers, all required:

| Layer | Files | Purpose |
|---|---|---|
| Unit | `src/commands/prompt-templates.test.ts`, `src/commands/discovery.test.ts` | Pure logic — substitution grammar + FS-driven discovery against in-memory FS. |
| Integration | `test/commands.test.ts` | Full ACP flow via `createTestHarness` + aimock. Covers: empty-list notification, multi-file mapping, re-emission on `load`/`resume`, expansion in `prompt`, unknown-cmd pass-through, plain-text & image-only no-ops. |
| e2e | `e2e/commands.e2e.ts` | Real LLMs (Haiku + gpt-5-mini). Five cases: no-args expansion, single-arg substitution (×2 distinct values), tool-call via expanded prompt, `available_commands_update` notification, plain-text control. See spec above. |

Run:
```bash
npm --workspace @bodhiapp/bodhi-pi run test       # unit + integration
npm --workspace @bodhiapp/bodhi-pi run test:e2e   # real LLMs (needs e2e/.env.test)
```

Manual smoke (optional):
```bash
# In the harness, drop a file at <tmpcwd>/.bodhi-pi/commands/greet.md:
# ---
# description: Greet someone
# argument-hint: <name>
# ---
# Say hello to $1.
#
# Drive session/new + session/prompt with text "/greet World" and assert
# the model received "Say hello to World." instead of "/greet World".
```

Gate-checks:
```bash
npm run check                                      # biome + tsgo --noEmit
npm --workspace @bodhiapp/bodhi-pi run build       # tsgo emit
npm --workspace @bodhiapp/bodhi-pi run test        # full suite
```

---

## CLAUDE.md update (new deliverable)

Append a new section to `packages/bodhi-pi/CLAUDE.md` titled **"Testing new features"**. Reason: the user has asked that planning new features must explicitly cover integration **and** e2e tests, with patterns that work reliably against the cheapest models we use (Haiku, gpt-5-mini). Today CLAUDE.md only covers the comments policy.

Proposed text to append (concrete, terse, no preamble — matches the file's existing tone):

```markdown
## Testing new features

Every new feature lands with three layers of test coverage. Plan all three at design time, not after implementation:

| Layer | Where | Runner | Purpose |
|---|---|---|---|
| Unit | `src/<area>/<file>.test.ts` | vitest | Pure logic — substitution, parsing, schema. No I/O, no LLM, no ACP wire. |
| Integration | `test/<feature>.test.ts` | vitest | Full ACP flow against `aimock` or `registerFauxProvider`. Asserts orchestration: tool dispatched, notification emitted, store appended, etc. |
| e2e | `e2e/<feature>.e2e.ts` | vitest (separate config) | Real LLMs (`claude-haiku-4-5`, `gpt-5-mini`) via the same ACP flow. Asserts the feature reaches the model and produces the right side-effect or stable substring. |

### e2e prompt patterns that survive cheap models

These rules keep the e2e suite cheap, deterministic, and parity-checked across providers. They're proven by `e2e/chat.e2e.ts` and `e2e/fs.e2e.ts`:

- **Forced-choice phrasing.** `Reply with exactly the single word "X" and nothing else.` Pin a token the model must emit. See `e2e/chat.e2e.ts:87`.
- **Single-word or single-token answers.** Cheaper to generate, easier to assert, fewer phrasing variants.
- **Substring match (case-insensitive).** Never compare full assistant text. `expect(text.toLowerCase()).toContain("tuesday")`.
- **Side-effect over text.** Assert `filesystem.readTextFile(...)` contents, `tool_call` notifications, `configOptions`, or other structural facts. Real LLM text varies; file state doesn't. See `e2e/fs.e2e.ts:39-42`.
- **Two distinct values per substitution test.** A `/echo banana` test that only ever uses `"banana"` could pass on a model fluke; alternate `banana` and `42` so coincidence is unlikely.
- **Cross-model parity.** Run the same test against both Haiku and gpt-5-mini. Provider-specific behavior shows up here, not in integration.
- **No exact-text equality.** No `toBe(...)` on assistant output. Only `toContain` / `toLowerCase().includes(...)` / structural assertions.
- **Provenance prompts use forced-choice between two options.** `Are you made by Anthropic or by OpenAI? Answer with exactly one of those two words.` Models tend to refuse self-identification otherwise. See `e2e/chat.e2e.ts:86-87`.
- **Retry only when known-flaky.** Don't blanket-add `{ retry: N }`. If a specific test flakes in CI, raise its retry to 1 with a comment explaining why.
- **Tag fixture with the feature name.** Markdown command files, seeded files, etc., should be uniquely named (`/out.txt`, `say-tuesday.md`) so concurrent tests don't collide on the in-memory FS. (This is automatic when each test owns its harness.)

### Cost / cache

- Cheap deterministic checks first (FS state, config option), heuristic checks second (substring), LLM-judge never. The e2e layer is for plumbing-reaches-LLM verification — it isn't an evals harness.
- Keep e2e prompts short and answers short. Both input and output tokens cost.
- Don't introduce a third real-LLM provider just for e2e variety. Two providers is enough to catch wire issues.

### When NOT to write e2e

- Pure-data features (e.g. wire-shape mapping, type guards) are fully covered by unit + integration. Adding e2e for these burns API quota with no extra signal.
- Features whose behavior is identical to a feature already covered by e2e (e.g. a bug fix to expansion grammar) — extend the existing test, don't fork a new file.
```

### Why this lives in CLAUDE.md

Future session pickups should read CLAUDE.md and immediately know that "plan e2e" is a step, not an afterthought. The package's existing CLAUDE.md (comments policy) sets precedent for codifying durable conventions there.

---

## Sequencing

**Single milestone, single commit.** Implementer checklist:

1. `package.json`: add `yaml` dep, run `npm install`.
2. Create `src/commands/prompt-templates.ts` (port substitution verbatim) + co-located unit tests; verify green.
3. Create `src/commands/discovery.ts` (frontmatter parse + FS-driven discovery) + co-located unit tests; verify green.
4. Modify `src/acp/agent.ts` per the table above (`SessionState`, three lifecycle hooks, `prompt` expansion, new private `discoverAndAdvertise`, file-local `toAvailableCommand`).
5. Add `test/commands.test.ts` integration tests; verify green.
6. Append the **Testing new features** section to `packages/bodhi-pi/CLAUDE.md` (text drafted above).
7. Add `e2e/commands.e2e.ts` with the five test cases × two providers; run `npm run test:e2e`; verify green (requires `e2e/.env.test` with both API keys).
8. Run `npm run check` from repo root + package build + offline test suite; commit.

Suggested commit subject: `feat(bodhi-pi): land slash commands / prompt templates`.

---

## Critical files

**To modify:**
- `packages/bodhi-pi/src/acp/agent.ts` (lines 55-62, 117-140, 142-212, 214-220, 287-380, 409-435)
- `packages/bodhi-pi/package.json` (add `yaml` dep)
- `packages/bodhi-pi/CLAUDE.md` (append "Testing new features" section)

**To create:**
- `packages/bodhi-pi/src/commands/prompt-templates.ts`
- `packages/bodhi-pi/src/commands/discovery.ts`
- `packages/bodhi-pi/src/commands/prompt-templates.test.ts`
- `packages/bodhi-pi/src/commands/discovery.test.ts`
- `packages/bodhi-pi/test/commands.test.ts`
- `packages/bodhi-pi/e2e/commands.e2e.ts`

**Reference (read-only, copy logic from):**
- `packages/coding-agent/src/core/prompt-templates.ts:24-102, 104-133, 282-296`
- `packages/coding-agent/test/prompt-templates.test.ts:22-354` (test cases shape)
- `/tmp/acp-sdk-inspect/package/dist/schema/types.gen.d.ts:427-450, 460-475, 5050-5065, 4287-4353` (ACP wire shapes)
- `agent-client-protocol/docs/protocol/slash-commands.mdx` (spec)

**Existing helpers to reuse:**
- `Filesystem.exists/list/readTextFile` — `packages/bodhi-pi/src/filesystem/filesystem.ts:12-33`
- `createTestHarness` — `packages/bodhi-pi/test/helpers/harness.ts`
- `createInMemoryFilesystem` — `packages/bodhi-pi/src/filesystem/in-memory-filesystem.ts`

---

## Risks / open questions

1. **Notification ordering** — we await `sessionUpdate` before returning the response. ACP spec doesn't pin this; if a real client struggles with notifications arriving before the corresponding response, switch to post-return scheduling (`queueMicrotask`/`setImmediate`). Watch in real-host integration.
2. **YAML dep size** — `yaml@2.6.0` adds ~300 KB. Acceptable per user direction. If desirable later, swap to a hand-rolled minimal parser (frontmatter only carries two string keys).
3. **No live reload** — editing a `.md` file mid-session won't reflect. User must `session/close` + `session/load` to refresh. Documented; revisit if a use case demands it.
