# bodhi-pi WS-server PoC: M6–M10 — workspace fixtures + bodhi-pi-web spec parity

## Context

M1–M5 of this PoC shipped a working WS-hosted multi-user agent (subprotocol bearer auth, per-user SQLite isolation, streaming UI with tool-call cards, session sidebar). Five Playwright e2e specs are green: handshake, prompt round-trip, tool-call rendering, multi-session create/list. Backend: 22 unit/integration tests.

The next gap is **bodhi-pi-web parity for filesystem-dependent features**. bodhi-pi-web has 10 specs that prove project-level slash commands, skills, scripted skills, extensions, fs tools, workspace bootstrap, and the event lifecycle — all driven by files under `<workspace>/.bodhi-pi/{commands,skills,extensions}/`. ws-frontend has zero of these. Closing that gap is what this plan covers.

The bodhi-pi agent already auto-scans `.bodhi-pi/{commands,skills}/` from its `cwd` (via `loadProjectCommands` and `loadProjectSkills` in `_buildSessionState` at `packages/bodhi-pi/src/acp/agent.ts:657-658`, called from `newSession`/`loadSession`). So once fixture files land in the agent's cwd, those features just work. **Extensions** are different — they require `createNodeExtensionLoader({ cwd })` to be plumbed through `extensionFactories`, which ws-server currently does not do.

The user's brief: spin up ws-server on a random port pre-loaded with a fixture workspace, set the frontend's backend URL to that port, drive the UI to prove each feature. Slash commands replace buttons so the same composer-driven flow tests cli, web, and ws-frontend uniformly.

## Scope decisions (locked)

| # | Decision | Notes |
|---|---|---|
| 1 | **`--workspace <dir>` CLI flag on ws-server** | Single-tenant override. When set, every connecting user uses `<dir>` as their cwd, bypassing `ensureUserWorkspace`. Mirrors `bodhi-pi-cli`'s `--cwd <path>`. Multi-tenant DB isolation (M3) still active; only FS is shared. |
| 2 | **`--port <n>` CLI flag on ws-server** | Defaults to env `PORT`, then 8788. Tests pass `--port 0` to bind a random free port; helper reads `httpServer.address().port` and returns the URL. |
| 3 | **Per-WS-connection extension loading** | `wireAgentForConnection` calls `await createNodeExtensionLoader({ cwd })` and passes the result as `extensionFactories` to `createBodhiPiAgent`. One I/O hit per connect; each connection sees the cwd's `.bodhi-pi/extensions/`. |
| 4 | **Frontend Settings gains a `Server URL` field** | Persisted to localStorage alongside email/id/sendToken. Default `ws://localhost:8788/agent`. Tests fill this with the spawned-server URL before connecting. |
| 5 | **Slash commands replace buttons** | `+ New`, session-load (click row), session-delete (✕), Disconnect — all gone. Composer-typed slash commands (`/new`, `/sessions`, `/resume <id>`, `/delete <id>`, `/help`, `/model [id]`, `/close`) drive the same flows. Uniformity with cli + web. |
| 6 | **Built-in vs project commands** | Built-ins handled locally by a `commands.ts` dispatcher (lifted from `packages/bodhi-pi-web/src/ui/commands.ts`). Project commands (announced via `available_commands_update`) forward as prompts so bodhi-pi expands them on the agent side. |
| 7 | **Fixtures live at `packages/bodhi-pi-ws-frontend/e2e/data/<scenario>/`** | Mirror the relevant scenarios from `bodhi-pi-web/e2e/data/`. `loadScenario(name)` walks the dir → flat `Record<seedPath, utf8>`. Each frontend stays independently runnable; drift accepted. |
| 8 | **`spawnTestServer({ scenario })` helper** | Per-test or per-spec: mkdtemp → write fixture files → spawn `node dist/index.js --workspace <tmp> --port 0` as a child process → wait for `/healthz` → return `{ url, cleanup }`. Frontend's playwright `webServer` stays for the Vite dev process; the backend is spawned per test. |
| 9 | **5 milestones M6–M10** | Same shippable-slice cadence as web-m1-to-m5.md. Each milestone has unit/integration + a single Playwright spec ported from bodhi-pi-web. |

## Out of scope

- `cross-provider.spec.ts` (multi-provider config) — defer.
- `tool-failure.spec.ts`, `tool-replay.spec.ts`, `model-persists.spec.ts` — these are not fixture-dependent; once M7 lands slash commands they can ride alongside but are not gated by this plan.
- Real JWT signing, OAuth, server clustering, sticky sessions, hot-cache TTL — same as M1–M5 plan.
- Worker-side ZenFS-style in-memory FS abstractions — server uses real disk, not in-memory.

## Architecture changes

### ws-server CLI surface

```
$ bodhi-pi-ws-server --workspace <dir> --port <n>
```

- **Without `--workspace`**: existing behavior. `<dataDir>/users/<id>/workspace/` per user.
- **With `--workspace <dir>`**: every connection uses `<dir>` as cwd. `ensureUserWorkspace` short-circuits.
- **`--port 0`**: bind random free port; print actual port to stdout for the helper to grep.

### Per-connection extension loading

`wire-agent.ts` becomes:

```ts
const cwd = workspaceOverride ?? ensureUserWorkspace(dataDir, user.id);
const filesystem = createNodeFilesystem({ rootCwd: cwd });
const sessionStore = createSqliteSessionStore({ db, userId: user.id });
const extensionFactories = await createNodeExtensionLoader({ cwd });  // NEW
return createBodhiPiAgent({ models, defaultModelId, getApiKey, sessionStore, filesystem,
  ...(extensionFactories.length > 0 ? { extensionFactories } : {}) });
```

### Frontend slash-command dispatcher

Lift `packages/bodhi-pi-web/src/ui/commands.ts` (verbatim where possible). On send:

1. If composer text starts with `/` AND first token is in `BUILTIN_COMMANDS` → run local handler (calls `conn.newSession`, `(conn as any).loadSession`, `conn.extMethod`, `conn.setSessionConfigOption`).
2. If first token is in `availableCommands` (announced by agent) → forward as prompt; agent expands.
3. Otherwise → forward as prompt unchanged.

Result: removing buttons is a net code DELETION on App.tsx — sidebar buttons collapse into a passive `Sessions` list rendered for visibility but click-handlers go away in favour of the composer.

### Test infrastructure

```
packages/bodhi-pi-ws-frontend/e2e/
  helpers/
    seed.ts            # NEW — loadScenario(name) walks data/<name>/ → Record<path, utf8>
    spawn-server.ts    # NEW — spawnTestServer({ scenario }) → { url, cleanup }
  data/                # NEW — fixture trees (mirrored from bodhi-pi-web/e2e/data/)
    commands-echo/
    commands-say-tuesday/
    skills-say-hello/
    skills-days-since-birthday/
    extensions-redact-secrets/
    fs-tools-{notes-edit,notes-ls,docs-find}/
    workspace-readme/
  fixtures.ts          # extended — `serverUrl` + `scenario` test options + `app` fixture wires them
  pages/AppPage.ts     # extended — setServerUrl(), send already exists, remove sessionRows/clickNewSession
  m{6..10}-*.spec.ts   # NEW — port from bodhi-pi-web/e2e/<spec>.spec.ts
```

### Frontend playwright.config.ts

- Drops the ws-server entry from `webServer` array (servers are spawned per test in fixtures).
- Keeps the Vite frontend dev server (still hardcoded port).
- Each spec spawns its own ws-server via `spawnTestServer({ scenario })` returned by the `app` fixture.

## Critical files referenced

| Path | Why |
|---|---|
| `packages/bodhi-pi/src/acp/agent.ts:657-658` | confirms `loadProjectCommands` + `loadProjectSkills` auto-scan from `cwd` on every newSession/loadSession |
| `packages/bodhi-pi-node/src/extensions/node-extension-loader.ts` | `createNodeExtensionLoader({ cwd })` returns `RegisteredExtension[]` |
| `packages/bodhi-pi-cli/src/cli.ts:13-23` | reference for wiring extension loader into `createBodhiPiAgent` |
| `packages/bodhi-pi-cli/src/config.ts:94-102` | reference for `--cwd <path>` arg parsing |
| `packages/bodhi-pi-web/e2e/helpers/seed.ts:44-59` | `loadScenario(name)` recursive walk implementation to mirror |
| `packages/bodhi-pi-web/e2e/data/<scenario>/` | fixture trees to copy verbatim |
| `packages/bodhi-pi-web/src/ui/commands.ts` | slash-command dispatcher to lift |
| `packages/bodhi-pi-web/e2e/{commands,skills,scripted-skill,extensions,fs-tools,workspace,events}.spec.ts` | per-milestone porting targets |
| `packages/bodhi-pi-ws-server/src/{server,index,filesystem/user-workspace,agent/wire-agent}.ts` | files modified by M6 |
| `packages/bodhi-pi-ws-frontend/src/{App,hooks/useSettings}.tsx` | files touched by M6 (settings) and M7 (slash commands) |

---

## M6 — Test infrastructure: workspace flag + serverUrl + extension loader

**Scope.** ws-server gains `--workspace <dir>` and `--port <n>` flags. `wireAgentForConnection` plumbs `createNodeExtensionLoader`. Frontend Settings gains a `Server URL` text input persisted to localStorage; `connect()` uses it. New e2e helpers `loadScenario` and `spawnTestServer`. **No specs ported in M6** — gate is a smoke spec proving the helper boots a per-test server and connects through it.

**Files.**

| Path | Change |
|---|---|
| `packages/bodhi-pi-ws-server/src/cli-args.ts` | NEW — `parseArgs(argv)` returns `{ port?, workspace?, dataDir? }` (hand-rolled, no `commander`) |
| `packages/bodhi-pi-ws-server/src/index.ts` | call `parseArgs`; pass `workspaceOverride`, `port` to `buildServer`; print actual port after listen |
| `packages/bodhi-pi-ws-server/src/server.ts` | `BuildServerOptions` gains `workspaceOverride?: string` and accepts `port?: number \| 0`; threads `workspaceOverride` to `wireAgentForConnection` |
| `packages/bodhi-pi-ws-server/src/agent/wire-agent.ts` | `WireAgentOptions` gains `workspaceOverride?: string` and `extensionFactories?: RegisteredExtension[]`; resolves cwd as `workspaceOverride ?? ensureUserWorkspace(...)`; forwards `extensionFactories` |
| `packages/bodhi-pi-ws-server/src/filesystem/user-workspace.ts` | export `resolveUserWorkspace(opts: { dataDir, userId, workspaceOverride? })` — single seam |
| `packages/bodhi-pi-ws-server/test/helpers/test-server.ts` | extend with `workspaceOverride?: string` option for unit/integration |
| `packages/bodhi-pi-ws-server/test/cli-args.test.ts` | NEW — unit tests for parseArgs (positive, negative, defaults) |
| `packages/bodhi-pi-ws-server/test/workspace-override.test.ts` | NEW — integration: spawn server with `workspaceOverride: <tmp>`, write `/.bodhi-pi/commands/foo.md` to that tmp, connect as user 99, assert `available_commands_update` advertises `foo` |
| `packages/bodhi-pi-ws-frontend/src/hooks/useSettings.ts` | add `serverUrl: string` (default `ws://localhost:8788/agent`) |
| `packages/bodhi-pi-ws-frontend/src/App.tsx` | render `data-testid="settings-serverUrl"` input; `connect()` reads `settings.serverUrl` |
| `packages/bodhi-pi-ws-frontend/e2e/helpers/seed.ts` | NEW — `loadScenario(name)` (mirror `bodhi-pi-web/e2e/helpers/seed.ts:44-59`) |
| `packages/bodhi-pi-ws-frontend/e2e/helpers/spawn-server.ts` | NEW — `spawnTestServer({ scenario })`: mkdtemp, write seed via `loadScenario`, spawn `node dist/index.js --workspace <tmp> --port 0` (or `tsx src/index.ts ...` in dev), capture port from stdout, return `{ url, cleanup }` |
| `packages/bodhi-pi-ws-frontend/e2e/fixtures.ts` | extend `AppFixtures` with `serverUrl: string` and `scenario: string \| undefined`; the `app` fixture spawns a server when `scenario` is set, points settings at the URL |
| `packages/bodhi-pi-ws-frontend/e2e/pages/AppPage.ts` | `setSettings()` accepts optional `serverUrl` |
| `packages/bodhi-pi-ws-frontend/playwright.config.ts` | drop ws-server from `webServer` array; keep Vite dev server only |
| `packages/bodhi-pi-ws-frontend/e2e/m6-spawn.spec.ts` | NEW — smoke: spawn server with empty workspace, set Server URL, connect, expect status=connected |
| `packages/bodhi-pi-ws-frontend/e2e/data/.gitkeep` | NEW — placeholder until M7 |
| `packages/bodhi-pi-ws-server/CLAUDE.md` | document `--workspace`, `--port`, extension-loader behavior |

**Implementation notes.**
- `parseArgs` returns `undefined` for missing args (no defaults at parse layer; `index.ts` applies env fallbacks). Throws on unknown flags.
- `--port 0` → `httpServer.listen(0)` already works (M1 test helper does this); index.ts prints `bodhi-pi-ws-server listening on http://localhost:<actualPort>` so spawn-server.ts can grep.
- spawn-server.ts uses `child_process.spawn` with `cwd: <ws-server-dir>` and `BODHI_PI_SERVER_DATA_DIR: <tmp>/data` env so each test owns DB + workspace under the same tmpdir.
- Existing M1–M5 e2e specs continue to use the global Vite dev server but won't auto-spawn a backend; they call `spawnTestServer({ scenario: undefined })` to get a default server. M6 reworks them to use the new fixture path; their assertions don't change.

**TDD / gate-check tests.**
- Unit: `cli-args.test.ts` (parseArgs).
- Integration: `workspace-override.test.ts` proves the `--workspace` override surfaces project commands via `available_commands_update`.
- Integration (existing): all 22 M3 backend tests still pass without change.
- E2E: `m6-spawn.spec.ts` spawns server, sets Server URL via Settings UI, connects, asserts `data-status=connected`. Existing M1/M2/M4/M5 e2e specs migrated to spawn-per-test.

```bash
npm run test -w bodhi-pi-ws-server
npx playwright test --reporter=line m6 -w bodhi-pi-ws-frontend
```

**Commit:** `feat(bodhi-pi-ws-server): M6 workspace flag, per-conn extension loader, e2e spawn helper`

---

## M7 — Slash-command parity + commands.spec.ts

**Scope.** Lift `bodhi-pi-web/src/ui/commands.ts` into ws-frontend. Compose all session-management flows (`/new`, `/sessions`, `/resume <id>`, `/delete <id>`, `/close`, `/model [id]`, `/help`) through the composer. **Remove the New/load/delete buttons** in App.tsx; the session sidebar becomes a passive list. Port `bodhi-pi-web/e2e/commands.spec.ts` to prove project-defined slash commands route through the agent.

**Files.**

| Path | Change |
|---|---|
| `packages/bodhi-pi-ws-frontend/src/ui/commands.ts` | NEW — built-in dispatcher; lift verbatim from `packages/bodhi-pi-web/src/ui/commands.ts` (drop FSA-specific bits like `/mount`) |
| `packages/bodhi-pi-ws-frontend/src/hooks/useChat.ts` | `send(text)` checks for leading `/`; routes via `commands.ts` if built-in or known project command (from `availableCommands`); falls through to `prompt` otherwise |
| `packages/bodhi-pi-ws-frontend/src/hooks/useChat.ts` | track `availableCommands` from `available_commands_update` notifications (mirror `dispatchNotification` from `bodhi-pi-web/src/agent/render.ts`) |
| `packages/bodhi-pi-ws-frontend/src/App.tsx` | remove `+ New`, `Disconnect`, `session-load`, `session-delete` buttons; sidebar list stays as `data-testid="session-row"` rows but no click handlers |
| `packages/bodhi-pi-ws-frontend/e2e/pages/AppPage.ts` | remove `clickNewSession`; `send()` becomes the universal driver; helper `runSlash(cmd)` for clarity |
| `packages/bodhi-pi-ws-frontend/e2e/m5-sessions.spec.ts` | rewrite to use `/new`, `/sessions`, `/delete <id>` slash commands instead of buttons |
| `packages/bodhi-pi-ws-frontend/e2e/data/commands-echo/.bodhi-pi/commands/echo.md` | NEW — fixture (verbatim from web) |
| `packages/bodhi-pi-ws-frontend/e2e/data/commands-say-tuesday/.bodhi-pi/commands/say-tuesday.md` | NEW — fixture (verbatim) |
| `packages/bodhi-pi-ws-frontend/e2e/m7-commands.spec.ts` | NEW — port from `bodhi-pi-web/e2e/commands.spec.ts`; uses `test.use({ scenario: { commandsEcho: true, commandsSayTuesday: true } })`-style merging |

**Implementation notes.**
- The bodhi-pi agent emits `available_commands_update` after newSession; useChat captures and stores. `send()` consults this list.
- `/quit` from bodhi-pi-cli is dropped (no terminal). `/mount` from bodhi-pi-web is dropped (no FSA picker; backend owns the mount).
- `/sessions` renders the list as a system message in the message stream (mirroring web's behavior). The sidebar continues to show the same data, double display is fine.
- Built-ins (handled locally) call: `conn.newSession`, `(conn as any).loadSession`, `conn.extMethod("_bodhi-pi/session/delete", ...)`, `conn.setSessionConfigOption`.

**TDD / gate-check tests.**
- E2E (existing): m5-sessions migrates to `/new` + `/sessions` slash commands; same assertion (count = 2 after two new sessions).
- E2E (new): `m7-commands.spec.ts` mirrors `bodhi-pi-web/e2e/commands.spec.ts`:
  - `/echo hello` → assistant message contains `hello` (placeholder expansion)
  - `/say-tuesday` → assistant message contains `tuesday`
  - unknown `/foo` → forwarded to LLM as prompt; assistant responds with text (LLM treats it as text)

```bash
OPENAI_API_KEY=… npx playwright test --reporter=line m7 -w bodhi-pi-ws-frontend
```

**Commit:** `feat(bodhi-pi-ws-frontend): M7 slash-command parity + commands.spec.ts`

---

## M8 — Skills + scripted skills

**Scope.** Port `skills.spec.ts` and `scripted-skill.spec.ts`. Skills work via the same auto-scan path as commands; scripted skills additionally need `ScriptExecutor`. **`createNodeScriptExecutor` is registered in this milestone** (M1 deferred it for security; the test-mode `--workspace` flag plus a tmpdir per test gives enough isolation for the PoC).

**Files.**

| Path | Change |
|---|---|
| `packages/bodhi-pi-ws-server/src/agent/wire-agent.ts` | + `scriptExecutor: createNodeScriptExecutor()` in BodhiPiConfig |
| `packages/bodhi-pi-ws-frontend/e2e/data/skills-say-hello/.bodhi-pi/skills/say-hello/SKILL.md` | NEW — fixture |
| `packages/bodhi-pi-ws-frontend/e2e/data/skills-days-since-birthday/.bodhi-pi/skills/days-since-birthday/SKILL.md` | NEW |
| `packages/bodhi-pi-ws-frontend/e2e/data/skills-days-since-birthday/.bodhi-pi/skills/days-since-birthday/script.js` | NEW — note web's web baked a `/mnt/demo/...` path; ws-server uses the actual workspace tmpdir, so the script reads relative paths or env |
| `packages/bodhi-pi-ws-frontend/e2e/m8-skills.spec.ts` | NEW — port from `bodhi-pi-web/e2e/skills.spec.ts` |
| `packages/bodhi-pi-ws-frontend/e2e/m8-scripted-skill.spec.ts` | NEW — port from `bodhi-pi-web/e2e/scripted-skill.spec.ts` |

**Implementation notes.**
- bodhi-pi-cli's e2e (`packages/bodhi-pi-cli/e2e/scripts.e2e.ts`) is the closer reference because it also uses Node's `createNodeScriptExecutor`. Mirror its prompt + assertion shape.
- Scripted skill fixture under `web/e2e/data/skills-days-since-birthday/` likely embeds a deterministic baseline date — copy verbatim, tweak only the `{SCRIPT_PATH}` template if any.
- Skills with `disable-model-invocation: true` should still surface in `/help`; spec asserts both visible-in-help AND invokable-via-`/skill:<name>`.

**TDD / gate-check tests.**
- E2E `m8-skills.spec.ts`: `/skill:say-hello` triggers a prompt that the model echoes; assistant output matches.
- E2E `m8-scripted-skill.spec.ts`: `/skill:days-since-birthday` triggers `run_script`; assistant reports an integer.
- Tool-call card with `data-tool-name="run_script"` and `data-tool-status="completed"` renders.

```bash
OPENAI_API_KEY=… npx playwright test --reporter=line m8 -w bodhi-pi-ws-frontend
```

**Commit:** `feat(bodhi-pi-ws-frontend): M8 skills + scripted skills`

---

## M9 — Project extensions

**Scope.** Port `extensions.spec.ts`. Extensions are the first feature that exercises the per-connection `createNodeExtensionLoader` plumbed in M6. Adds backend integration coverage for the extension-runner cross-tenant story.

**Files.**

| Path | Change |
|---|---|
| `packages/bodhi-pi-ws-frontend/e2e/data/extensions-redact-secrets/.bodhi-pi/extensions/redact-secrets.js` | NEW — verbatim from web |
| `packages/bodhi-pi-ws-frontend/e2e/data/extensions-redact-secrets/leak.txt` | NEW — fixture data file with a fake `sk-...` secret |
| `packages/bodhi-pi-ws-frontend/e2e/m9-extensions.spec.ts` | NEW — port from `bodhi-pi-web/e2e/extensions.spec.ts` |
| `packages/bodhi-pi-ws-server/test/extension-loader.test.ts` | NEW — integration: connect Alice with a workspace containing `.bodhi-pi/extensions/foo.js`; agent's `available_commands_update` includes the extension's commands; connecting Bob with a different workspace doesn't see Alice's extensions |

**Implementation notes.**
- `redact-secrets.js` hooks `tool_result` events. Verify the bodhi-pi extension API surface is identical between web and node (it should be — both pass the loader's output as `extensionFactories`).
- The Node loader reads `.js`, `.mjs`, `.cjs` files (per `bodhi-pi-node/src/extensions/node-extension-loader.ts`); web uses dynamic `import()` of blob URLs. Behaviorally equivalent contracts; the spec ports unchanged.

**TDD / gate-check tests.**
- E2E: prompt that triggers `read_text_file` on `leak.txt`; the redact-secrets extension hooks the `tool_result`; assistant's response contains `[redacted]` not the actual secret.
- Backend integration: per-connection extension scope.

```bash
OPENAI_API_KEY=… npx playwright test --reporter=line m9 -w bodhi-pi-ws-frontend
npm run test -w bodhi-pi-ws-server
```

**Commit:** `feat(bodhi-pi-ws-frontend): M9 project extensions`

---

## M10 — fs-tools + workspace + events

**Scope.** Sweep three small specs that round out the catalogue. Each adds at most one fixture scenario.

**Files.**

| Path | Change |
|---|---|
| `packages/bodhi-pi-ws-frontend/e2e/data/fs-tools-{notes-edit,notes-ls,docs-find}/...` | NEW — fixtures verbatim from web |
| `packages/bodhi-pi-ws-frontend/e2e/data/workspace-readme/.bodhi-pi/readme.txt` | NEW |
| `packages/bodhi-pi-ws-frontend/e2e/data/events-notes-txt/notes.txt` | NEW |
| `packages/bodhi-pi-ws-frontend/e2e/m10-fs-tools.spec.ts` | NEW — port from `bodhi-pi-web/e2e/fs-tools.spec.ts`; covers write+read, edit, ls, find subtests |
| `packages/bodhi-pi-ws-frontend/e2e/m10-workspace.spec.ts` | NEW — port; assert workspace-bootstrap + read seeded file |
| `packages/bodhi-pi-ws-frontend/e2e/m10-events.spec.ts` | NEW — port; uses `test.use({ recordEvents: true })` (or equivalent — in ws-frontend the recording mechanism may need ws-server-side instrumentation; see Risks) |

**Implementation notes.**
- web's events.spec.ts relies on `window.__bodhiPiWebRecordEvents = true` to make the worker stream all 19 lifecycle events into a tap that the test reads. ws-frontend has no equivalent. Either: (a) ws-server gains a debug `events?: true` config that streams events as `_bodhi-pi/event` extNotifications, or (b) defer events.spec.ts to a follow-up plan. **Bias toward (b)** unless cheap.

**TDD / gate-check tests.**
- E2E suites for fs-tools, workspace; events conditional on the instrumentation decision.

```bash
OPENAI_API_KEY=… npx playwright test --reporter=line m10 -w bodhi-pi-ws-frontend
```

**Commit:** `feat(bodhi-pi-ws-frontend): M10 fs-tools, workspace, events`

---

## Final acceptance gate

After M10:

```bash
npm run test -w bodhi-pi-ws-server
OPENAI_API_KEY=… npx playwright test --reporter=line -w bodhi-pi-ws-frontend
npm run check
```

Manual smoke: open the frontend, leave Server URL at default. Run `cd packages/bodhi-pi-ws-server && tsx src/index.ts --workspace ./e2e/examples` (a checked-in demo workspace with one of each fixture type) and try slash commands `/echo hello`, `/skill:say-hello`, `/help` — all should work end-to-end.

## Risks and future work

- **`createNodeScriptExecutor` runs arbitrary user-supplied scripts.** M1's note holds: this is unsafe in a real multi-tenant deploy. The `--workspace` flag pins per-process scope to a known dir, but a malicious skill can still escape via `child_process`. Note in CLAUDE.md.
- **Extension loader runs `import()` on user JS.** Same shape as scripts — code execution from the user's workspace. Acceptable for PoC; document.
- **events.spec.ts may not port cleanly.** Without the worker-side `__bodhiPiWebRecordEvents` channel, ws-frontend would need server-side event instrumentation. Defer to a follow-up if costly.
- **Spawning ws-server per test costs ~500ms–1s startup.** With ~10 specs and each maybe 3–5 tests, that's 30–60s overhead. Tolerable; revisit if it becomes painful.
- **Removing buttons may break ad-hoc demos.** The session sidebar is now read-only; users must learn slash commands. Document in README.
- **Slash-command parity with cli/web is "best effort".** Each host has subtle differences (cli's `/quit`, web's `/mount`). Document the deltas in `bodhi-pi-ws-frontend/CLAUDE.md`.
