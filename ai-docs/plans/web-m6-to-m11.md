# bodhi-pi-web M6 → M11 — persistence, real FS, tools, commands, skills, scripts

## Context

M1–M5 shipped (see git log: `0dc66e52` … `8947c03e`). bodhi-pi-web has chat, model switching, and slash-command session lifecycle — but it runs against in-memory adapters and exercises **none** of the rich features bodhi-pi already proves in its own e2e suite (`fs.e2e.ts`, `commands.e2e.ts`, `skills.e2e.ts`, `scripted-skill.e2e.ts`). The agent can technically call `read`/`write`/`edit`/`ls`/`find`/`grep` because we inject `createInMemoryFilesystem`, but no browser-side e2e proves it; project slash commands and skills aren't seeded; `run_script` is unregistered.

This plan iterates the next six milestones. Each lands a single coherent slice with green gate-check tests and one commit, mirroring the M1–M5 cadence and bodhi-pi's own M1.x/M2.x/M3.x style:

| # | Slice | Test gate |
|---|---|---|
| **M6** | Dexie + IndexedDB session store, sessionStorage-backed sessionId resume on reload | reload page mid-conversation, history reappears |
| **M7** | ZenFS over Chrome's File System Access API, IndexedDB handle persistence, `<DirectoryGate>` boot UX | seed-injected e2e; manual FSA picker for real-folder grant |
| **M8** | Dedicated `<ToolCallCard>` UI + e2e for the six built-in FS tools (read/write/edit/ls/find/grep) | live LLM writes a file, reads it back, greps it |
| **M9** | Project slash commands (`.bodhi-pi/commands/*.md`) wired through bodhi-pi's existing discovery | live LLM expands `/<name> args` and replies |
| **M10** | Markdown-only skills (`.bodhi-pi/skills/<name>/SKILL.md`) — `<available_skills>` in system prompt + `/skill:<name>` invocation | live LLM follows `/skill:<name>` with the wrapped body |
| **M11** | Browser `ScriptExecutor` (AsyncFunction-based) + scripted skill (`days-since-birthday`) | live LLM calls `run_script`, returns an integer answer |

All milestones reuse bodhi-pi's existing surface — agent-side discovery, ACP notifications, tool registration — by simply giving the worker a real `Filesystem` (M7) and a `ScriptExecutor` (M11). The web work is host plumbing, not agent code.

## Decisions (locked in via clarifying Q&A)

- **One commit per milestone**, gate-check tests green before commit. Same shape as M1–M5.
- **Auto-resume on reload via `session/load`** — user sees their conversation reappear with full history replay (not `resumeSession`'s no-replay variant). sessionStorage stores `currentSessionId` per-tab so cross-tab independence is preserved. IndexedDB stores the session entries.
- **FSA mount path: `/mnt/<handle.name>`.** Chrome's FSA deliberately hides the absolute local path (privacy by design — `FileSystemDirectoryHandle.name` returns only the basename). So a "real-path mount" like `/Users/<user>/Documents/...` isn't even reachable. `/mnt/<basename>` matches web-acp's convention, leaves room for multi-mount later, and the user-visible folder name in status bar makes the mount discoverable.
- **Single mount in v1.** Users grant exactly one root folder. Multi-volume is a follow-up milestone.
- **Dedicated tool-call cards** with `[data-testid="tool-call"][data-tool-name][data-tool-status]`. M8 lifts the M3 system-message rendering into a typed message kind for cleaner e2e assertions.
- **Playwright bypasses FSA via `window.__bodhiPiWebSeed`** (web search confirmed: Chrome doesn't expose CDP for FSA picker dismissal; no Playwright `grantFileSystemAccess` API). When the seed is present, `bodhi-pi-browser` mounts a ZenFS `InMemory` instance with the seed files instead of `WebAccess`. Real Chrome FSA picker exercised manually only. Pattern lifted verbatim from `BodhiSearch/web-acp/src/runtime/volumes-fsa/backends.ts`.
- **All e2e from M8 onward seed the FS** through the same `window.__bodhiPiWebSeed` channel. This is the test-only path; production uses FSA + IndexedDB handle persistence.
- **Defer until later:** multi-provider (Anthropic, Gemini), multi-volume, sessions sidebar UI, cancel/abort, systemPrompt config, MCP servers, image input.

---

## M6 — Dexie session store + sessionStorage sessionId persistence

### Scope

Replace `createInMemorySessionStore()` in the worker with a Dexie-backed implementation in `@bodhiapp/bodhi-pi-browser`. Persist `currentSessionId` in `sessionStorage` (per-tab) so `RuntimeProvider` can auto-resume on reload. The agent's `session/load` already replays history via `user_message_chunk` / `agent_message_chunk` notifications (bodhi-pi M2.1) — render.ts (ported from cli) already handles them — so the conversation reappears organically with no new agent code.

### Files (new)

```
packages/bodhi-pi-browser/src/
├─ sessions/
│   ├─ db.ts                           # Dexie class BodhiPiBrowserDb v1 schema
│   ├─ dexie-session-store.ts          # createDexieSessionStore({ dbName }): SessionStore
│   └─ dexie-session-store.test.ts     # vitest + fake-indexeddb
└─ index.ts                             # add the export
```

### Files (modified)

- `packages/bodhi-pi-browser/package.json` — add `dexie@^4.0.11` runtime dep, `fake-indexeddb@^6.0.0` devDep.
- `packages/bodhi-pi-web/src/agent/worker.ts` — swap `createInMemorySessionStore()` → `createDexieSessionStore({ dbName: "bodhi-pi-web" })`.
- `packages/bodhi-pi-web/src/agent/types.ts` — extend `InitMessage` with `lastSessionId?: string` (read from sessionStorage on main, sent to worker on init).
- `packages/bodhi-pi-web/src/ui/RuntimeProvider.tsx`
  - On boot: `sessionStorage.getItem("bodhi-pi-web:sessionId")`. If present, pass through `InitMessage`. After init: try `conn.loadSession(id, "/", [])`; on error (session not found), fall back to `conn.newSession`.
  - After every `/new`/`/resume`: write `sessionStorage`. After every `/close`/`/delete (current)`: clear it.

### Schema (`sessions/db.ts`)

```ts
import Dexie, { type Table } from "dexie";

export interface SessionRow { id: string; cwd: string; createdAt: number; updatedAt: number }
export interface EntryRow {
  pk?: number; sessionId: string; seq: number;
  // SessionEntry payload — stored as JSON to stay schema-stable across bodhi-pi versions
  entry: unknown;
}

export class BodhiPiBrowserDb extends Dexie {
  sessions!: Table<SessionRow, string>;
  entries!: Table<EntryRow, number>;
  constructor(dbName: string) {
    super(dbName);
    this.version(1).stores({
      sessions: "&id, cwd, updatedAt",
      entries:  "++pk, sessionId, [sessionId+seq]",
    });
  }
}
```

Mirrors the rationale from `cli-m-1-implement.md` ("storing the full entry as JSON in `payload` keeps the store schema-stable").

### Adapter (`sessions/dexie-session-store.ts`)

Implements bodhi-pi's `SessionStore` interface verbatim:
- `create({ cwd })` — `crypto.randomUUID()`, insert `sessions` row, return `SessionRecord` with empty entries.
- `load(id)` — fetch `sessions.get(id)`; if found, fetch entries by `[sessionId+seq]` ordered, deserialize.
- `append(id, entry)` — rw txn: bump `updatedAt`, compute next seq via `entries.where({sessionId}).count()`, insert.
- `list({ cwd, cursor })` — `sessions.where('cwd').equals(cwd)` if filtered, sort `updatedAt desc`. messageCount = `entries.where({sessionId}).count()` filtered to message type. Ignore cursor in v1 (matches in-memory).
- `delete(id)` — rw txn: delete entries + session.

### TDD — M6

#### Integration (vitest + fake-indexeddb) — `dexie-session-store.test.ts`

Mirror `bodhi-pi/test/sessions.test.ts` patterns:
- create → load round-trip
- append bumps updatedAt
- list filters by cwd
- list orders by updatedAt desc
- delete cascades entries
- "session not found" rejection on append

#### E2E — extend `e2e/sessions.spec.ts`

Add a final step:
```ts
await test.step("reload the page", async () => {
  await chat.page.reload();
  await chat.waitForState("idle", 60_000);
});
await test.step("history reappears via auto-resume", async () => {
  // The 'aurora' user message + 'noted' assistant reply replay via session/load.
  await expect(chat.messages("user")).toContainText(/aurora/i);
  await expect(chat.messages("assistant").last()).toContainText(/aurora|noted/i);
});
```

### Verification

```bash
npm --workspace @bodhiapp/bodhi-pi-browser run test    # 6+ unit tests green
npm --workspace @bodhiapp/bodhi-pi-web run test:e2e    # 3 specs green incl. reload
npm run check
```

### Acceptance gate — M6

User chats, reloads the tab, and the conversation reappears. `/sessions` lists the session. Two browser tabs hold independent sessions (sessionStorage is per-tab).

### Commit

`feat(bodhi-pi-browser): land M6 — Dexie session store with reload-resume`

---

## M7 — ZenFS over Chrome FSA + IndexedDB handle persistence + DirectoryGate

### Scope

Give the worker a real, persistent filesystem. On first run the user grants a folder via Chrome's `showDirectoryPicker()`. The handle is stored in IndexedDB (via `idb-keyval`) so subsequent reloads only need a permission re-check, not another picker. ZenFS wraps the handle with `@zenfs/dom`'s `WebAccess` backend, mounted at `/mnt/<handle.name>`. A new `<DirectoryGate>` shell shows the "Grant access" button before the chat is reachable.

### Mount-path tradeoffs (locked: `/mnt/<handle.name>`)

| Option | Pros | Cons |
|---|---|---|
| **`/mnt/<handle.name>`** ← chosen | matches web-acp; leaves `/` free for multi-mount; status bar shows readable name | not the "real" local path |
| `/Users/<user>/Documents/...` | matches a user's mental model | **not possible** — Chrome FSA hides absolute paths by spec; only `handle.name` (basename) is exposed |
| `/work` (fixed) | simplest; predictable for tools | breaks if multi-mount lands later; `handle.name` info lost |

### Files (new) — `bodhi-pi-browser`

```
packages/bodhi-pi-browser/src/
├─ filesystem/
│   ├─ zenfs-filesystem.ts             # createZenfsFilesystem({ rootPath, fs }): bodhi-pi Filesystem
│   ├─ fsa-handle-store.ts             # idb-keyval wrappers (load/save/clear/queryPermission/requestPermission)
│   ├─ web-access-mount.ts             # mountFsaHandle({ handle, mountName }): { fs, rootPath } via @zenfs/dom
│   ├─ in-memory-mount.ts              # mountInMemorySeed({ files, mountName }): { fs, rootPath } for tests
│   └─ zenfs-filesystem.test.ts        # vitest happy-dom (or fake-indexeddb + zenfs InMemory)
└─ index.ts                              # export the four new factories
```

### Files (new) — `bodhi-pi-web`

```
packages/bodhi-pi-web/src/
├─ ui/DirectoryGate.tsx                # boot gate UI (Grant button, status text)
├─ ui/DirectoryStatus.tsx              # top-bar pill showing /mnt/<name>
└─ workspace/
    ├─ types.ts                        # WorkspaceConfig: { mountName, rootPath, source: "fsa"|"seed" }
    └─ bootstrap.ts                    # main-thread: read seed | read handle | run picker | request permission
```

### Files (modified)

- `packages/bodhi-pi-browser/package.json` — add `@zenfs/core`, `@zenfs/dom`, `idb-keyval`.
- `packages/bodhi-pi-web/src/agent/types.ts` — `InitMessage.workspace: { mountName, rootPath, mode: "fsa" | "memory", handle?: FileSystemDirectoryHandle, seed?: { files: Record<string,string> } }`. Handle structured-clones across postMessage natively.
- `packages/bodhi-pi-web/src/agent/worker.ts` — swap `createInMemoryFilesystem()` → either `mountFsaHandle({ handle, mountName })` or `mountInMemorySeed({ files, mountName })`, then `createZenfsFilesystem({ rootPath, fs })`. The `cwd` used in `newSession`/`loadSession` is now `workspace.rootPath`, replacing hardcoded `"/"`.
- `packages/bodhi-pi-web/src/ui/RuntimeProvider.tsx` — block on workspace bootstrap before spawning the worker. `<DirectoryGate>` rendered when no handle/seed; chat surface unmounted until the workspace is ready.
- `packages/bodhi-pi-web/src/store/chatStore.ts` — add `mountPath: string` for status display.
- `packages/bodhi-pi-web/src/ui/StatusBar.tsx` — show `/mnt/<name>`.
- `packages/bodhi-pi-web/vite.config.ts` — `optimizeDeps.exclude: ["@zenfs/core", "@zenfs/dom"]` if rolldown chokes on their CJS detection.

### Boot flow (production)

1. `bootstrap()` (main thread): `loadHandle()` from `idb-keyval` (key `"bodhi-pi-web:dir-handle"`).
2. If handle exists: `queryPermission({ mode: "readwrite" })`.
   - `"granted"` → use handle.
   - `"prompt"`/`"denied"` → render `<DirectoryGate>` with "Re-grant" button → `handle.requestPermission(...)` on click.
3. If no handle: render `<DirectoryGate>` with "Pick folder" button → `showDirectoryPicker({ mode: "readwrite" })` on click → `saveHandle()`.
4. Once granted: `RuntimeProvider` spawns the worker with `InitMessage.workspace.handle = <handle>`, mountName = `handle.name`.

### Boot flow (Playwright)

`addInitScript` injects `window.__bodhiPiWebSeed = { name, files: { "/path": "content" } }` before page load. `bootstrap()` reads it, skips picker/IndexedDB, returns `{ mode: "memory", seed: ... }`. Worker mounts ZenFS `InMemory` and seeds files.

### `createZenfsFilesystem({ rootPath, fs })` shape

Implements the bodhi-pi `Filesystem` interface (`packages/bodhi-pi/src/filesystem/filesystem.ts:12-33`) by delegating to ZenFS's `fs.promises.*`:

| `Filesystem` | ZenFS |
|---|---|
| `readTextFile(p)` | `fs.promises.readFile(p, "utf-8")` |
| `writeTextFile(p, c)` | `fs.promises.writeFile(p, c, "utf-8")` |
| `list(p)` | `fs.promises.readdir(p, { withFileTypes: true })` → `DirEntry[]` |
| `stat(p)` | `fs.promises.stat(p)` → `{ isFile, isDirectory, size, mtimeMs }` |
| `exists(p)` | wrap `fs.promises.access` try/catch → false |
| `mkdir(p, opts)` | `fs.promises.mkdir(p, { recursive })` |
| `remove(p, opts)` | `fs.promises.rm(p, { recursive, force: true })` |

### TDD — M7

#### Integration — `bodhi-pi-browser/src/filesystem/zenfs-filesystem.test.ts`

Use ZenFS's `InMemory` backend (no FSA needed; same code path as the test seed). Mirror bodhi-pi's `test/fs.test.ts` shape:
- read/write/edit round-trip
- list lists directory entries (DirEntry shape)
- stat returns FileStat
- mkdir recursive idempotent
- remove recursive
- exists never throws

#### E2E — new `e2e/workspace.spec.ts`

```ts
import { seedWorkspace } from "./helpers/seed";

test("M7 workspace mounts seeded folder; chat reaches idle", async ({ page, chat }) => {
  await seedWorkspace(page, { name: "demo", files: { "/readme.txt": "hello world" } });
  await chat.goto();
  await chat.waitForState("idle", 60_000);
  await expect(chat.statusBar).toContainText("/mnt/demo");
});

test("M7 DirectoryGate appears when no seed/handle present", async ({ page, chat }) => {
  // No seed injection. (handle won't exist either since this is a fresh browser.)
  await chat.goto();
  await expect(page.getByTestId("directory-gate")).toBeVisible();
  await expect(page.getByTestId("directory-gate-pick")).toBeVisible();
});
```

`e2e/helpers/seed.ts` ports web-acp's `installVolumes` shape — `page.addInitScript((seed) => { window.__bodhiPiWebSeed = seed }, { name, files })`.

### Verification

```bash
npm --workspace @bodhiapp/bodhi-pi-browser run test
npm --workspace @bodhiapp/bodhi-pi-web run test:e2e   # adds workspace.spec.ts
npm run check
# Manual smoke: open http://localhost:35173, click Grant, pick a folder, refresh, observe /mnt/<name> in status bar
```

### Acceptance gate — M7

Two paths green: (a) Playwright with seeded in-memory mount renders chat in `/mnt/demo`; (b) manual real-FSA flow grants a real folder, reload reuses the same handle without re-prompting (until permission lapses).

### Commit

`feat(bodhi-pi-browser): land M7 — ZenFS over Chrome FSA with persistent handle`

---

## M8 — Built-in FS tools rendering + e2e

### Scope

bodhi-pi already registers `read`/`write`/`edit`/`ls`/`find`/`grep` whenever a `Filesystem` is provided (`packages/bodhi-pi/src/tools/index.ts:19-32`). With M7 they finally have a real FS to operate on. M8 lifts the rendering of `tool_call` / `tool_call_update` notifications from the M3 system-message mush into a dedicated `<ToolCallCard>` component and adds a focused e2e spec exercising the round-trip.

### Files (new)

```
packages/bodhi-pi-web/src/ui/
├─ ToolCallCard.tsx                    # data-testid="tool-call" data-tool-name=... data-tool-status=...
└─ ToolCallList.tsx                    # interleaves tool calls into the message stream
```

### Files (modified)

- `packages/bodhi-pi-web/src/store/chatStore.ts` — add `toolCalls: Map<id, ToolCall>` plus actions `addToolCall`, `updateToolCall`. Interleave with messages via a single `entries` array if needed.
- `packages/bodhi-pi-web/src/agent/render.ts` — replace the M3 system-message synthesis for tool events with `addToolCall` / `updateToolCall` dispatches.
- `packages/bodhi-pi-web/src/ui/MessageList.tsx` — render `ToolCallCard` between messages by id ordering.
- `packages/bodhi-pi-web/e2e/pages/ChatPage.ts` — add `toolCalls()` locator, `lastToolCall(name?)`, `waitForToolCall({ name, status })` helpers.

### `<ToolCallCard>` testability contract

```html
<div
  data-testid="tool-call"
  data-tool-name="read"
  data-tool-status="running|completed|failed"
  data-tool-call-id="<id>"
>
  <span class="tool-call-name">read</span>
  <span class="tool-call-title">read /mnt/demo/readme.txt</span>
  <pre class="tool-call-preview">…</pre>  <!-- shown on completed -->
</div>
```

### TDD — M8

#### E2E — new `e2e/fs-tools.spec.ts`

Mirrors `bodhi-pi/e2e/fs.e2e.ts`'s "Haiku writes then reads" shape, against `gpt-4o-mini`:

```ts
test("M8 agent writes a file, reads it back", async ({ page, chat }) => {
  await seedWorkspace(page, { name: "demo", files: {} });
  await chat.goto(); await chat.waitForState("idle", 60_000);

  await chat.send("Use the write tool to create /mnt/demo/poem.txt with the content 'roses are red'. Then use the read tool to read it. Finally, reply with the file's content verbatim.");
  await chat.waitForState("streaming");
  await chat.waitForState("idle", 60_000);

  // tool calls observable
  await expect(chat.toolCalls()).toContainText("write");
  await expect(chat.toolCalls()).toContainText("read");
  // completed status
  await expect(chat.lastToolCall("read")).toHaveAttribute("data-tool-status", "completed");
  // assistant echoes content
  expect((await chat.lastMessage("assistant")).toLowerCase()).toContain("roses are red");
});

test("M8 agent greps seeded files", async ({ page, chat }) => {
  await seedWorkspace(page, { name: "demo", files: {
    "/notes/a.md": "# A\nthe codeword is parrot",
    "/notes/b.md": "# B\njust a draft",
  }});
  await chat.goto(); await chat.waitForState("idle", 60_000);
  await chat.send("Use grep to find the codeword in /mnt/demo/notes. Reply with the codeword only.");
  await chat.waitForState("idle", 60_000);
  await expect(chat.toolCalls()).toContainText("grep");
  expect((await chat.lastMessage("assistant")).toLowerCase()).toContain("parrot");
});
```

### Verification

```bash
npm --workspace @bodhiapp/bodhi-pi-web run test:e2e   # 5 specs total green
npm run check
```

### Acceptance gate — M8

Tool calls render as distinct cards. Two specs prove the agent uses the FS tools end-to-end against a seeded ZenFS mount with real OpenAI.

### Commit

`feat(bodhi-pi-web): land M8 — tool-call cards and FS tools e2e`

---

## M9 — Project slash commands (`.bodhi-pi/commands/*.md`)

### Scope

bodhi-pi's command discovery (`packages/bodhi-pi/src/commands/discovery.ts:loadProjectCommands`) already runs at session hydration whenever a `Filesystem` is provided and emits `available_commands_update` notifications. M4 already plumbs those into the chat store and `/help`. The work in M9 is purely test-side: seed `.bodhi-pi/commands/*.md` files in the e2e workspace and prove the round-trip.

### Files (modified)

- `packages/bodhi-pi-web/e2e/helpers/seed.ts` — add `seedCommand({ name, description, body, argHint? })` helper that writes a properly-frontmattered file under `<root>/.bodhi-pi/commands/<name>.md`.
- `packages/bodhi-pi-web/e2e/pages/ChatPage.ts` — already has `availableCommands` access via UI; add a `waitForCommand(name)` helper that polls the chat-page DOM for an attribute reflecting commands count, OR just sends `/help` and asserts on the system message.

### Why no new bodhi-pi-web source

M4 already handles command routing: if `cmdName` is in `availableCommands` (which is populated by the `available_commands_update` notification render path), the prompt is forwarded to the agent verbatim. Bodhi-pi expands the template before the LLM sees it. We just need files.

### TDD — M9

#### E2E — new `e2e/commands.spec.ts`

Mirrors `bodhi-pi/e2e/commands.e2e.ts:43-88`:

```ts
test("M9 /<known> arg expands $1 and reaches the model", async ({ page, chat }) => {
  await seedWorkspace(page, {
    name: "demo",
    files: {
      "/.bodhi-pi/commands/echo.md": [
        "---",
        "description: Echo a word",
        "argument-hint: <word>",
        "---",
        "Reply with exactly the single word: $1",
        "And nothing else.",
      ].join("\n"),
    },
  });
  await chat.goto(); await chat.waitForState("idle", 60_000);

  // /help should now list "echo" alongside local commands.
  await chat.send("/help");
  await expect(chat.messages("system").last()).toContainText("echo");

  await chat.send("/echo banana");
  await chat.waitForState("idle", 60_000);
  expect((await chat.lastMessage("assistant")).toLowerCase()).toContain("banana");
});

test("M9 /<unknown> passes through verbatim", async ({ page, chat }) => {
  await seedWorkspace(page, { name: "demo", files: {} });
  await chat.goto(); await chat.waitForState("idle", 60_000);
  await chat.send("/totally-not-a-command Reply with: gravy");
  await chat.waitForState("idle", 60_000);
  expect((await chat.lastMessage("assistant")).toLowerCase()).toContain("gravy");
});
```

### Acceptance gate — M9

Project commands discovered, advertised in `/help`, and routed to the agent for expansion. Live LLM follows the expanded prompt.

### Commit

`feat(bodhi-pi-web): land M9 — project slash commands via .bodhi-pi/commands`

---

## M10 — Markdown skills (`.bodhi-pi/skills/<name>/SKILL.md`)

### Scope

Same shape as M9, but for skills. bodhi-pi's `loadProjectSkills` (`packages/bodhi-pi/src/skills/discovery.ts:46-75`) discovers `<root>/.bodhi-pi/skills/<name>/SKILL.md`, augments the system prompt with `<available_skills>` (`src/skills/system-prompt.ts`), and `expandSkillCommand` wraps `/skill:<name> args` in a `<skill name="..." location="...">…</skill>` XML block (`src/skills/invocation.ts`). All this runs server-side (in the worker) automatically. Web work is again test-only.

### Files (modified)

- `packages/bodhi-pi-web/e2e/helpers/seed.ts` — add `seedSkill({ name, description, body, hidden? })` writing `<root>/.bodhi-pi/skills/<name>/SKILL.md`.

### TDD — M10

#### E2E — new `e2e/skills.spec.ts`

Mirrors `bodhi-pi/e2e/skills.e2e.ts:28`:

```ts
test("M10 /skill:<name> wraps body and reaches the model", async ({ page, chat }) => {
  await seedWorkspace(page, {
    name: "demo",
    files: {
      "/.bodhi-pi/skills/pirate/SKILL.md": [
        "---",
        "description: Reply like a pirate",
        "---",
        "When asked, reply with: AHOY $@",
      ].join("\n"),
    },
  });
  await chat.goto(); await chat.waitForState("idle", 60_000);

  // /help should advertise skill:pirate.
  await chat.send("/help");
  await expect(chat.messages("system").last()).toContainText("skill:pirate");

  await chat.send("/skill:pirate matey");
  await chat.waitForState("idle", 60_000);
  expect((await chat.lastMessage("assistant"))).toMatch(/AHOY/i);
});
```

### Acceptance gate — M10

Skills discovered, advertised, and expanded into `<skill>` XML on `/skill:<name>` invocation. Live LLM follows the wrapped instructions.

### Commit

`feat(bodhi-pi-web): land M10 — markdown skills via .bodhi-pi/skills`

---

## M11 — Browser ScriptExecutor + scripted skill

### Scope

Add `createBrowserScriptExecutor({ filesystem })` to `bodhi-pi-browser`. AsyncFunction-based per the original M1–M5 plan: read script via the injected `Filesystem`, wrap as `new AsyncFunction("args", "cwd", "console", code)`, run, capture `console.log` → stdout buffer, `console.error` → stderr buffer, exit code 0 on normal return, 1 on throw. Wire into the worker so `run_script` is registered (bodhi-pi's `createBuiltinTools` adds it only when `scriptExecutor` is present per `tools/index.ts:28-30`).

Then port bodhi-pi's `days-since-birthday` scripted skill verbatim (`packages/bodhi-pi/e2e/scripted-skill.e2e.ts`) and prove the round-trip end-to-end.

### Files (new)

```
packages/bodhi-pi-browser/src/script-executor/
├─ browser-script-executor.ts          # createBrowserScriptExecutor({ filesystem })
└─ browser-script-executor.test.ts     # vitest happy-path + timeout + throw + missing file
```

### Files (modified)

- `packages/bodhi-pi-browser/src/index.ts` — export `createBrowserScriptExecutor`.
- `packages/bodhi-pi-web/src/agent/worker.ts` — pass `scriptExecutor: createBrowserScriptExecutor({ filesystem })` to `createBodhiPiAgent`.
- `packages/bodhi-pi-web/e2e/helpers/seed.ts` — `seedSkillWithScript({ name, body, scriptName, scriptCode })`.

### Convention (locked)

The script body is the body of an `AsyncFunction` with `args: string[]`, `cwd: string`, and a custom `console` in scope:

```ts
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const stdout: string[] = []; const stderr: string[] = [];
const fakeConsole = {
  log: (...a: unknown[]) => stdout.push(a.map(fmt).join(" ") + "\n"),
  error: (...a: unknown[]) => stderr.push(a.map(fmt).join(" ") + "\n"),
};
const code = await filesystem.readTextFile(scriptPath);
const fn = new AsyncFunction("args", "cwd", "console", code);
try {
  await (timeout
    ? Promise.race([fn(args, cwd, fakeConsole), rejectAfter(timeout)])
    : fn(args, cwd, fakeConsole));
  return { stdout: stdout.join(""), stderr: stderr.join(""), exitCode: 0 };
} catch (err) {
  return { stdout: stdout.join(""), stderr: stderr.join("") + String(err), exitCode: 1 };
}
```

This matches the test-helper executor in `packages/bodhi-pi/test/helpers/script-executor.ts` and is the same posture as the cli's Node-spawn executor: scripts come from project disk, no extra sandbox.

### TDD — M11

#### Integration (`browser-script-executor.test.ts`)

Mirror `packages/bodhi-pi/test/run-script.test.ts`:
- happy path: script logs and returns exit 0
- script throws → exit 1, error in stderr
- timeout enforced via `Promise.race`
- missing script file → exit 1 with error message
- args + cwd available in script scope

#### E2E — new `e2e/scripted-skill.spec.ts`

Port `bodhi-pi/e2e/scripted-skill.e2e.ts` verbatim (the `days-since-birthday` skill):

```ts
test("M11 scripted skill: days-since-birthday calls run_script and reports the integer", async ({ page, chat }) => {
  await seedWorkspace(page, {
    name: "demo",
    files: {
      "/.bodhi-pi/skills/days-since-birthday/SKILL.md": [
        "---",
        "description: Compute days between a YYYY-MM-DD birthday and 2026-05-08.",
        "---",
        "You have a JavaScript helper at ${SKILL_DIR}/script.js.",
        "Call run_script with path: \"${SKILL_DIR}/script.js\" and args: [\"<YYYY-MM-DD>\"].",
        "Reply with exactly that integer and nothing else.",
      ].join("\n"),
      "/.bodhi-pi/skills/days-since-birthday/script.js": [
        "const baseline = Date.UTC(2026, 4, 8);",
        "const ms = baseline - new Date(args[0] + 'T00:00:00Z').getTime();",
        "console.log(Math.floor(ms / 86400000));",
      ].join("\n"),
    },
  });
  await chat.goto(); await chat.waitForState("idle", 60_000);
  await chat.send("/skill:days-since-birthday 2024-01-01");
  await chat.waitForState("idle", 60_000);
  await expect(chat.toolCalls()).toContainText("run_script");
  // 2024-01-01 → 2026-05-08 = 858 days
  expect((await chat.lastMessage("assistant"))).toContain("858");
});
```

### Verification

```bash
npm --workspace @bodhiapp/bodhi-pi-browser run test
npm --workspace @bodhiapp/bodhi-pi-web run test:e2e   # 7 specs total green
npm run check
```

### Acceptance gate — M11

`run_script` registered, scripted skill expands and executes end-to-end against real OpenAI, integer answer arrives.

### Commit

`feat(bodhi-pi-browser): land M11 — browser ScriptExecutor and scripted skills`

---

## Critical files (already in tree, do not modify)

These bodhi-pi surfaces light up automatically once `bodhi-pi-web` provides the right host services. M9-M11 do **not** add a single line of agent code:

| Path | Role |
|---|---|
| `packages/bodhi-pi/src/tools/index.ts:19-32` | `createBuiltinTools` registers six FS tools + optional `run_script` |
| `packages/bodhi-pi/src/commands/discovery.ts:47-74` | `loadProjectCommands` walks `.bodhi-pi/commands/*.md` |
| `packages/bodhi-pi/src/commands/prompt-templates.ts:81-93` | `expandPromptTemplate` substitutes `$1`, `$@`, `${@:N:L}` |
| `packages/bodhi-pi/src/skills/discovery.ts:46-75` | `loadProjectSkills` walks `.bodhi-pi/skills/<name>/SKILL.md` |
| `packages/bodhi-pi/src/skills/system-prompt.ts:20-35` | `formatSkillsForPrompt` builds `<available_skills>` block |
| `packages/bodhi-pi/src/skills/invocation.ts:14-27` | `expandSkillCommand` wraps `/skill:<name> args` in `<skill>` XML |
| `packages/bodhi-pi/src/script-executor/script-executor.ts` | `ScriptExecutor` interface |
| `packages/bodhi-pi/src/acp/agent.ts:445-477` | `_buildSessionState` rewires tools/commands/skills on `newSession`/`loadSession` |

### Reference patterns (to copy, not import)

| Path | Use |
|---|---|
| `BodhiSearch/web-acp/src/runtime/volumes-fsa/backends.ts` | `WebAccess.create({ handle })` + `InMemory.create()` seed pattern |
| `BodhiSearch/web-acp/src/vault/fsa-handle-store.ts` | idb-keyval `loadHandles` / `saveHandles` / `requestPermissions` |
| `BodhiSearch/web-acp/e2e/helpers/install-volumes.ts` | `addInitScript` seed pattern for Playwright |
| `BodhiSearch/web-acp/src/runtime/storage-dexie/db.ts` | Dexie schema rationale (entries-as-JSON) |
| `packages/bodhi-pi-cli/test/helpers/cli-harness.ts` | seed-driven harness shape for tools/commands/skills tests |
| `packages/bodhi-pi/test/helpers/script-executor.ts` | reference unsandboxed AsyncFunction executor for M11 |

## Risks per milestone

- **M6** — Dexie schema migrations: we ship a single `version(1)` and never re-shape. Future schema changes get a v2 upgrade callback. Empty/missing IndexedDB is fine; first-run seeds via `create()`.
- **M6** — sessionStorage clearing across browsers: stored ID may point at a session deleted in another tab. `loadSession` rejects on unknown ID; we fall back to `newSession` — no user-visible breakage.
- **M7** — `@zenfs/dom` `WebAccess` async behavior: ZenFS' Node-fs surface is sync-ish; `WebAccess` is async-only. bodhi-pi's `Filesystem` interface is fully async, so the adapter is straight passthrough. Verify `fs.promises.readFile` returns a string with `"utf-8"` encoding — fall back to `Buffer.toString("utf-8")` if not.
- **M7** — handle structured-clone across `postMessage` to worker: confirmed working in web-acp; FSA handles are explicitly cloneable per spec. If not, fallback is to mount on main thread + RPC fs operations over postMessage (much more invasive).
- **M7** — Playwright + FSA: web search confirmed there's no clean CDP/Playwright bypass. The seed-injection pattern is the canonical solution.
- **M8** — pi-ai LLM may not consistently call tools when prompted; harden prompts ("Use the write tool …") and accept some flakiness in CI; gpt-4o-mini is reliable enough at this scale.
- **M9/M10** — bodhi-pi's discovery walks the FS once at session hydration. After `seedWorkspace` we must NOT race with `newSession`. The bootstrap already gates on workspace ready before runtime starts, so the order is fine.
- **M11** — `AsyncFunction` requires `unsafe-eval` CSP. Vite dev/preview have no CSP by default. Document a CSP requirement for production deploys.

## Out of scope (deferred)

| Concern | When |
|---|---|
| Multi-volume mounts (cwd switching, `<VolumesPanel>`) | post-M11 |
| Multi-provider model registry (Anthropic, Gemini) | small follow-up; pi-ai already supports |
| Sessions sidebar UI | post-v1 polish |
| `systemPrompt` config field exposed in UI | small follow-up |
| Cancel/abort button | small follow-up wired through `conn.cancel` |
| Image input / multimodal | post-v1 |
| MCP servers | requires WebSocket bridge in worker |
| Permissions UI (`requestPermission` modal) | post-v1 |
| Mobile / responsive layout | post-v1 polish |

## Verification (post-M11)

```bash
# unit + integration tests across all browser packages
npm --workspace @bodhiapp/bodhi-pi-browser run test

# all e2e specs against real OpenAI gpt-4o-mini
npm --workspace @bodhiapp/bodhi-pi-web run test:e2e

# repo-wide hygiene
npm run check

# manual smoke (real Chrome FSA picker)
cd packages/bodhi-pi-web && npm run dev
# → grant a folder, refresh, observe /mnt/<name> persists; type "list files in /mnt/<name>"
```

End state: 7 e2e specs (M3 chat · M4 model-switch · M5 sessions+reload · M7 workspace · M8 fs-tools · M9 commands · M10 skills · M11 scripted-skill) all green against live `gpt-4o-mini`. The browser host has parity with bodhi-pi-cli on every feature bodhi-pi exercises in its own e2e suite.
