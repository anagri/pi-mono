# Phase G — System prompt & context foundations (plan)

## Context

Today bodhi-pi composes the per-session system prompt only from the
host-supplied `BodhiPiConfig.systemPrompt` plus the auto-discovered
`<available_skills>` block (see `packages/bodhi-pi/src/skills/system-prompt.ts:37`
and the call site `packages/bodhi-pi/src/acp/agent.ts:1196`). Three
gaps fall out of that:

1. **No built-in tool descriptions.** A host that passes no
   `systemPrompt` ships a model that knows nothing about `read`/`grep`/
   `edit`/`write`/`run_script`. Every reference host currently hand-rolls
   a prompt or relies on a model guessing correct schemas — fragile and
   off-spec vs. `packages/coding-agent/src/core/system-prompt.ts`.
2. **Override-only surface.** `BodhiPiConfig.systemPrompt` *replaces*
   whatever default we add. To layer project guidance on top of a
   built-in prompt the host must reimplement the built-in.
3. **No project-rooted context.** `AGENTS.md` / `CLAUDE.md` content
   isn't picked up. A user dropping `AGENTS.md` in their workspace
   today gets no behavior change from the agent.

Phase G closes those three gaps and also reads a minimal
`.bodhi-pi/settings.json` so a project can pin `compaction` overrides
and an `appendSystemPrompt` per-repo. Skill `allowed-tools` runtime
enforcement is **deferred to the permissions phase** (per user
decision); PARITY.md row stays ⏭.

User decisions taken in this plan (confirmed up front):

- Built-in prompt: **full coding-agent-style template** (boilerplate +
  tool snippets + guidelines + contextFiles + skills + cwd/date),
  ported into bodhi-pi core. Not a builder-only API.
- AGENTS.md walk: **`AGENTS.md > AGENTS.MD > CLAUDE.md > CLAUDE.MD`,
  cwd → ancestors → filesystem root**. First match per dir wins;
  one match per dir; matches concatenated across ancestors.
- Settings: **project-only `.bodhi-pi/settings.json`** (no user-level
  `~/.bodhi-pi/settings.json` this phase).
- Skill `allowed-tools` enforcement: **deferred**.

## In-scope outcomes

After this phase a user of any reference host should observe:

1. **Built-in system prompt with tool descriptions** — a host that
   passes no `systemPrompt` still gets a prompt that documents every
   built-in tool the agent registered (`read`/`grep`/`find`/`ls`/`edit`/
   `write`/`run_script`-when-scriptExecutor-present).
2. **Append surface** — host can set `appendSystemPrompt` in
   `BodhiPiConfig`; CLI mirrors with `--append-system-prompt <text>` +
   `BODHI_APPEND_SYSTEM_PROMPT` env. Both base + append land in the
   prompt sent to the model.
3. **AGENTS.md walk** — `<cwd>/AGENTS.md` (and ancestors, and
   `CLAUDE.md` fallback) read via the **injected** `Filesystem`,
   concatenated into the prompt's `# Project Context` section.
4. **Project settings.json** — `<cwd>/.bodhi-pi/settings.json`
   populates `compaction.*` overrides and `appendSystemPrompt`. Host
   explicit values still win on collision.

Each outcome must be observable through the public ACP/UI surface.
A new `_bodhi-pi/session/config` extension method + `/config` slash
command surfaces the resolved config for blackbox e2e verification
(same pattern that birthed `/entries` and `/tree`).

## Out of scope (carried forward as ⏭ in PARITY.md)

- Skill `allowed-tools` runtime enforcement (lands in permissions
  phase).
- `~/.bodhi-pi/settings.json` user-level merge.
- Tool snippet customization in system prompt (parity report §3.4 P3).
- Sub-agents (`.claude/agents/`) — excluded by design.

## Design

### New core modules

**`packages/bodhi-pi/src/core/system-prompt.ts`** (new file; existing
`src/skills/system-prompt.ts` stays — it still owns `formatSkillsForPrompt`
which the new module consumes).

Port `buildSystemPrompt` from
`packages/coding-agent/src/core/system-prompt.ts:28` adapted to bodhi-pi:

- Same `BuildSystemPromptOptions` shape, **minus** `getReadmePath` /
  `getDocsPath` / `getExamplesPath` (pi-only documentation paths). The
  "Pi documentation" block at lines 141–147 of the coding-agent file
  drops out — bodhi-pi has no equivalent canonical docs path.
- Tool snippet dictionary lives next to the built-in tool factory at
  `packages/bodhi-pi/src/tools/index.ts` (`createBuiltinTools`). Export
  a parallel `BUILTIN_TOOL_SNIPPETS: Record<string, string>` so the
  same source defines both the registered tool and its prompt
  description. `run_script` snippet only included when scriptExecutor
  is present (mirror existing tool-registration gating).
- Skills section reuses existing
  `packages/bodhi-pi/src/skills/system-prompt.ts:20` `formatSkillsForPrompt`.
- `selectedTools` defaults to **the names the agent actually
  registered for this session** (derived from
  `session.tools.map(t => t.definition.name)`) — not the
  coding-agent default `["read","bash","edit","write"]`.
- Custom-prompt branch (`customPrompt` set): same composition as
  coding-agent — `customPrompt + appendSection + contextFiles + skills
  + date/cwd`. This is the path host-supplied `systemPrompt` takes.

**`packages/bodhi-pi/src/core/resource-loader.ts`** (new file).

Port `loadContextFileFromDir` / `loadProjectContextFiles` from
`packages/coding-agent/src/core/resource-loader.ts:58-114`, adapted to
bodhi-pi's injected `Filesystem`:

```ts
export async function loadProjectContextFiles(
  fs: Filesystem,
  cwd: string,
): Promise<Array<{ path: string; content: string }>>
```

- Walks `cwd` → ancestors → root using `path.resolve(dir, "..")`
  (Node) — in browser hosts `cwd` typically rooted at the mounted FSA
  dir, so the walk terminates naturally at the mount root (no
  filesystem-root climb).
- Candidates per dir: `["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]`.
- First match per dir wins; ordering returns root → cwd (so the most
  specific instruction wins last, matching coding-agent line 100
  `unshift`).
- Uses `fs.exists` + `fs.readTextFile` (the existing surface used by
  `commands/discovery.ts` and `skills/discovery.ts`). No `node:fs`.

This module is also the natural home for the future
`.claude/agents/` SYSTEM.md discovery if it ever lands. Out of scope
now.

**`packages/bodhi-pi/src/core/settings.ts`** (new file).

```ts
export interface BodhiPiProjectSettings {
  compaction?: Partial<CompactionSettings>;
  appendSystemPrompt?: string;
}

export async function loadProjectSettings(
  fs: Filesystem,
  cwd: string,
): Promise<BodhiPiProjectSettings>
```

- Reads `<cwd>/.bodhi-pi/settings.json` via injected `Filesystem`.
- Missing file → returns `{}`. Parse error → returns `{}` + emits one
  warning via the existing `events.emit` debug channel (no throw, no
  noise — keeps the phase's "no silent defaults" carve-out for
  optional fields).
- Only `compaction` + `appendSystemPrompt` keys are recognized this
  phase. Unknown keys are preserved on the parsed object (for
  surfacing through `/config`) but not consumed.

### Wiring into `_buildSessionState`

Edit `packages/bodhi-pi/src/acp/agent.ts:1177` (`_buildSessionState`).
After the existing `loadProjectCommands` + `loadProjectSkills` calls
(lines 1189–1190), add:

```ts
const contextFiles = await loadProjectContextFiles(this.config.filesystem, cwd);
const projectSettings = await loadProjectSettings(this.config.filesystem, cwd);
```

Replace the current `composeSystemPrompt(this.config.systemPrompt, skills)`
at line 1196 with a call to the new `buildSystemPrompt`:

```ts
const resolvedAppend = this.config.appendSystemPrompt
  ?? projectSettings.appendSystemPrompt;
const composedSystemPrompt = buildSystemPrompt({
  customPrompt: this.config.systemPrompt,
  selectedTools: tools.map((t) => t.definition.name),
  toolSnippets: BUILTIN_TOOL_SNIPPETS,
  appendSystemPrompt: resolvedAppend,
  cwd,
  contextFiles,
  skills,
});
```

Merge project settings into compaction settings at session-state
build time:

```ts
const effectiveCompaction = {
  ...this.compactionSettings,
  ...(projectSettings.compaction ?? {}),
  // host-explicit config wins on collision
  ...(this.config.compaction ?? {}),
};
```

Store `effectiveCompaction` + `contextFiles[].path` + `resolvedAppend`
on `SessionState` so the new `_bodhi-pi/session/config` ext method
can surface them. The existing `composeSystemPrompt` in
`skills/system-prompt.ts` keeps its export (deleting risks breaking
tests/extension code that imports it) — the new builder calls
`formatSkillsForPrompt` directly.

### `BodhiPiConfig` change

Add one field to `packages/bodhi-pi/src/acp/agent.ts:97`:

```ts
/** Appended to the system prompt after the built-in section. Not persisted; reread on every load/resume. */
appendSystemPrompt?: string;
```

No factory-throw — like `systemPrompt`, it's the documented exception
for optional prompt fields. Update the `BodhiPiConfig` JSDoc note on
line 104 to cover both.

### New ACP extension method

Add `_bodhi-pi/session/config` to the dispatcher
(`packages/bodhi-pi/src/acp/agent.ts:393`):

```ts
if (method === EXT_SESSION_CONFIG) return this.handleSessionConfig(params);
```

Constant in `src/acp/constants.ts`: `EXT_SESSION_CONFIG = "_bodhi-pi/session/config"`.

Response shape:

```ts
{
  sessionId: string;
  cwd: string;
  defaultModelId: string;
  currentModelId: string;
  compaction: CompactionSettings;
  appendSystemPrompt: string | null;
  contextFilePaths: string[];      // resolved AGENTS.md / CLAUDE.md paths
  projectSettingsPresent: boolean; // was .bodhi-pi/settings.json found?
}
```

Advertise via `agentCapabilities._meta["bodhi-pi"]` in `initialize`:
add `sessionConfig: true`.

### Per-host `/config` slash command

Each of the 5 hosts gains a `/config` command that calls the new
extension method and renders the result as a system message. Wiring
sites confirmed in exploration:

- `packages/bodhi-pi-cli/src/repl/commands.ts`
- `packages/bodhi-pi-browser/src/ui/commands.ts` (shared by web +
  chrome-ext)
- `packages/bodhi-pi-ws-frontend/src/ui/commands.ts` (inline method
  constant `const EXT_SESSION_CONFIG = "_bodhi-pi/session/config"` —
  no agent imports allowed in ws-frontend)
- `packages/bodhi-pi-http/src/frontend/ui/commands.ts`

Update each host's `/help` text in the same change.

### CLI flag + env

`packages/bodhi-pi-cli/src/config.ts`:

- New flag `--append-system-prompt <text>`.
- New env var `BODHI_APPEND_SYSTEM_PROMPT`.
- Resolution order: flag wins over env; result lands as
  `cfg.appendSystemPrompt`. Help text (config.ts:167) updated.

`packages/bodhi-pi-cli/src/cli.ts:21` + `src/agent.ts:41` pass
`appendSystemPrompt` through to `createBodhiPiAgent`.

### Other hosts threading `appendSystemPrompt`

Each host's wire-agent already threads `systemPrompt`; mirror that
for `appendSystemPrompt`:

- `packages/bodhi-pi-ws-server/src/server.ts:20`, `:78`
- `packages/bodhi-pi-ws-server/src/agent/wire-agent.ts:16`, `:121`
- `packages/bodhi-pi-http/src/server/server.ts:16`, `:40`
- `packages/bodhi-pi-http/src/server/acp/handler.ts:16`, `:125`
- `packages/bodhi-pi-http/src/server/agent/wire-agent.ts:16`, `:139`
- `packages/bodhi-pi-web/`: chat-store / worker-bootstrap config
  surface (smallest pass-through; not normally set by web users).

## Tests (depth-first per runtime; TDD)

For each sub-feature: core integration test → core real-LLM e2e where
applicable → per-host e2e. Faux-provider tests capture `ctx.systemPrompt`
to assert prompt content (pattern at
`packages/bodhi-pi/test/helpers/harness.ts`).

### Sub-feature 1: built-in system prompt + tool descriptions

- `packages/bodhi-pi/test/system-prompt-builtin.test.ts` (faux):
  no `systemPrompt` supplied → captured prompt contains
  `"Available tools:"` and `"- read:"` (and other registered tools).
  `run_script` snippet appears iff `scriptExecutor` supplied.
- `packages/bodhi-pi/e2e/system-prompt-builtin.e2e.ts` (gpt-4o-mini):
  no `systemPrompt`, ask "read the file at /tmp/.../target.txt"
  → assert read tool was actually called (use existing
  `toolCallUpdates` helper).
- Per-host e2e: 1 spec each that creates a session with no
  systemPrompt + asks for a tool action; assert via tool-call updates
  (CLI/web/ws/http/chrome-ext). gpt-4o-mini.

### Sub-feature 2: append surface

- `packages/bodhi-pi/test/system-prompt-append.test.ts` (faux):
  set `systemPrompt: "BASE"` + `appendSystemPrompt: "APPEND-TROPIC"`
  → captured prompt contains both literal strings.
- CLI e2e: pass `--append-system-prompt 'reply with codeword TROPIC'`
  → assistant response contains TROPIC.
- Other hosts: assert through `/config` slash showing
  `appendSystemPrompt` field is the value supplied at construction.

### Sub-feature 3: AGENTS.md walk

- `packages/bodhi-pi/test/resource-loader.test.ts` — table-test the
  walk:
  - `<cwd>/AGENTS.md` exists → contents in prompt.
  - `<cwd>/AGENTS.md` and `<parent>/AGENTS.md` → both, root-first
    ordering verified.
  - `<cwd>/CLAUDE.md` only → contents in prompt.
  - `<cwd>/AGENTS.md` and `<cwd>/CLAUDE.md` → only AGENTS.md
    (precedence).
- `packages/bodhi-pi/test/system-prompt-context.test.ts` (faux):
  seed `AGENTS.md` containing "codeword XYZ" via in-memory FS → captured
  prompt includes "codeword XYZ" and the file path header.
- Per-host real-LLM e2e: seed `AGENTS.md` at session cwd with
  "always reply with codeword TROPIC"; assistant response contains
  TROPIC. Browser hosts use the existing
  `window.__bodhiPiWebSeed` workspace seam.

### Sub-feature 4: project settings.json

- `packages/bodhi-pi/test/settings.test.ts` (faux):
  - Missing file → `loadProjectSettings` returns `{}`; no error.
  - Malformed JSON → returns `{}`; no throw.
  - `{ "compaction": { "reserveTokens": 99999 } }` → returned by
    `_bodhi-pi/session/config` as `compaction.reserveTokens === 99999`.
  - Both `appendSystemPrompt` in settings AND in `BodhiPiConfig` →
    host-explicit wins.
- Per-host `/config` e2e: each host seeds a `.bodhi-pi/settings.json`
  in its test workspace, invokes `/config`, asserts the system-message
  output contains the override value. No real LLM needed — faux/HTTP
  fixtures are fine for the host integration test.

### Type-check & gate

- `npx tsgo --noEmit -p packages/bodhi-pi/tsconfig.json` (and per
  host) at each runtime boundary.
- `just test` at phase boundary; restore
  `packages/ai/src/models.generated.ts` before commit.

## Critical files

**New:**
- `packages/bodhi-pi/src/core/system-prompt.ts` (ported builder)
- `packages/bodhi-pi/src/core/resource-loader.ts` (AGENTS.md walk via injected Filesystem)
- `packages/bodhi-pi/src/core/settings.ts` (project settings loader)
- `packages/bodhi-pi/test/system-prompt-builtin.test.ts`
- `packages/bodhi-pi/test/system-prompt-append.test.ts`
- `packages/bodhi-pi/test/system-prompt-context.test.ts`
- `packages/bodhi-pi/test/resource-loader.test.ts`
- `packages/bodhi-pi/test/settings.test.ts`
- `packages/bodhi-pi/e2e/system-prompt-builtin.e2e.ts`
- Per-host e2e specs (cli/web/ws-frontend/http/chrome-ext) for the
  4 in-scope outcomes.

**Modified:**
- `packages/bodhi-pi/src/acp/agent.ts` (`BodhiPiConfig.appendSystemPrompt`,
  `_buildSessionState` wiring, new `_bodhi-pi/session/config` dispatcher
  and handler, `initialize` capability flag)
- `packages/bodhi-pi/src/acp/constants.ts` (`EXT_SESSION_CONFIG`)
- `packages/bodhi-pi/src/tools/index.ts` (export `BUILTIN_TOOL_SNIPPETS`)
- `packages/bodhi-pi/src/index.ts` (export new types if any cross
  the package boundary — only `BodhiPiProjectSettings` if reference
  hosts read it directly; otherwise none)
- `packages/bodhi-pi/CLAUDE.md` ("No fs/file-walk in core" rule
  updated: walks now permitted *only via injected Filesystem*; node:fs
  ban unchanged)
- `packages/bodhi-pi/PARITY.md` (add ✅ rows for built-in prompt,
  append, AGENTS.md walk, settings.json; leave ⏭ row for skill
  allowed-tools — defer reason unchanged)
- All 5 host slash dispatchers (`/config` + `/help` text)
- `packages/bodhi-pi-cli/src/{cli,config,agent}.ts` (`--append-system-prompt`
  flag + env)
- ws-server / http / web `wire-agent` / `server` files threading
  `appendSystemPrompt`

## Reused functions (already in tree)

- `packages/bodhi-pi/src/skills/system-prompt.ts:20` `formatSkillsForPrompt` —
  consumed by the new `buildSystemPrompt`.
- `packages/bodhi-pi/src/filesystem/filesystem.ts` `Filesystem` — same
  interface used by `commands/discovery.ts` + `skills/discovery.ts`.
- `packages/bodhi-pi/test/helpers/harness.ts` `createTestHarness` +
  `setResponses(ctx => ...)` for prompt-capture in faux-provider tests.
- `packages/bodhi-pi-cli/test/helpers/tool-call-asserts.ts` for
  tool-call assertions in real-LLM e2e.
- `window.__bodhiPiWebSeed` (Playwright) for seeding browser-host
  AGENTS.md fixtures.
- Existing slash-command dispatcher shape in each host — `/config`
  follows the `/entries` / `/tree` pattern.

## Verification — end-to-end

1. From repo root: `just test` (full matrix).
2. `npx tsgo --noEmit` across each touched package.
3. Manual smoke per host: launch with no `systemPrompt`, type
   `/config` → see resolved compaction settings + AGENTS.md paths
   reflected. Then drop an `AGENTS.md` with a codeword in
   `packages/bodhi-pi-web/e2e/examples/` and a CLI workspace; chat
   with `gpt-4o-mini` and confirm the codeword behavior persists.
4. Restore `packages/ai/src/models.generated.ts` before commit.
5. Commit: `feat(bodhi-pi): system prompt + AGENTS.md + project settings (Phase G)`
   with body summarizing the four in-scope outcomes + the
   `allowed-tools` deferral reason. Add the standard `Co-Authored-By`
   trailer per process.md.
