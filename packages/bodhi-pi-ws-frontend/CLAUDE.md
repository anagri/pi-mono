# bodhi-pi-ws-frontend

Reference browser client for `@bodhiapp/bodhi-pi-ws-server`. Vite + React + TypeScript app — thin ACP client, no agent logic. Connects to a `ws-server` over `Sec-WebSocket-Protocol: bodhi-pi.v1, bearer.<base64url-json>`, drives the agent through `ClientSideConnection`, renders streaming chat + tool cards + lifecycle/wire observability.

**Parity counterparts:** `packages/bodhi-pi-web` (browser-only single-tenant host with the same feature surface) and `packages/bodhi-pi-ws-server` (the backend this client talks to). Every user-visible feature must land in all three hosts — see `packages/bodhi-pi/CLAUDE.md` for the rule.

`README.md` covers user-facing setup.

All the bodhi-pi-* runtimes, including this are Proof of Concepts, so there is no production deployment of these PoCs, there is no backwards compatability requirement, no data migration requirment, makes development of bodhi-pi quicker with these PoCs checking it works in all runtimes.

## Architecture pillars

**No agent in the browser.** `bodhi-pi`, `@bodhiapp/bodhi-pi-node`, `better-sqlite3` etc. live on the server. This package owns the WS handshake, the React UI, and the ACP `Client` handlers (permission auto-approve, session-update routing, lifecycle/wire capture). `bodhi-pi-web` runs the agent in a Web Worker; this app runs it on a remote Node process — same UI surface, different transport.

**Auth at WS upgrade.** `connect()` sends `[bodhi-pi.v1, bearer.<base64url(JSON({id, email}))>]` as subprotocols. Settings panel persists `{email, id, sendToken, serverUrl}` in localStorage; tests override per-test for tenant isolation.

**Auto-resume scoped by `(serverUrl, userId)`.** `lib/last-session.ts` writes `lastSessionId` keyed on the pair. On reconnect, App.tsx tries `loadSession(last)` and falls back to a fresh start if the server doesn't recognize it (e.g., different tenant, deleted session).

**EventsPanel is the canonical observability surface.** Two tabs:

- **lifecycle** — every `BodhiPiEvent` the server-side agent emits, forwarded to this client via ACP `extNotification("_bodhi-pi/lifecycle/event", record)` and pushed into `useEventStore`.
- **wire** — every ACP frame crossing the WebSocket in either direction, captured by the byte-level frame tap in `lib/ws-stream.ts` and published to `EventLog`.

Specs read the panel via `[data-testid="event-row"]` locators with `data-event-source`, `data-event-type`, `data-event-direction`, `data-event-method`, `data-rpc-id`, etc. Zero `page.evaluate` / `window.*` access.

**Test-host UI affordances.** This package is a test host, not production: `data-testid` attributes blanket every interactive element; `data-test-state` on the chat-root container exposes lifecycle state to blackbox specs; the EventsPanel mounts unconditionally when connected. Add new attributes liberally if they make a future spec robust.

## Feature surface (the parity contract)

Each row mirrors `bodhi-pi-web/CLAUDE.md`'s feature list — same user-observable behavior, transported over WebSocket instead of `MessagePort`.

- **Streaming chat round-trip.** Composer → `conn.prompt` → `agent_message_chunk` notifications → message rendered via `useChat`. Status flips `idle → streaming → idle`.
- **Tool-call cards.** `[data-testid=tool-call][data-tool-name][data-tool-status=running|completed|failed]`, optional `[data-testid=tool-call-preview]` (first ~400 chars).
- **Cancellation.** Composer `Send` morphs to `Stop` while `chat.status === "streaming"`; click calls `conn.cancel({sessionId})`; status returns to `idle`.
- **Slash commands.** `/help`, `/model`, `/sessions`, `/new`, `/resume <id>`, `/close`, `/delete <id>` (`src/ui/commands.ts`); project commands and skills flow through to `conn.prompt`.
- **Project commands + skills + scripted skills.** Server-side discovery from `<cwd>/.bodhi-pi/{commands,skills}/`; `run_script` is registered server-side (per-user cwd as the only isolation boundary).
- **Extensions.** Server-side auto-load from `<cwd>/.bodhi-pi/extensions/*.{js,mjs,cjs}` per WS connection.
- **Cross-provider.** OpenAI + Anthropic in one session when both keys are configured server-side.
- **Session lifecycle.** Auto-resume the last session on reconnect (scoped by `(serverUrl, userId)`); replay history on `/resume`; tool-call cards re-render as completed; failed tools surface as `data-tool-status=failed`.
- **Multi-tenancy.** Each `(id, email)` pair is an isolated tenant on the server. Tests use this for parallel-worker isolation — see `e2e/fixtures.ts`.
- **Observability via EventsPanel.** Tabs `lifecycle` + `wire`, attribute-encoded rows for blackbox specs.
- **Chat-state attribute.** `[data-testid=chat-page][data-test-state=connecting|connected|disconnected|unauthorized|idle|streaming|closed|error]` on the chat-root container.

## Key files

| Path | Role |
|---|---|
| `src/main.tsx` | React root |
| `src/App.tsx` | Settings → connect → ChatPage; auto-resume on connect; mounts `<EventsPanel>` |
| `src/lib/auth.ts` | `encodeToken({id, email})` → base64url(JSON) for the bearer subprotocol |
| `src/lib/transport.ts` | `connect()` opens the WS, wires `WireClient` (`sessionUpdate`, `extNotification`, permission auto-approve), returns `{ws, conn, eventLog}` |
| `src/lib/ws-stream.ts` | Byte-level frame tap + `wsToStream(ws, onFrame)` |
| `src/lib/event-log.ts` | Wire-frame log (raw ACP frames, FIFO 500) |
| `src/lib/last-session.ts` | Last-session persistence keyed by `(serverUrl, userId)` |
| `src/lib/render.ts` | `extractContentText` for tool-call previews |
| `src/store/eventStore.ts` | Lifecycle event store (parallel to wire `EventLog`); FIFO 500 |
| `src/hooks/useChat.ts` | Drives prompt/cancel/loadSession; routes `sessionUpdate` notifications into chat items |
| `src/hooks/useSessions.ts` | Sessions sidebar source |
| `src/hooks/useSettings.ts` | localStorage-backed settings (`{email, id, sendToken, serverUrl}`) |
| `src/hooks/useEventLog.ts` | Subscribes to wire-frame log |
| `src/components/EventsPanel.tsx` | Tabbed lifecycle + wire panel; `[data-testid=events-panel][data-active-tab]` |
| `src/ui/commands.ts` | Slash-command dispatcher |
| `e2e/fixtures.ts` | Per-test ws-server spawn + per-test `(id, email)` derivation |
| `e2e/helpers/spawn-server.ts` | Spawns a fresh ws-server child on `--port 0` per test |
| `e2e/helpers/seed.ts` | Materializes `e2e/data/<scenario>/` into the spawned workspace |
| `e2e/pages/AppPage.ts` | Page object — settings, connect, send, expectations |

## Source code rules

- **No agent imports.** Do not import `@bodhiapp/bodhi-pi`, `@bodhiapp/bodhi-pi-node`, or `better-sqlite3`. The agent runs server-side; this package is the wire client only.
- **All ACP non-spec extensions go through `extMethod` / `extNotification`.** Custom session-update kinds are not allowed (the SDK schema is closed). Use `_bodhi-pi/<area>/<verb>` per the bodhi-pi convention.
- **No `page.evaluate` / `window.*` reads in specs.** Every observable signal flows through DOM `data-*` attributes.
- **Tests must own per-test `(id, email)` derivation.** Tenant collisions across parallel workers cause cross-talk in the multi-tenant SQLite store. Use the fixture-provided defaults; explicit overrides only when the spec is testing tenancy itself.
- **Vite dev port is `35273 --strictPort`.** Workers can share one Vite instance because no per-test browser state lives there — each test points at its own ws-server (`spawnTestServer`).

## Test conventions

- **One Playwright spec per feature**, tagged with the milestone the feature shipped in (`m1-…`, `m11-…`, `m12-…`).
- **Page Object via `e2e/pages/AppPage.ts`**; locators only inside the POM.
- **Per-test backend** via `spawnTestServer` (port 0, fresh tmpdir, fresh SQLite, materialized scenario files). The frontend dev server is shared across workers.
- **Per-test tenant identity** derived from `testInfo.titlePath` so parallel workers cannot collide on `userId`/email.
- **Real LLM** for chat round-trips (the suite seeds `OPENAI_API_KEY` so the runtime resolves to OpenAI's cheap default; bodhi-pi core no longer hardcodes `gpt-4o-mini`. Anthropic-gated specs cover cross-provider parity). Faux providers stay in `bodhi-pi-ws-server/test/`.
- **Auto-retrying matchers only** (`toHaveAttribute`, `toContainText`, `toHaveCount`). The send → render path is async; one-shot snapshots race React commits.
