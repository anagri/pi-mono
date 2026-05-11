# bodhi-pi-http — feature parity with ws reference host

## Context

The PoC (committed in `11cf2d68`) brought up the HTTP+SSE host's transport, multi-tenant SQLite, per-turn agent rebuild, and basic chat UI. **51 unit/integration tests + 2 real-LLM e2e tests pass.** The deployment thesis (state lives in storage between turns) is mechanically verified.

What's missing is **functional parity** with `bodhi-pi-ws-server` + `bodhi-pi-ws-frontend`. The WS host has accumulated a rich feature surface (slash commands, model switch, EventsPanel observability, auto-resume, scripted skills, extensions, project commands, tool-call cards) and a Playwright e2e suite that proves them. The bodhi-pi parity rule (now updated to 4 reference hosts) means every user-visible feature in bodhi-pi must work in `bodhi-pi-http` too — and every UI affordance + e2e spec that ws-frontend uses to prove it should have an HTTP equivalent.

This plan ports those features iteratively, with each milestone landing one feature + one (or a few) tests, all green at every step. UI is rewritten (not patched) to match ws-frontend's testability conventions: every interaction goes through the composer (slash commands, model switch, session management); a side EventsPanel exposes lifecycle and wire frames as `data-*`-attributed rows; a composite `data-test-state` on the chat-root drives blackbox e2e.

The user explicitly called out one **HTTP-specific** scenario to add: a session can be `/close`d and `/resume`d, and the next prompt continues the same conversation across those independent HTTP requests.

## Architecture decisions (locked-in by grilling)

1. **Same-origin frontend serving.** Each test spawns one `bodhi-pi-http` process on port 0 with `--workspace <tmpdir>`. The process serves both `/acp` and the pre-built frontend at `dist/public/`. Playwright loads `http://localhost:<port>/`. **No CORS, no `serverUrl` field in Settings.** Frontend is built once globally before the test run (Playwright `globalSetup` calls `vite build`).

2. **Settings panel** = `id` + `email` + `sendToken` (no `serverUrl` because same-origin). `sendToken: false` is the test path for the unauthorized state.

3. **Wire tab = per JSON-RPC frame.** Each row is one frame (request, response, or notification), not one HTTP call. The `acp-http-client` taps every outbound and inbound frame and pushes it to an `EventLog`. Same `data-*` attribute taxonomy as ws-frontend so tests query identically: `data-event-source`, `data-event-direction`, `data-event-method`, `data-event-kind`, `data-rpc-id`, `data-ts`.

4. **Lifecycle event forwarding** uses the same ACP extension method `_bodhi-pi/lifecycle/event` that ws-server uses. The HTTP server's `wireAgentForRequest` registers `eventForwardingHandlers` (mirrored from `bodhi-pi-ws-server/src/agent/wire-agent.ts:23-86`). Events fire during `session/prompt` (and `session/load`); they reach the client as SSE frames carrying `extNotification`. Outside an SSE method (e.g., during a JSON method like `session/new`), there's no return channel — and bodhi-pi doesn't currently emit lifecycle events from those methods anyway, so the gap is a non-issue.

5. **Auto-resume** uses `(origin, userId)` as the localStorage key — same shape as ws's `(serverUrl, userId)`, but with `window.location.origin` substituting `serverUrl`.

6. **Scope: full parity in iterative milestones.** Each milestone is small enough to keep tests green at every checkpoint. We don't write more code than the next test demands.

## Gap-by-gap milestones (iterative)

### Backend parity

#### M9 — Lifecycle event forwarding via SSE
- Mirror `bodhi-pi-ws-server/src/agent/wire-agent.ts:23-86` (`recordFor`, `eventForwardingHandlers`, `LifecycleEventRecord`, `LIFECYCLE_EVENT_METHOD`).
- In `wire-agent.ts`, accept the `conn` for closing over and pass `eventHandlers: eventForwardingHandlers(conn)` to `createBodhiPiAgent`.
- Test: `test/integration/lifecycle-events.test.ts` — issue a faux prompt, assert SSE notifications include `_bodhi-pi/lifecycle/event` frames with at least `agent_start`, `turn_start`, `agent_end` (matching `bodhi-pi/e2e/events.e2e.ts` shape).

#### M10 — Add `session/close` + `session/setSessionConfigOption` to handler
- Extend `dispatchJsonMethod` in `src/server/acp/handler.ts` to dispatch:
  - `session/close` → `agent.closeSession(params)` (returns `{}`).
  - `session/setSessionConfigOption` → `agent.setSessionConfigOption(params)` (returns `{configOptions: [...]}`).
- Tests:
  - `test/integration/session-close.test.ts` — create → close → list still shows the session (close is in-memory only, ACP semantics).
  - `test/integration/model-switch.test.ts` — register two faux models; switch via `setSessionConfigOption({configId:"model", value})`; assert the response and that subsequent prompts see the new model in faux `Context`.

### Frontend rewrite (composer-driven, parity testids)

> The current `App.tsx` is rewritten — not patched — to match ws-frontend's structure. Each milestone replaces a slice while keeping all existing tests green by preserving wire behaviors.

#### M11 — Settings panel + composite `data-test-state`
- `src/frontend/components/Settings.tsx` — `id`, `email`, `sendToken` form persisted via `useSettings` hook.
- `src/frontend/hooks/useSettings.ts` — localStorage-backed (`bodhi-pi-http.settings`).
- Top-level state machine: `idle | connecting | connected | unauthorized | disconnected | error` plus chat status `streaming | closed`. Composite `data-test-state` follows ws-frontend's rule (`App.tsx:104-108`).
- Connect path: with `sendToken=true` use the encoded token; with `sendToken=false` send `Authorization` header with empty token → server returns 401 → state becomes `unauthorized`.
- `data-testid` set: `chat-page`, `settings-id`, `settings-email`, `settings-sendToken`, `connect`, `disconnect`, `status`, with status reflecting `data-status`, `data-chat-status`, `data-current-model`, `data-session-id`.
- No new automated tests this milestone; covered by M19 e2e port. Keep all existing 51 tests green.

#### M12 — System messages + base slash commands (`/help`, `/sessions`, `/new`, `/close`, `/delete`)
- `src/frontend/ui/commands.ts` — port `handleCommand(line, ctx)` from ws-frontend `src/ui/commands.ts:19-210`. Dispatcher returns `boolean` (handled-locally vs forward-to-agent).
- System messages render as `[data-testid="system-message"]`.
- Wire `/help`, `/sessions` (calls `client.listSessions`), `/new` (close-then-new flow), `/close`, `/delete <id>`.
- Compose action emits `system-message` with command output (e.g., session list).

#### M13 — `/model` + `/resume` slash commands
- `/model [id]` → calls `client.setSessionConfigOption({sessionId, configId:"model", value:id})`. With no arg, prints current and available. Updates `currentModelId` in chat state → `data-current-model` attribute reflects.
- `/resume <id>` → calls `client.loadSession({sessionId, cwd, mcpServers:[]})`; uses existing SSE history-replay path. System message confirms.
- Status bar component (`src/frontend/components/StatusBar.tsx`) renders `data-status`, `data-chat-status`, `data-current-model`, `data-session-id`.

#### M14 — EventsPanel: lifecycle tab
- `src/frontend/components/EventsPanel.tsx` with two-tab UI; lifecycle tab only this milestone.
- `src/frontend/hooks/useLifecycleLog.ts` — subscribes to `acp-http-client.onLifecycleEvent`. Add a hook on the client.
- `src/frontend/lib/acp-http-client.ts` — extend SSE consumption: when a frame's `method === "_bodhi-pi/lifecycle/event"`, dispatch to lifecycle handlers (in addition to existing `session/update`).
- Each row: `[data-testid=event-row][data-event-source=lifecycle][data-event-type][data-session-id][data-tool-name][data-user-prompt][data-stop-reason][data-from-model-id][data-to-model-id]`. Mirror ws-frontend's row markup (`EventsPanel.tsx:46-127`).
- FIFO 500 max.

#### M15 — EventsPanel: wire tab + frame tap
- Add `src/frontend/lib/event-log.ts` (FIFO 500). Each entry: `{direction, kind, method?, rpcId?, ts, raw}`.
- In `acp-http-client.ts`, tap **every** outbound frame (the JSON-RPC body of every `fetch`) and **every** inbound frame (each SSE event JSON, plus the JSON response for non-SSE methods). Push to event log.
- `src/frontend/hooks/useEventLog.ts` subscribes.
- Wire tab in `EventsPanel`. Each row: `[data-testid=event-row][data-event-source=wire][data-event-direction=in|out][data-event-method][data-event-kind=request|response|notification|error|unknown][data-rpc-id][data-ts]`.

#### M16 — Tool-call cards at parity
- Update `useChat.applyUpdate` to emit tool-call items with attributes `data-testid=tool-call`, `data-tool-name`, `data-tool-status`, `data-tool-call-id`. Optional preview `data-testid=tool-call-preview` first ~400 chars.
- Match ws-frontend's marker rendering (`App.tsx:268-342`). Includes failed status mapping.

#### M17 — Auto-resume on page load + last-session storage
- `src/frontend/lib/last-session.ts` — port from ws-frontend `src/lib/last-session.ts` with key `bodhi-pi-http:lastSession:<origin>:<userId>`.
- On mount of SignedIn (post-Connect), if storage has `lastSessionId` for `(origin, userId)`, attempt `loadSession`. On 404/cross-tenant error, clear key and start fresh; emit a system message either way.
- After `/new` or successful create, persist new sessionId. After `/delete` of current, clear.

### Test infrastructure (Playwright)

#### M18 — Playwright harness for bodhi-pi-http
- `e2e/playwright/fixtures.ts` — fixtures `tenant` (FNV-hash from `testInfo.titlePath`, mirroring ws `e2e/fixtures.ts:20-29`), `testServer` (spawns child via `npx tsx src/server/index.ts --port 0 --workspace <tmpdir> --data-dir <tmpdir>`), `app` (Page Object).
- `e2e/playwright/helpers/spawn-server.ts` — model after `bodhi-pi-ws-frontend/e2e/helpers/spawn-server.ts:37-104`. Adapt port-from-stdout regex to bodhi-pi-http's `listening on http://localhost:(\d+)` log.
- `e2e/playwright/helpers/seed.ts` — port `loadScenario` + `writeFiles` from ws's `e2e/helpers/seed.ts:5-47`.
- `e2e/playwright/pages/AppPage.ts` — Page Object mirroring ws's `AppPage.ts:26-138`. Methods: `goto`, `setSettings`, `clickConnect`, `expectStatus`, `send`, `expectChatStatus`, `expectChatState`, `lastMessageText`, `toolCalls`, `sessionRows`, `selectEventTab`, `lifecycleRows`, `wireRows`. Locators only inside the POM.
- `playwright.config.ts` global setup builds the frontend once (`vite build`) so each spawned server can serve `dist/public/`. Reporter+retries match ws-frontend.
- `e2e/playwright/data/` — directory for scenario fixtures (initially empty; populated as specs need them).

#### M19 — Port specs in waves (each wave is one milestone)

##### M19a — `auth.spec.ts` (replaces ws's m1-handshake)
- `sendToken=false` → 401 → state `unauthorized`.
- `sendToken=true` with empty id → blocked at form validation.
- Valid token → state `connected`.

##### M19b — `chat.spec.ts` (port from m2-prompt)
- Real-LLM gpt-4o-mini single-turn prompt; assert `lastMessageText("assistant")` non-empty; status returns to `idle`.

##### M19c — `sessions.spec.ts` (port from m5-sessions)
- `/new` → session row appears in `sessionRows()`; status bar shows `data-session-id`.
- `/sessions` system-message lists current.
- `/resume <id>` → history replays.

##### M19d — `cancel.spec.ts` (port from m12-cancel)
- Send a long prompt; click composer-stop; status returns to idle; `data-test-state=idle`.

##### M19e — `tool-call.spec.ts` (m4) + `tool-failure.spec.ts` (m12) + `tool-replay.spec.ts` (m12)
- Use scenarios that trigger tool calls (e.g., write/read files). Assert tool-call card attributes; failed-tool path; replay-on-resume re-renders cards as completed.

##### M19f — `model-switch.spec.ts` + `model-persists.spec.ts` + `cross-provider.spec.ts`
- `/model` lists; `/model <id>` switches; status bar reflects; persisted across `/resume`. Cross-provider exercises Anthropic + OpenAI in same session (gated on `ANTHROPIC_API_KEY` like ws's spec).

##### M19g — `commands.spec.ts` (port from m7-commands)
- Scenario `commands-say-tuesday`, `commands-echo`. Send `/say-tuesday`, `/echo banana`. Assert agent output.

##### M19h — `skills.spec.ts` + `scripted-skill.spec.ts` (port from m8)
- Scenario `skills-say-hello`. Send `/skill:say-hello alice`. Assert "hello, alice" reply. Scripted skill scenario `days-since-birthday` uses `run_script`; `ScriptExecutor` is registered server-side (already true in `wire-agent.ts`).

##### M19i — `fs-tools.spec.ts` + `workspace.spec.ts` (port from m10)
- Real-LLM exercises `read`, `edit`, `ls`, `find`, `grep` tools against fixtures mounted via `--workspace`. Workspace spec asserts that two tests in parallel see independent dirs.

##### M19j — `extensions.spec.ts` (port from ws's extension scenario)
- Scenario `extensions-redact-secrets` (already in monorepo as a fixture). Send a prompt that reads the secret file; assert tool output shows `[REDACTED]`, plaintext absent.

##### M19k — `events.spec.ts` (port from m11-event-stream)
- Send a prompt; switch to lifecycle tab; assert at least `agent_start`, `turn_start`, `agent_end` rows. Switch to wire tab; assert `session/prompt` request, ≥1 `session/update` notification, and the matching `session/prompt` response with same `data-rpc-id`.

##### M19l — `auto-resume.spec.ts` (port from m11-auto-resume)
- Connect, create session, send a prompt, `page.reload()`. After reconnect, assert chat replays last session (system message + recovered messages). Cross-tenant variant: change `id` in settings, reload — should NOT see the previous session.

#### M20 — HTTP-specific: `close-resume.spec.ts`
- The user-requested proof: `/close` then `/resume <id>`, then a prompt that depends on prior context. Real-LLM gpt-4o-mini, "remember the magic word" → `/close` → `/resume` → "what was it" → assert recall. Mirrors `e2e/chat.e2e.ts`'s second test but exercised through the UI path.

## Critical files

### To create
- `packages/bodhi-pi-http/src/frontend/components/Settings.tsx`
- `packages/bodhi-pi-http/src/frontend/components/EventsPanel.tsx`
- `packages/bodhi-pi-http/src/frontend/components/StatusBar.tsx`
- `packages/bodhi-pi-http/src/frontend/components/SystemMessage.tsx`
- `packages/bodhi-pi-http/src/frontend/hooks/useSettings.ts`
- `packages/bodhi-pi-http/src/frontend/hooks/useLifecycleLog.ts`
- `packages/bodhi-pi-http/src/frontend/hooks/useEventLog.ts`
- `packages/bodhi-pi-http/src/frontend/hooks/useSessions.ts`
- `packages/bodhi-pi-http/src/frontend/lib/event-log.ts`
- `packages/bodhi-pi-http/src/frontend/lib/lifecycle-log.ts`
- `packages/bodhi-pi-http/src/frontend/lib/last-session.ts`
- `packages/bodhi-pi-http/src/frontend/ui/commands.ts`
- `packages/bodhi-pi-http/test/integration/lifecycle-events.test.ts`
- `packages/bodhi-pi-http/test/integration/session-close.test.ts`
- `packages/bodhi-pi-http/test/integration/model-switch.test.ts`
- `packages/bodhi-pi-http/e2e/playwright/fixtures.ts`
- `packages/bodhi-pi-http/e2e/playwright/helpers/spawn-server.ts`
- `packages/bodhi-pi-http/e2e/playwright/helpers/seed.ts`
- `packages/bodhi-pi-http/e2e/playwright/pages/AppPage.ts`
- `packages/bodhi-pi-http/e2e/playwright/auth.spec.ts` (and 11 more spec files per M19)
- `packages/bodhi-pi-http/e2e/playwright/data/<scenario>/` directories

### To modify
- `packages/bodhi-pi-http/src/server/agent/wire-agent.ts` — wire `eventForwardingHandlers(conn)` (M9).
- `packages/bodhi-pi-http/src/server/acp/handler.ts` — add `session/close` and `session/setSessionConfigOption` cases (M10).
- `packages/bodhi-pi-http/src/server/acp/http-acp-conn.ts` — confirm `extNotification` reaches the SSE writer; lifecycle events arrive via this path (M9 verification).
- `packages/bodhi-pi-http/src/frontend/App.tsx` — rewritten across M11–M17.
- `packages/bodhi-pi-http/src/frontend/lib/acp-http-client.ts` — add lifecycle dispatch (M14), wire frame tap (M15), tool-call notification surface (M16).
- `packages/bodhi-pi-http/src/frontend/components/Chat.tsx` — replace inline tool rendering with parity-shaped tool cards (M16).
- `packages/bodhi-pi-http/src/frontend/hooks/useChat.ts` — add tool-call mapping with full attribute set (M16); accept system messages (M12).
- `packages/bodhi-pi-http/playwright.config.ts` — add `globalSetup` that builds the frontend (M18).
- `packages/bodhi-pi-http/CLAUDE.md` — update feature inventory (per-milestone, ending state in M20).
- `packages/bodhi-pi/CLAUDE.md` — already updated to 4-host parity rule. M20 may add a feature row to the http-specific inventory.

### Reusable references (do not duplicate naively; port the patterns)
- `bodhi-pi-ws-server/src/agent/wire-agent.ts:23-86` — `recordFor` + `eventForwardingHandlers` (M9 source of truth).
- `bodhi-pi-ws-frontend/src/ui/commands.ts:19-210` — slash command dispatcher (M12, M13 source of truth).
- `bodhi-pi-ws-frontend/src/components/EventsPanel.tsx:46-127` — row markup + tab control (M14, M15).
- `bodhi-pi-ws-frontend/src/lib/last-session.ts` — auto-resume key shape (M17).
- `bodhi-pi-ws-frontend/src/hooks/{useChat,useSessions,useSettings,useEventLog,useLifecycleLog}.ts` — hook contracts (M11–M17).
- `bodhi-pi-ws-frontend/e2e/{fixtures.ts, helpers/spawn-server.ts, helpers/seed.ts, pages/AppPage.ts}` — Playwright harness pattern (M18).
- `bodhi-pi-ws-frontend/e2e/data/` — scenario fixtures; many can be reused verbatim by symlinking or copying into our `e2e/playwright/data/`.
- `bodhi-pi/e2e/{commands,events,extensions,fs,scripted-skill}.e2e.ts` — feature contract truth (the spec-port targets).

## Verification

At every milestone:
- `npm run test` (under `packages/bodhi-pi-http`) → all unit + integration tests green (currently 51; will grow with M9, M10, etc.).
- `npm run test:e2e` → existing 2 real-LLM backend tests + new HTTP-specific tests still pass.
- `npx tsgo --noEmit -p tsconfig.server.json && npx tsgo --noEmit -p tsconfig.frontend.json` clean.
- `npm run check` (monorepo root) clean — biome + all tsgo.

After M18:
- `npx playwright install` (one-time browser install).
- `npm run test:playwright` runs the new Playwright suite (initially empty; populated wave-by-wave in M19).

After full M19+M20:
- The HTTP host's Playwright suite covers the same feature surface as ws-frontend's Playwright suite, plus the close/resume HTTP-specific scenario. Any future feature added to bodhi-pi must land here too — that's the parity rule.

## Out of scope (still)

- Multi-node / clustering / sticky sessions
- In-flight turn resumption across reconnects (`Last-Event-ID` style)
- ACP `fs/read_text_file` / `fs/write_text_file` and `session/request_permission` (bodhi-pi doesn't use these)
- WebSocket-style heartbeat (HTTP doesn't need it; SSE keep-alive can be added if a real proxy gripes)
- Real auth (signed JWT, login endpoint, cookies)
- Server-restart-mid-session continuity as e2e proof (per-request rebuild already implies it works)
