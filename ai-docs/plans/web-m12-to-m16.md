# bodhi-pi-web M12 → M16 — closing the parity gaps

## Context

M1–M11 shipped (`packages/bodhi-pi-web` and `packages/bodhi-pi-browser`). The feature audit against bodhi-pi found:

- **3 genuine gaps** the agent supports but the browser host doesn't expose: cancel/abort, multi-provider model switching (Anthropic key wired in env but not registered), `systemPrompt` config field.
- **~7 inferred-via-inheritance items** with no dedicated browser e2e: `edit` / `ls` / `find` FS tools, tool-failure rendering, tool-call replay on resume, `model_change` persistence across load, hidden-skill invocation, unknown `/skill:` passthrough, `available_commands_update` re-emit on resume.

This plan closes everything actionable. `systemPrompt` and a sessions sidebar stay deferred — neither has a clear UI requirement yet. The other two gaps and all seven inferred items get e2e coverage.

Five milestones, mirroring the M1–M11 cadence — each ends with `npm run check` clean + new gate tests + one commit.

## Decisions (locked via Q&A)

- **Cancel UX:** Send button **morphs** to Stop while `status==="streaming"`. Single button at all times — click during stream calls `conn.cancel({sessionId})`. No e2e (gpt-4o-mini finishes too fast for reliable mid-stream automation); user verifies manually with the dev server.
- **Default model stays `gpt-4o-mini`.** Anthropic registers as a switch target when `VITE_ANTHROPIC_API_KEY` is present. Cross-provider e2e starts in OpenAI and flips to Claude.
- **Anthropic model:** `claude-haiku-4-5` — matches `bodhi-pi/e2e/chat.e2e.ts`'s cross-provider test.
- **Hidden skill e2e** uses the `days-since-birthday` skill from M11 with `disable-model-invocation: true` added to its frontmatter. Asserts `/help` still advertises `skill:days-since-birthday` and `/skill:days-since-birthday <date>` returns the correct integer (proving invocation is unaffected by the hidden flag — the only change is the system-prompt augmentation, which bodhi-pi's own integration tests already cover exhaustively).
- **One commit per milestone.** Five commits: M12 → M16.

## Phase split

| # | Slice | Test gate |
|---|---|---|
| **M12** | Cancel button (Send morphs to Stop while streaming) | manual smoke (no e2e) |
| **M13** | Multi-provider (Anthropic registered) + cross-provider switch e2e | `cross-provider.spec.ts` — flip OpenAI ↔ Anthropic mid-session, assert provenance |
| **M14** | FS tools `edit` / `ls` / `find` e2e coverage | extend `fs-tools.spec.ts` with three new specs |
| **M15** | Tool-failure rendering + tool-call replay across resume | `tool-failure.spec.ts`, `tool-replay.spec.ts` |
| **M16** | Skills + commands edge cases: hidden skill, unknown `/skill:`, model_change-across-load, commands re-emit on resume | extend `skills.spec.ts` + `commands.spec.ts`; new `model-persists.spec.ts` |

After M16, the only remaining gaps are explicitly deferred: `systemPrompt` UI, sessions sidebar, MCP servers, image input, permissions modal.

---

## M12 — Cancel button

### Scope

User can stop a streaming response. While `status === "streaming"`, the Composer's Send button switches to "Stop" with a different handler that calls `conn.cancel({ sessionId })`. bodhi-pi maps cancel → `stopReason: "cancelled"` (proven in `packages/bodhi-pi/test/chat.test.ts`), so the inflight `prompt` resolves and the streaming → idle transition happens via the existing finally-block in `RuntimeProvider.prompt`.

### Files (modified)

- `packages/bodhi-pi-web/src/ui/RuntimeProvider.tsx` — expose `cancelPrompt()`. Implementation: `await conn.cancel({ sessionId: useChatStore.getState().sessionId })`. Don't touch `setStatus` here; the inflight prompt's finally-block flips it back.
- `packages/bodhi-pi-web/src/ui/Composer.tsx` — when `status === "streaming"`, render a `<button type="button" data-testid="composer-stop">` instead of the Send submit button. Click → `props.onStop()`. Keep Send button hidden (or `display: none`) so the input stays open for next prompt after cancel.
- `packages/bodhi-pi-web/src/ui/ChatPage.tsx` — pass `onStop={cancelPrompt}` from `useRuntime()`.

### Testability contract additions

- `<button data-testid="composer-stop" />` visible only while streaming.

### Verification

```bash
cd packages/bodhi-pi-web && npm run dev
# 1. Type a long prompt (e.g. "Write a 500-word essay about birds").
# 2. Composer Send button morphs to Stop during streaming.
# 3. Click Stop. Streaming halts; status flips to idle.
# 4. Send a new prompt — works normally.
```

No e2e — gpt-4o-mini finishes too fast to reliably catch the streaming state. The full `npm run check` and existing 11 e2e specs must stay green.

### Commit

`feat(bodhi-pi-web): land M12 — cancel button via session/cancel`

---

## M13 — Multi-provider + cross-provider switch e2e

### Scope

Register Claude alongside the OpenAI models when `VITE_ANTHROPIC_API_KEY` is present. The `/model` slash command (already shipped in M4) handles cross-provider routing automatically — bodhi-pi's `getApiKey(provider)` callback resolves per-turn, so each turn against `claude-haiku-4-5` lands in `apiKeys.anthropic` and each against `gpt-4o-mini` lands in `apiKeys.openai`.

### Files (modified)

- `packages/bodhi-pi-web/src/env.ts` — extend the registry: when `VITE_ANTHROPIC_API_KEY` is set, push `getModel("anthropic", "claude-haiku-4-5")`. Default stays `gpt-4o-mini`.
- `packages/bodhi-pi-web/.env` — add `VITE_ANTHROPIC_API_KEY=` line. Copy the value from `packages/bodhi-pi/e2e/.env.test` (`ANTHROPIC_API_KEY=sk-ant-…`).
- `packages/bodhi-pi-web/.env.example` — keep the placeholder line, no value.

### Files (new)

- `packages/bodhi-pi-web/e2e/cross-provider.spec.ts` — port `packages/bodhi-pi/e2e/chat.e2e.ts:60-95` ("switching model mid-session changes provenance"):

```ts
test("M13 cross-provider switch: gpt-4o-mini → claude-haiku-4-5", async ({ chat }) => {
  await test.step("boot defaults to gpt-4o-mini", async () => {
    await chat.goto(); await chat.waitForState("idle", 60_000);
    await expect(chat.statusBar).toHaveAttribute("data-current-model", "gpt-4o-mini");
  });
  const provenance = "Are you made by Anthropic or by OpenAI? Answer with exactly one of those two words and nothing else.";
  await test.step("OpenAI turn says openai", async () => {
    await chat.send(provenance);
    await chat.waitForState("streaming");
    await chat.waitForState("idle", 60_000);
    expect((await chat.lastMessage("assistant")).toLowerCase()).toContain("openai");
  });
  await test.step("/model claude-haiku-4-5", async () => {
    await chat.send("/model claude-haiku-4-5");
    await expect(chat.statusBar).toHaveAttribute("data-current-model", "claude-haiku-4-5");
  });
  await test.step("Anthropic turn says anthropic", async () => {
    await chat.send(provenance);
    await chat.waitForState("streaming");
    await chat.waitForState("idle", 60_000);
    expect((await chat.lastMessage("assistant")).toLowerCase()).toContain("anthropic");
  });
});
```

### Verification

```bash
cd packages/bodhi-pi-web && npx playwright test e2e/cross-provider.spec.ts
npx playwright test                       # all 12 specs green
npm run check
```

### Commit

`feat(bodhi-pi-web): land M13 — Anthropic registry + cross-provider switch e2e`

---

## M14 — FS tools coverage (`edit` / `ls` / `find`)

### Scope

bodhi-pi registers all six built-in FS tools whenever a `Filesystem` is provided. M8 e2e proved `read`, `write`, `grep`. M14 closes the gap with `edit`, `ls`, `find` — three new specs in `fs-tools.spec.ts`. No new source code in either package; the tools are already wired.

### Files (modified)

- `packages/bodhi-pi-web/e2e/fs-tools.spec.ts` — add three new `test.describe` blocks:

  1. **`edit`**: seed `/notes.txt` containing `"hello world"`. Prompt: *"Use the edit tool to change `/mnt/demo/notes.txt` so 'world' becomes 'earth'. Then use read to verify and reply with the new content verbatim."* Assert `[data-tool-name="edit"][data-tool-status="completed"]`, then `[data-tool-name="read"]`, then assistant message contains `"hello earth"`.

  2. **`ls`**: seed three files in `/notes/`. Prompt: *"Use the ls tool to list `/mnt/demo/notes`, then reply with all filenames separated by commas."* Assert `[data-tool-name="ls"][data-tool-status="completed"]`, then assistant mentions all three filenames.

  3. **`find`**: seed nested files matching a pattern. Prompt: *"Use the find tool to find all .md files under `/mnt/demo`. Reply with the count."* Assert `[data-tool-name="find"][data-tool-status="completed"]`, then assistant mentions correct count.

Each `test.describe` overrides `workspaceSeed` via `test.use({ workspaceSeed: { name: "demo", files: {...} } })` — same pattern as the existing M8 specs.

### Verification

```bash
cd packages/bodhi-pi-web && npx playwright test e2e/fs-tools.spec.ts
npm run check
```

### Commit

`feat(bodhi-pi-web): land M14 — fs-tools e2e for edit, ls, find`

---

## M15 — Tool failure rendering + tool-call replay

### Scope

Two coverage holes in one milestone — both rely on bodhi-pi behaviour already proven in `packages/bodhi-pi/test/fs.test.ts` ("tool failure replays as failed", "tool calls replay on session/load") but never asserted from the browser side.

### Files (new)

- `packages/bodhi-pi-web/e2e/tool-failure.spec.ts`:

```ts
test("M15 failed tool surfaces as a failed card", async ({ chat }) => {
  // Seed empty workspace — there's no /missing.txt for the agent to read.
  await chat.goto(); await chat.waitForState("idle", 60_000);
  await chat.send(
    "Use the read tool to read /mnt/demo/missing.txt. " +
    "If it fails, reply with: file-missing"
  );
  await chat.waitForState("streaming");
  await chat.waitForState("idle", 60_000);
  await expect(chat.toolCalls({ name: "read", status: "failed" })).toHaveCount(1);
  expect((await chat.lastMessage("assistant")).toLowerCase()).toContain("file-missing");
});
```

- `packages/bodhi-pi-web/e2e/tool-replay.spec.ts`:

```ts
test("M15 tool calls replay on /resume", async ({ chat }) => {
  // 1. Write a file (creates a write tool_call entry in session A)
  await chat.goto(); await chat.waitForState("idle", 60_000);
  await chat.send("Use write to create /mnt/demo/note.txt with content 'persisted'. Reply with ok.");
  await chat.waitForState("streaming"); await chat.waitForState("idle", 90_000);
  await expect(chat.toolCalls({ name: "write", status: "completed" })).toHaveCount(1);

  // 2. Capture sessionId from /sessions
  await chat.send("/sessions");
  const sys = (await chat.messages("system").last().textContent()) ?? "";
  const sessionA = sys.match(/\* ([0-9a-f-]{36})/)?.[1];
  expect(sessionA).toBeDefined();

  // 3. /new clears UI
  await chat.send("/new"); await chat.waitForState("idle", 60_000);
  expect(await chat.toolCalls().count()).toBe(0);

  // 4. /resume A — write tool_call replays as a completed card
  await chat.send(`/resume ${sessionA}`); await chat.waitForState("idle", 60_000);
  await expect(chat.toolCalls({ name: "write", status: "completed" })).toHaveCount(1);
});
```

Both specs override `workspaceSeed` to start with an empty `/mnt/demo`.

### Verification

```bash
cd packages/bodhi-pi-web && npx playwright test e2e/tool-failure.spec.ts e2e/tool-replay.spec.ts
npm run check
```

### Commit

`feat(bodhi-pi-web): land M15 — tool-failure card and tool-call replay e2e`

---

## M16 — Skills + commands edge cases

### Scope

Four remaining inferred items, all small. One milestone, one commit.

### Files (modified)

- `packages/bodhi-pi-web/e2e/skills.spec.ts` — append two new `test.describe` blocks:

  - **Hidden skill (`disable-model-invocation: true`).** Seed `/.bodhi-pi/skills/days-since-birthday/SKILL.md` (hidden frontmatter) + `script.js` (same as M11). Assert `/help` advertises `skill:days-since-birthday`. Then `/skill:days-since-birthday 2000-01-01` → assert `[data-tool-name="run_script"]` card and assistant returns `9624`. Proves: (a) hidden skill is still advertised, (b) explicit invocation works regardless of the hidden flag.

  - **Unknown `/skill:<x>` passthrough.** Seed an empty workspace. `/skill:nonexistent Reply with the single word: gravy` → assistant says "gravy". The literal text is forwarded as a prompt because no skill matches.

- `packages/bodhi-pi-web/e2e/commands.spec.ts` — append:

  - **Commands re-emit on resume.** Seed commands, prompt `/echo apple`, run `/sessions` to capture id, `/new`, then `/resume <id>` — assert `/help` still lists `echo`. Proves bodhi-pi's `available_commands_update` fires again on `loadSession` (already covered by `packages/bodhi-pi/test/commands.test.ts:"session/load re-emits"` but never asserted from the browser).

### Files (new)

- `packages/bodhi-pi-web/e2e/model-persists.spec.ts`:

```ts
test("M16 model_change persists across load", async ({ chat }) => {
  await chat.goto(); await chat.waitForState("idle", 60_000);
  await expect(chat.statusBar).toHaveAttribute("data-current-model", "gpt-4o-mini");

  // Switch + take one turn so the model_change entry is persisted.
  await chat.send("/model gpt-4o");
  await expect(chat.statusBar).toHaveAttribute("data-current-model", "gpt-4o");
  await chat.send("Reply with the single word: alpha");
  await chat.waitForState("idle", 60_000);

  // Capture session id, /new, /resume — status bar should reflect gpt-4o, not the default.
  await chat.send("/sessions");
  const sys = (await chat.messages("system").last().textContent()) ?? "";
  const sessionA = sys.match(/\* ([0-9a-f-]{36})/)?.[1];
  expect(sessionA).toBeDefined();

  await chat.send("/new"); await chat.waitForState("idle", 60_000);
  await expect(chat.statusBar).toHaveAttribute("data-current-model", "gpt-4o-mini");

  await chat.send(`/resume ${sessionA}`); await chat.waitForState("idle", 60_000);
  await expect(chat.statusBar).toHaveAttribute("data-current-model", "gpt-4o");
});
```

This relies on `commands.ts:/resume` reading the restored model from `loadSession`'s response `configOptions[0].currentValue` (already implemented in M5 — currently un-asserted).

### Verification

```bash
cd packages/bodhi-pi-web && npx playwright test
npm run check
```

### Acceptance gate — M16

All five originally-inferred items now have explicit browser e2e:

| Item | Spec |
|---|---|
| `edit`, `ls`, `find` tools | `fs-tools.spec.ts` (M14) |
| Tool failure rendering | `tool-failure.spec.ts` (M15) |
| Tool-call replay on resume | `tool-replay.spec.ts` (M15) |
| `model_change` persists across load | `model-persists.spec.ts` (M16) |
| Hidden skill invocation works | `skills.spec.ts` (M16) |
| Unknown `/skill:<x>` passthrough | `skills.spec.ts` (M16) |
| Commands re-emit on resume | `commands.spec.ts` (M16) |

### Commit

`feat(bodhi-pi-web): land M16 — skills/commands edge cases and model-persists e2e`

---

## Critical files (already exist; do not modify)

- `packages/bodhi-pi/src/acp/agent.ts` — `cancel`, `loadSession` (with config-option restore), `setSessionConfigOption` (model_change persistence) all live in the agent.
- `packages/bodhi-pi/test/chat.test.ts` — reference for "cancel during prompt yields cancelled", "model change persists across load".
- `packages/bodhi-pi/test/skills.test.ts` — reference for hidden skill behavior.
- `packages/bodhi-pi/test/fs.test.ts` — reference for tool replay + tool failure replay.
- `packages/bodhi-pi/test/commands.test.ts` — reference for commands re-emit on load.
- `packages/bodhi-pi/e2e/chat.e2e.ts:60-95` — reference for the cross-provider switch test.
- `packages/bodhi-pi/e2e/.env.test` — source of `ANTHROPIC_API_KEY` (already gitignored).
- `packages/bodhi-pi-web/src/agent/render.ts` — already dispatches `tool_call`/`tool_call_update` into store cards; no changes needed for M14/M15.
- `packages/bodhi-pi-web/src/ui/commands.ts` — already loads model from `loadSession`'s `configOptions` on `/resume`; M16's model-persists spec exercises this path.

## Risks per milestone

- **M12** — `conn.cancel` may not exist by that exact name on `ClientSideConnection`. Fallback: extension method or `extMethod("session/cancel", {sessionId})`. Verify against ACP SDK at implementation time.
- **M13** — Anthropic Claude may rate-limit if the cross-provider spec runs in CI alongside other Anthropic-using suites; isolate by running this spec last in the worker config or accept transient flakiness on retry.
- **M14** — gpt-4o-mini may not consistently choose `find` over `grep` for "list .md files"; phrase the prompt to require `find` explicitly.
- **M15** — tool-replay spec depends on the agent's session/load tool-call replay including the right `data-tool-name`. The card-by-name assertion is the gate; if bodhi-pi's replay populates a different field, adjust the assertion to match the actual `tool_call` notification shape (we own `render.ts`, so we can normalise there if needed).
- **M16** — model-persists relies on `clientConn.loadSession`'s response carrying `configOptions[0].currentValue`. bodhi-pi's `loadSession` already returns this (`packages/bodhi-pi/src/acp/agent.ts:222`). `commands.ts:/resume` reads it (M5 code). No new wire changes.

## Verification — full sweep after M16

```bash
npm --workspace @bodhiapp/bodhi-pi-browser run test    # 25 unit/integration tests
npm --workspace @bodhiapp/bodhi-pi-web run test:e2e    # ~17 specs total
npm run check                                          # repo-wide hygiene
```

End state: every bodhi-pi feature with a dedicated test in `packages/bodhi-pi/{test,e2e}/` has a matching browser-side spec exercising it through the worker against real `gpt-4o-mini` (and `claude-haiku-4-5` for the cross-provider switch). Genuine UX gaps closed: cancel button, multi-provider switching. Inferred-via-inheritance items now explicitly asserted: `edit` / `ls` / `find` tools, tool-failure rendering, tool-call replay on resume, hidden-skill invocation, unknown `/skill:` passthrough, `model_change` persistence across load, commands re-emit on resume. Out-of-scope (deferred): `systemPrompt` UI, sessions sidebar, MCP servers, image input, permissions modal.
