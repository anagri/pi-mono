# Plan: implement all slash-commands-skills review fixes (single commit)

## Context

Review `ai-docs/reviews/2026-05-08-slash-commands-skills.md` identified 12 findings across 6 batches.
All are fix-now actionable. The user wants them shipped as one commit.

---

## Files to modify

| File | Change |
|---|---|
| `src/skills/system-prompt.ts` | Add `escapeXml`, apply to fields, add guidance preamble (A.1 + B.1) |
| `src/skills/invocation.ts` | Import + apply `escapeXml` to attribute values (A.2) |
| `src/skills/discovery.ts` | Add `validateName`, add description length cap (C.1 + C.2) |
| `src/acp/agent.ts` | Extract `_buildSessionState` private method (D.1) |
| `src/_internal/frontmatter.ts` | Add `Array.isArray(parsed)` guard (F.1) |
| `src/commands/prompt-templates.test.ts` | Add unclosed-quote test (E.3) |
| `src/tools/run-script.test.ts` | Add empty-stdout+stderr test (E.2) |
| `test/helpers/filesystem.ts` | New file: shared `seedCommand` + `seedSkill` helpers (E.1) |
| `test/commands.test.ts` | Remove local `seedCommand`; import from helpers (E.1) |
| `test/skills.test.ts` | Remove local `seedCommand` + `seedSkill`; import from helpers (E.1) |

---

## Changes in detail

### 1. `src/skills/system-prompt.ts` (A.1 + B.1)

Add a module-private `escapeXml` helper and export it so `invocation.ts` can reuse it:

```ts
export function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
```

Update `formatSkillsForPrompt`:
- Prepend guidance lines before `<available_skills>` (B.1):
  ```
  The following skills provide specialized instructions for specific tasks.
  The user can invoke a skill by typing /skill:<name> in their message.
  Suggest this syntax when the task matches a skill's description; do not attempt
  to read SKILL.md files directly — the host will expand the skill content.
  ```
- Apply `escapeXml` to `s.name`, `s.description`, `s.filePath` in the `.map` (A.1).

### 2. `src/skills/invocation.ts` (A.2)

Import `escapeXml` from `./system-prompt.js`.

In `expandSkillCommand`, escape the attribute-position values only:
```ts
const block = `<skill name="${escapeXml(skill.name)}" location="${escapeXml(skill.filePath)}">\n...`;
```

Do NOT escape `skill.body` — it is raw markdown that the model must read as-is. Escaping
would garble code blocks and other markdown. The `</skill>` injection risk is accepted for
now (real skills are author-controlled markdown files; a comment is added noting this).

### 3. `src/skills/discovery.ts` (C.1 + C.2)

Add constants at the top:
```ts
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
```

Add a `validateName(name: string): boolean` function:
- `name.length <= MAX_NAME_LENGTH`
- `/^[a-z0-9-]+$/.test(name)`
- does not start or end with `-`
- does not contain `--`

Note: bodhi-pi allows frontmatter `name:` to override the folder name (existing behavior,
tested in discovery.test.ts). The validated name is the resolved name (frontmatter or folder),
NOT required to match folder name.

In `loadSkill`, after resolving `name` and `description`:
- If `!validateName(name)` → return `null`
- If `description.length > MAX_DESCRIPTION_LENGTH` → return `null`

Add two new tests to `src/skills/discovery.test.ts`:
- Skill with `name: bad Name!` (invalid charset) is skipped
- Skill with description longer than 1024 chars is skipped

### 4. `src/acp/agent.ts` (D.1)

Add a private method:

```ts
private async _buildSessionState(
    sessionId: string,
    model: Model<Api>,
    cwd: string,
    messages: AgentMessage[] = [],
): Promise<void> {
    const tools = createBuiltinTools({
        filesystem: this.config.filesystem,
        cwd,
        ...(this.config.scriptExecutor ? { scriptExecutor: this.config.scriptExecutor } : {}),
    });
    const commands = await loadProjectCommands(this.config.filesystem, cwd);
    const skills = await loadProjectSkills(this.config.filesystem, cwd);
    const composedSystemPrompt = composeSystemPrompt(this.config.systemPrompt, skills);
    const piAgent = new Agent({
        initialState: {
            model,
            ...(messages.length > 0 ? { messages } : {}),
            tools,
            ...(composedSystemPrompt !== undefined ? { systemPrompt: composedSystemPrompt } : {}),
        },
        getApiKey: this.config.getApiKey,
    });
    this.sessions.set(sessionId, {
        piAgent,
        currentModelId: model.id,
        cwd,
        tools,
        commands,
        skills,
        cancelled: false,
    });
}
```

Rewrite `newSession` to call it:
```ts
async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const record = await this.config.sessionStore.create({ cwd: params.cwd });
    const defaultModel = this.findModel(this.config.defaultModelId);
    await this._buildSessionState(record.id, defaultModel, record.cwd);
    await this.advertiseSlashable(record.id);
    return {
        sessionId: record.id,
        configOptions: [this.buildModelConfigOption(this.config.defaultModelId)],
    };
}
```

Rewrite the tail of `rehydrateSession` to call it (keep the top: load record, find model,
extract messages):
```ts
await this._buildSessionState(sessionId, restoredModel, cwd, messages);
return { entries: record.entries, currentModelId: modelId };
```

### 5. `src/_internal/frontmatter.ts` (F.1)

Line 14: change
```ts
if (!parsed || typeof parsed !== "object") return { frontmatter: {} as T, body: match[2] };
```
to:
```ts
if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return { frontmatter: {} as T, body: match[2] };
```

Add a test to `src/_internal/frontmatter.test.ts`:
- YAML top-level sequence (`- item\n- item`) returns empty frontmatter and full raw as body.

### 6. Test helpers: `test/helpers/filesystem.ts` (new file, E.1)

```ts
import type { Filesystem } from "../../src/index.js";

export async function seedCommand(
    fs: Filesystem, cwd: string, name: string, content: string,
): Promise<void> {
    const dir = `${cwd === "/" ? "" : cwd}/.bodhi-pi/commands`;
    await fs.mkdir(dir, { recursive: true });
    await fs.writeTextFile(`${dir}/${name}`, content);
}

export async function seedSkill(
    fs: Filesystem, cwd: string, folder: string, content: string,
): Promise<void> {
    const dir = `${cwd === "/" ? "" : cwd}/.bodhi-pi/skills/${folder}`;
    await fs.mkdir(dir, { recursive: true });
    await fs.writeTextFile(`${dir}/SKILL.md`, content);
}
```

Update `test/commands.test.ts`: remove local `seedCommand` (lines 60-69); add import from
`./helpers/filesystem.js`. The existing `ReturnType<typeof createInMemoryFilesystem>` type in
the local version is compatible with the `Filesystem` interface — the import works as-is.

Update `test/skills.test.ts`: remove local `seedCommand` (70-74) and `seedSkill` (64-68);
add import from `./helpers/filesystem.js`.

### 7. `src/tools/run-script.test.ts` (E.2)

Add after the existing "non-zero exit code" test:

```ts
test("empty stdout and stderr produces only exitCode line", async () => {
    const executor = makeExecutor(async () => ({ stdout: "", stderr: "", exitCode: 1 }));
    const tool = createRunScriptTool({ executor, cwd: "/proj" });
    const result = await tool.execute("call-1", { path: "x.js" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toBe("exitCode: 1");
});
```

### 8. `src/commands/prompt-templates.test.ts` (E.3)

Add after the "trailing whitespace" test in the `parseCommandArgs` block:

```ts
test("unclosed double-quote includes remaining content in the argument", () => {
    expect(parseCommandArgs('"hello world')).toEqual(["hello world"]);
});
```

(The current implementation: opens `inQuote='"'`, accumulates `hello world`, string ends without
closing quote, `current` is pushed. Result: `["hello world"]`.)

---

## Verification

```bash
# Typecheck + lint
npm run check

# Unit + integration tests (no real LLM needed)
npm --workspace @bodhiapp/bodhi-pi run test

# Optionally — e2e (needs OPENAI_API_KEY)
npm --workspace @bodhiapp/bodhi-pi run test:e2e
```

All existing tests must pass. The new validation tests in `discovery.test.ts` will catch
regressions in name/description validation. The `seedCommand`/`seedSkill` refactor is
structurally verified by the existing integration tests that call them.
